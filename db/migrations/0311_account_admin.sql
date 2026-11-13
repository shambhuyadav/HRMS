-- 0311 Account administration from the User accounts screen (FR-001 "initiate the visible password-recovery journey"; the source
-- system's User Master; §5 System Administrator "user/role administration"). Requested by the owner on 13 Nov 2026: the System
-- Administrator creates, edits, deletes and resets the password of user accounts in the HRMS instead of on the server.
--
--   access.manage_accounts  create an account (its sign-in at the provider with a one-time temporary password), change its name
--                           and sign-in email, give it a new temporary password, delete an account that was never used. A
--                           ceiling and default duty of the System Administrator (modules/access/baseline.ts ACCESS_ADMIN): an
--                           account holds no permission by itself, as a link does not; what it may do still comes from
--                           assignments approved by an independent administrator.
--
-- company_user_account records the company that created an account. Until it is linked to an employee or granted a role, the
-- account belongs to that company through this row alone (the user list and the account actions look for a link, a grant or
-- this row). Deleting a never-used account deletes this row first, explicitly (modules/access/accounts.ts): no key cascades.
create table company_user_account (
  company_id  uuid not null references company (id) on delete restrict,
  user_id     uuid not null references user_account (id) on delete restrict,
  created_at  timestamptz not null default now(),
  created_by  uuid not null references user_account (id) on delete restrict,
  primary key (company_id, user_id)
);
create index company_user_account_user on company_user_account (user_id);

insert into permission (resource, action, field_group) values ('access', 'manage_accounts', 'operational')
on conflict (resource, action, field_group) do nothing;

insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join permission p on p.resource = 'access' and p.action = 'manage_accounts' and p.field_group = 'operational'
 where r.code = 'SYSTEM_ADMINISTRATOR'
on conflict (company_id, role_id, permission_id) do nothing;
