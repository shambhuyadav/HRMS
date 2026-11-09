-- 0242 Exit separation types (FR-051, FR-052, FR-055; I-88 item 8; decided under owner delegation, 6 Nov 2026, docs/03 I-89 item 7).
--
-- 0038 allowed only RESIGNATION, so the gratuity exemption for death and disablement (I-88 item 8) could not be reached and HR could
-- not record a termination or a retirement. The types below follow common Indian practice and the Payment of Gratuity Act s.4(1)
-- (superannuation, retirement or resignation, death or disablement) with termination and end of a fixed-term contract:
--   RESIGNATION      the employee's own (self-service), or HR-entered from a letter (0185). Notice per contract, recovered if short.
--   RETIREMENT       HR-entered; the last working date is the retirement date and never moves. No notice recovery.
--   TERMINATION      HR-entered with its ground (a reason code, required); the date may be recommended or approved later as for a
--                    resignation. Notice per contract is the employer's: nothing is recovered from the employee.
--   DEATH            HR-entered; the last working date is the date of death (it may be past) and never moves. No notice. The
--                    employee's own self-service is never notified or delivered to (service rules).
--   DISABLEMENT      HR-entered; the last working date is the date employment ends on the medical evidence and never moves. No notice.
--   END_OF_CONTRACT  HR-entered; the last working date is the contract's end date and never moves. No notice recovery.
-- Every HR entry carries a reference and one released, verified document of the employee (0185 origin facts). Only a resignation is
-- withdrawn. Gratuity eligibility regardless of service follows the GRATUITY pack's exempt types (DEATH, DISABLEMENT; 0235).
--
-- Existing exits are all resignations and satisfy every rule. To reverse: refuse new non-resignation entries in the service and,
-- once none exists, restore the 0038 check and drop the constraints, trigger and notification rules added here.

alter table exit_case drop constraint exit_case_separation_type_check;
alter table exit_case add constraint exit_case_separation_type_check
  check (separation_type in ('RESIGNATION', 'RETIREMENT', 'TERMINATION', 'DEATH', 'DISABLEMENT', 'END_OF_CONTRACT'));
-- The employee's own route is a resignation; every other type is HR's entry.
alter table exit_case add constraint exit_case_type_origin check (separation_type = 'RESIGNATION' or request_origin = 'HR');
-- Only a resignation is withdrawn.
alter table exit_case add constraint exit_case_withdrawn_resignation check (state <> 'WITHDRAWN' or separation_type = 'RESIGNATION');
-- A termination records its ground.
alter table exit_case add constraint exit_case_termination_ground check (separation_type <> 'TERMINATION' or reason_code_id is not null);
-- The date of the event (retirement, death, disablement, contract end) is the last working date throughout.
alter table exit_case add constraint exit_case_event_date_fixed
  check (separation_type not in ('RETIREMENT', 'DEATH', 'DISABLEMENT', 'END_OF_CONTRACT') or leaving_date = proposed_leaving_date);

create function hrms_exit_withdrawal_resignation_only() returns trigger language plpgsql as $$
begin
  if (select separation_type from exit_case where company_id = new.company_id and id = new.exit_case_id) is distinct from 'RESIGNATION' then
    raise exception 'only a resignation can be withdrawn' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger exit_withdrawal_resignation_only before insert on exit_withdrawal_request for each row execute function hrms_exit_withdrawal_resignation_only();

-- DF12 notices of HR-entered separations, worded for what they are (the resignation notices say "resigned"). Reviewers are told of
-- the task; the decision is told to the employee's manager only: the employee hears of a termination, retirement or contract end
-- through HR's letter, and a deceased employee's self-service is never notified (the dispatcher refuses it whatever the event).
-- New companies get the same three from modules/lifecycle/registration.ts.
insert into notification_template (company_id, code, revision, language, channel, subject_template, body_template, approved_placeholders, active)
select c.id, t.code, 1, 'en', 'IN_APP', t.subject, t.body, t.placeholders, true
  from company c
  cross join (values
    ('SEPARATION_SUBMITTED', 'Separation waiting for your recommendation',
     '{{separationType}} of {{employeeName}} ({{employeeCode}}) was recorded with a last working date of {{lastWorkingDate}}. Please review it.',
     array['separationType', 'employeeName', 'employeeCode', 'lastWorkingDate']),
    ('SEPARATION_RECOMMENDED', 'Separation waiting for your approval',
     '{{separationType}} of {{employeeName}} ({{employeeCode}}) with a last working date of {{lastWorkingDate}} is waiting for your approval.',
     array['separationType', 'employeeName', 'employeeCode', 'lastWorkingDate']),
    ('SEPARATION_DECIDED', 'Separation of {{employeeName}}',
     '{{separationType}} of {{employeeName}} ({{employeeCode}}) was {{outcome}}.',
     array['separationType', 'employeeName', 'employeeCode', 'outcome'])
  ) as t (code, subject, body, placeholders)
on conflict (company_id, code, revision, language, channel) do nothing;

insert into notification_rule (company_id, code, revision, event_type, channel, recipient_selector, template_code, template_revision, template_id,
                               optional_event, effective_from, active)
select t.company_id, t.code, 1, t.code, 'IN_APP', case when t.code = 'SEPARATION_DECIDED' then 'SUBJECT_MANAGER' else 'ASSIGNED_REVIEWER' end,
       t.code, 1, t.id, false, now(), true
  from notification_template t
 where t.code in ('SEPARATION_SUBMITTED', 'SEPARATION_RECOMMENDED', 'SEPARATION_DECIDED') and t.revision = 1 and t.language = 'en' and t.channel = 'IN_APP'
on conflict (company_id, code, revision) do nothing;
