-- 0282 HR sends one message to chosen employees by email (BRD coverage CL-041 "Send Mail", under FR-085 channels and delivery log;
-- FR-061; DF12 "Email may be enabled ... after actual service configuration and safe recipient tests"; BR-026 row scope; BR-034;
-- BR-044; H7). Built 11 Nov 2026 from the reference system's screen (subject, message, recipients chosen on screen or from an uploaded
-- list of employee codes, an optional attachment); decided under owner delegation, 6 Nov 2026.
--
-- The message goes through the existing email channel, nothing new: one notification per recipient on the EMAIL channel, queued with its
-- content already checked, sent by the worker only (notification/email-delivery.ts) with its retries, at-most-once claim and delivery
-- attempts, and listed in the delivery log. With no SMTP settings nothing is queued (the API refuses, EMAIL_NOT_CONFIGURED) and anything
-- queued is settled SUPPRESSED by the worker as for every email. The channel sends plain text only, so a message carries no attachment.
--
-- hr_mail.send.message   a confidential group of its own (the message is HR-authored text to named people): ceiling only for the HR
--                        Administrator, granted per assignment, never a default duty.
-- hr_mail_send           one row per message sent: who, when, under which assignment, to how many, and its idempotency key with the
--                        hash of the request, so a repeated submission sends nothing twice. Append-only. The text is kept only on the
--                        recipients' notifications (what the worker sends), never in this row or the audit.
-- notification           an HR message is addressed to an employee's work email rather than to a user account: recipient_employee_id
--                        names the employee (the worker reads their work email and status when it sends, DF12 "recheck recipient at
--                        delivery"), hr_mail_send_id the message; recipient_user_id is then empty. Exactly one of the two recipients.
--
-- To reverse: refuse new messages in the service; once none is open, restore recipient_user_id not null (after settling any employee
-- rows), drop the two columns, the table, its trigger and the permission and ceilings added here.

insert into permission (resource, action, field_group) values ('hr_mail', 'send', 'message') on conflict do nothing;

create table hr_mail_send (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  sent_by               uuid not null references user_account (id) on delete restrict,
  acting_assignment_id  uuid not null,
  idempotency_key       text not null check (length(idempotency_key) between 8 and 200),
  -- SHA-256 of the subject, message and recipients as submitted: a key used again for anything else is refused.
  request_hash          text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  recipient_count       integer not null check (recipient_count between 1 and 500),
  created_at            timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, sent_by, idempotency_key),
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict
);
create index hr_mail_send_log_idx on hr_mail_send (company_id, created_at desc);
create trigger hr_mail_send_append_only before update or delete on hr_mail_send for each row execute function hrms_append_only();

alter table notification
  add column recipient_employee_id uuid,
  add column hr_mail_send_id uuid,
  add constraint notification_recipient_employee_fk foreign key (company_id, recipient_employee_id) references employee (company_id, id) on delete restrict,
  add constraint notification_hr_mail_send_fk foreign key (company_id, hr_mail_send_id) references hr_mail_send (company_id, id) on delete restrict,
  -- An employee is addressed by email only, and only by an HR message.
  add constraint notification_employee_recipient check (recipient_employee_id is null or channel = 'EMAIL'),
  add constraint notification_hr_mail_recipient check ((hr_mail_send_id is null) = (recipient_employee_id is null));
alter table notification alter column recipient_user_id drop not null;
alter table notification add constraint notification_one_recipient check ((recipient_user_id is null) <> (recipient_employee_id is null));
create index notification_recipient_employee_idx on notification (company_id, recipient_employee_id);
create index notification_hr_mail_send_idx on notification (company_id, hr_mail_send_id);

-- Ceilings of every company's HR Administrator role (new companies get it from modules/notification/hr-mail-registration.ts). A ceiling
-- grants nothing by itself: an assignment holds the group only through an independently approved grant.
insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join permission p on p.resource = 'hr_mail' and p.action = 'send' and p.field_group = 'message'
 where r.code = 'HR_ADMINISTRATOR'
on conflict (company_id, role_id, permission_id) do nothing;
