-- 0132 Role-permission maintenance (C3 Access administration "maintain_role_permissions ... No implicit grants; privileged change
-- approved and logged, no own approval"; FR-066; FR-067 "retain the proposed change, requesting actor, independent decision
-- actor, reason, decision time and resulting access"; BR-007; C1 scoped DENY; DB015; I-52).
--
-- A role's permission entry (its ceiling, or a DENY) changes only as a recorded proposal that someone independent decides. This
-- table is that record, and it is never rewritten: a decision closes the row and nothing changes it afterwards. The service
-- applies an approved change in the same transaction. The database holds who may decide:
--   * not the requester;
--   * nobody holding the role being changed (FR-067 "A recipient cannot approve their own increased access");
--   * someone holding the role-grant approval duty in company scope with no filters, as an approval of a grant is checked (0099).
--
-- LIMIT, as in 0099: role_permission itself takes direct writes (provisioning, migrations, plain SQL); this table records the path
-- the application offers and does not stop a holder of the database role writing past it.
create table role_permission_change (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references company (id) on delete restrict,
  role_id                  uuid not null,
  permission_id            uuid not null references permission (id) on delete restrict,
  change_kind              text not null check (change_kind in ('ALLOW', 'DENY', 'REMOVE')),
  effect_before            text check (effect_before in ('ALLOW', 'DENY')),
  state                    text not null default 'PROPOSED' check (state in ('PROPOSED', 'APPROVED', 'REJECTED')),
  reason                   text not null check (btrim(reason) <> '' and length(reason) <= 500),
  requested_by             uuid not null references user_account (id) on delete restrict,
  requested_assignment_id  uuid not null,
  requested_at             timestamptz not null default now(),
  decided_by               uuid references user_account (id) on delete restrict,
  decided_assignment_id    uuid,
  decided_at               timestamptz,
  decision_reason          text check (decision_reason is null or (btrim(decision_reason) <> '' and length(decision_reason) <= 500)),
  resulting_access         jsonb,
  created_at               timestamptz not null default now(),
  created_by               uuid references user_account (id) on delete restrict,
  updated_at               timestamptz not null default now(),
  updated_by               uuid references user_account (id) on delete restrict,
  version                  integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, role_id) references role (company_id, id) on delete restrict,
  foreign key (company_id, requested_assignment_id) references role_assignment (company_id, id) on delete restrict,
  foreign key (company_id, decided_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check (decided_by is null or decided_by <> requested_by),
  check ((state = 'PROPOSED') = (decided_by is null) and (state = 'PROPOSED') = (decided_at is null) and (state = 'PROPOSED') = (decided_assignment_id is null)),
  check ((state = 'APPROVED') = (resulting_access is not null)),
  check (state <> 'REJECTED' or decision_reason is not null)
);
-- One open question per role and permission at a time.
create unique index role_permission_change_one_open on role_permission_change (company_id, role_id, permission_id) where state = 'PROPOSED';
create index role_permission_change_history on role_permission_change (company_id, role_id, permission_id, decided_at desc);

create function hrms_role_permission_change_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'PROPOSED' then
      raise exception 'a role permission change starts PROPOSED' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.state <> 'PROPOSED' then
    raise exception 'a decided role permission change is final' using errcode = '23514';
  end if;
  if (new.role_id, new.permission_id, new.change_kind, new.effect_before, new.reason, new.requested_by, new.requested_assignment_id, new.requested_at)
     is distinct from (old.role_id, old.permission_id, old.change_kind, old.effect_before, old.reason, old.requested_by, old.requested_assignment_id, old.requested_at) then
    raise exception 'a role permission proposal is not edited; reject it and propose again' using errcode = '23514';
  end if;
  if new.state = 'PROPOSED' then
    return new;
  end if;
  if new.decided_at is distinct from now() then
    raise exception 'a decision is stamped with the time of the deciding transaction' using errcode = '23514';
  end if;
  if exists (select 1 from role_assignment a
              where a.company_id = new.company_id and a.role_id = new.role_id and a.user_id = new.decided_by
                and a.state in ('PENDING', 'ACTIVE') and (a.effective_to is null or a.effective_to > now())) then
    raise exception 'nobody holding a role decides a change to that role' using errcode = '23514';
  end if;
  if not exists (
    select 1
      from role_assignment a
      join user_account u on u.id = a.user_id and u.active
      join role r on r.company_id = a.company_id and r.id = a.role_id and r.active
      join permission p on p.resource = 'access' and p.action = 'approve_role_grant' and p.field_group = 'operational'
      join role_permission rp on rp.company_id = a.company_id and rp.role_id = a.role_id and rp.permission_id = p.id and rp.effect = 'ALLOW'
      join role_assignment_permission rap on rap.company_id = a.company_id and rap.role_assignment_id = a.id and rap.permission_id = p.id and rap.active
       and rap.effective_from <= now() and (rap.effective_to is null or rap.effective_to > now())
     where a.company_id = new.company_id and a.id = new.decided_assignment_id and a.user_id = new.decided_by and a.state = 'ACTIVE' and a.scope_kind = 'COMPANY'
       and a.effective_from <= now() and (a.effective_to is null or a.effective_to > now())
       and not exists (select 1 from role_scope_filter f where f.company_id = a.company_id and f.role_assignment_id = a.id)
  ) then
    raise exception 'the decider does not hold the approval duty over the whole company in the named assignment' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger role_permission_change_guard before insert or update on role_permission_change
  for each row execute function hrms_role_permission_change_guard();
create trigger role_permission_change_touch before update on role_permission_change for each row execute function hrms_touch();
create trigger role_permission_change_no_delete before delete on role_permission_change for each row execute function hrms_no_delete();
create trigger role_permission_change_no_truncate before truncate on role_permission_change for each statement execute function hrms_no_truncate();

-- The containment check held every allowlist write to the role's ALLOW, which would refuse switching an entry off once the role no
-- longer allows it, and with it revoking any grant holding that entry. Only an insert or an entry being active needs the ALLOW.
create or replace function hrms_assignment_permission_check() returns trigger language plpgsql as $$
declare
  parent role_assignment%rowtype;
  role_effect text;
begin
  select * into parent from role_assignment
   where company_id = new.company_id and id = new.role_assignment_id;

  select rp.effect into role_effect from role_permission rp
   where rp.company_id = new.company_id and rp.role_id = parent.role_id and rp.permission_id = new.permission_id;

  if role_effect is distinct from 'ALLOW' and (tg_op = 'INSERT' or new.active) then
    raise exception 'assignment permission is not allowed by the parent role' using errcode = '23514';
  end if;
  if new.effective_from < parent.effective_from then
    raise exception 'assignment permission starts before its parent assignment' using errcode = '23514';
  end if;
  if parent.effective_to is not null and (new.effective_to is null or new.effective_to > parent.effective_to) then
    raise exception 'assignment permission ends after its parent assignment' using errcode = '23514';
  end if;
  if new.active and parent.state <> 'ACTIVE' then
    raise exception 'assignment permission cannot be active before its parent assignment is approved'
      using errcode = '23514';
  end if;
  return null;
end $$;

-- DF12 "role-grant/security change", for companies that already exist (provisioning gives a new one the same).
create temporary table hrms_0132_catalogue (code text, event_type text, selector text, subject text, body text, placeholders text[]) on commit drop;
insert into hrms_0132_catalogue values
  ('ROLE_PERMISSION_CHANGE_PROPOSED', 'ROLE_PERMISSION_CHANGE_PROPOSED', 'GRANT_APPROVERS',
   'Role permission change waiting for approval',
   'A permission change to the {{roleCode}} role is waiting for your approval.',
   array['roleCode']),
  ('ROLE_PERMISSION_CHANGE_DECIDED', 'ROLE_PERMISSION_CHANGE_DECIDED', 'BENEFICIARY_USER',
   'Role permission change {{outcome}}',
   'The permission change you proposed to the {{roleCode}} role was {{outcome}}.',
   array['roleCode', 'outcome']);

insert into notification_template (company_id, code, revision, language, channel, subject_template, body_template, approved_placeholders, active)
select c.id, k.code, 1, 'en', 'IN_APP', k.subject, k.body, k.placeholders, true
  from company c cross join hrms_0132_catalogue k
on conflict (company_id, code, revision, language, channel) do nothing;

insert into notification_rule (company_id, code, revision, event_type, channel, recipient_selector, template_code, template_revision, template_id,
                               optional_event, effective_from, active)
select t.company_id, t.code, 1, k.event_type, 'IN_APP', k.selector, t.code, 1, t.id, false, now(), true
  from hrms_0132_catalogue k
  join notification_template t on t.code = k.code and t.revision = 1 and t.language = 'en' and t.channel = 'IN_APP'
on conflict (company_id, code, revision) do nothing;
