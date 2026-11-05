-- 0133 Notification rule publication needs approval (C6 Notification Administrator "publication and mandatory notification settings
-- require business owner approval"; FR-085 "An authorised rule change takes effect only from its configured date and is audited";
-- DF12; HD12). I-35 stands: a change is a new revision from a future instant, later than the latest, and one revision is in force.
--
--   notification.approve_rules   its own action, never the author's. A ceiling of the two eligible Admin roles with no default duty,
--                                so nobody holds it until a grant is approved. The BRD says "business owner" and names no role.
--   a revision after the first   starts PROPOSED: it is in nobody's way and comes into force only once PUBLISHED, by someone
--                                other than its author, before its date. The revision before it ends only then. REJECTED is final
--                                and is never in force. One open proposal per rule.
--
-- Revisions already stored stay PUBLISHED; nothing changes for them. Provisioning writes revision 1, which is the baseline itself.
insert into permission (resource, action, field_group) values ('notification', 'approve_rules', 'operational');

insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join permission p on p.resource = 'notification' and p.action = 'approve_rules' and p.field_group = 'operational'
 where r.code in ('SYSTEM_ADMINISTRATOR', 'HR_ADMINISTRATOR')
on conflict (company_id, role_id, permission_id) do nothing;

alter table notification_rule
  add column publication_state text not null default 'PUBLISHED' check (publication_state in ('PROPOSED', 'PUBLISHED', 'REJECTED')),
  add column proposal_reason text check (proposal_reason is null or length(proposal_reason) <= 500),
  add column decided_by uuid references user_account (id) on delete restrict,
  add column decided_at timestamptz,
  add column decision_reason text check (decision_reason is null or length(decision_reason) <= 500),
  add constraint notification_rule_decided_by_another check (decided_by is null or decided_by <> created_by),
  add constraint notification_rule_rejection_has_reason check (publication_state <> 'REJECTED' or decision_reason is not null);

create unique index notification_rule_one_proposal on notification_rule (company_id, code) where publication_state = 'PROPOSED';

create function hrms_notification_rule_publication_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.revision > 1 and (new.publication_state <> 'PROPOSED' or new.created_by is null) then
      raise exception 'a rule revision starts PROPOSED and names its author' using errcode = '23514';
    end if;
    if new.publication_state = 'PROPOSED' and (new.decided_by is not null or new.decided_at is not null) then
      raise exception 'a proposed rule revision has no decision' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.publication_state <> 'PROPOSED' then
    if (new.publication_state, new.decided_by, new.decided_at, new.decision_reason) is distinct from (old.publication_state, old.decided_by, old.decided_at, old.decision_reason) then
      raise exception 'a decided rule revision stays decided' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.publication_state = 'PROPOSED' then
    if new.decided_by is not null or new.decided_at is not null then
      raise exception 'a proposed rule revision has no decision' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.decided_by is null or new.decided_at is distinct from now() then
    raise exception 'a decision names its actor and is stamped with the time of the deciding transaction' using errcode = '23514';
  end if;
  if new.publication_state = 'PUBLISHED' and new.effective_from <= now() then
    raise exception 'a rule revision is published before its date' using errcode = '23514';
  end if;
  if not exists (
    select 1
      from role_assignment a
      join user_account u on u.id = a.user_id and u.active
      join role r on r.company_id = a.company_id and r.id = a.role_id and r.active
      join permission p on p.resource = 'notification' and p.action = 'approve_rules' and p.field_group = 'operational'
      join role_permission rp on rp.company_id = a.company_id and rp.role_id = a.role_id and rp.permission_id = p.id and rp.effect = 'ALLOW'
      join role_assignment_permission rap on rap.company_id = a.company_id and rap.role_assignment_id = a.id and rap.permission_id = p.id and rap.active
       and rap.effective_from <= now() and (rap.effective_to is null or rap.effective_to > now())
     where a.company_id = new.company_id and a.user_id = new.decided_by and a.state = 'ACTIVE' and a.scope_kind = 'COMPANY'
       and a.effective_from <= now() and (a.effective_to is null or a.effective_to > now())
  ) then
    raise exception 'the decider does not hold the rule approval duty' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger notification_rule_publication_guard before insert or update on notification_rule
  for each row execute function hrms_notification_rule_publication_guard();
