-- 0084 Controlled reversal of an approved payroll input (FR-031; DF03 "Approved changes need a controlled
-- reversal/cancellation action"; H2 "collect approved eligible input revisions"; C4).
--
-- A batch line approved in error would otherwise be paid by the next calculation, and would block its employee again
-- in every later revision when the calculation refuses it. A reversal closes approved lines of a batch (one, several or
-- all) with a reason, decided by someone independent of the batch's preparer and of the employee concerned. The batch
-- stays APPROVED (its decision stands as history; DF03 "financial approved entitlements cannot be edited") and a
-- reversed line keeps every value it had: it stops feeding calculations and frees its reference, so a corrected line
-- may be entered through the normal entry and approval.
--
-- Never reversed: a line a processed run consumed (corrections of processed pay are later linked adjustments), or a
-- line held by the snapshot of a live run revision (that revision is returned to a new draft first, H2, so a snapshot
-- never holds an input that is no longer approved).

alter table payroll_input drop constraint payroll_input_state_check;
alter table payroll_input add constraint payroll_input_state_check
  check (state in ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'REVERSED'));

alter table payroll_input
  add column reversed_at     timestamptz,
  add column reversed_by     uuid references user_account (id) on delete restrict,
  add column reversal_reason text check (reversal_reason is null or (btrim(reversal_reason) <> '' and length(reversal_reason) <= 1000));

alter table payroll_input add constraint payroll_input_reversal_recorded
  check ((state = 'REVERSED') = (reversed_at is not null)
         and (reversed_at is null) = (reversed_by is null)
         and (reversed_at is null) = (reversal_reason is null));

create or replace function hrms_payroll_input_guard() returns trigger language plpgsql as $$
declare
  b payroll_input_batch%rowtype;
  p payroll_period%rowtype;
begin
  select * into b from payroll_input_batch where company_id = new.company_id and id = new.batch_id;
  if tg_op = 'INSERT' then
    if b.state is distinct from 'DRAFT' or new.state <> 'DRAFT' then
      raise exception 'payroll inputs are added to a draft batch only' using errcode = '23514';
    end if;
    select * into p from payroll_period where company_id = new.company_id and id = new.period_id;
    if new.effective_date not between p.service_start and p.service_end then
      raise exception 'a payroll input belongs to a date of its service period' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.batch_id, new.period_id, new.employee_id, new.component_id, new.input_kind_id, new.amount, new.currency_code, new.effective_date,
      new.source, new.reference)
     is distinct from
     (old.batch_id, old.period_id, old.employee_id, old.component_id, old.input_kind_id, old.amount, old.currency_code, old.effective_date,
      old.source, old.reference) then
    raise exception 'a payroll input is immutable; cancel its batch and enter a new one' using errcode = '23514';
  end if;
  if old.state = 'REVERSED' and (new.state, new.reversed_at, new.reversed_by, new.reversal_reason)
     is distinct from (old.state, old.reversed_at, old.reversed_by, old.reversal_reason) then
    raise exception 'a reversal of a payroll input is final' using errcode = '23514';
  end if;
  if new.state = 'REVERSED' and old.state <> 'REVERSED' then
    if old.state <> 'APPROVED' or b.state <> 'APPROVED' then
      raise exception 'only an approved payroll input is reversed' using errcode = '23514';
    end if;
    if old.consumed_record_id is not null then
      raise exception 'a payroll input used by a processed run is never reversed' using errcode = '23514';
    end if;
    -- C4 / DF03: never the preparer of the batch or the employee concerned.
    if new.reversed_by = b.prepared_by
       or exists (select 1 from user_employee_link l where l.company_id = new.company_id and l.user_id = new.reversed_by and l.employee_id = new.employee_id) then
      raise exception 'a payroll input is reversed by someone independent of its preparer and its employee' using errcode = '23514';
    end if;
    if exists (select 1 from payroll_record_input ri
                 join payroll_record r on r.company_id = ri.company_id and r.id = ri.record_id
                 join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id
                where ri.company_id = new.company_id and ri.input_id = new.id
                  and ru.state in ('DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED', 'PROCESSED_LOCKED')) then
      raise exception 'a payroll input held by a live run revision is reversed only after that revision is returned' using errcode = '23514';
    end if;
  elsif new.state <> old.state and new.state <> b.state then
    raise exception 'a payroll input follows the state of its batch' using errcode = '23514';
  end if;
  if old.consumed_record_id is not null and new.consumed_record_id is distinct from old.consumed_record_id then
    raise exception 'a consumed payroll input stays consumed' using errcode = '23514';
  end if;
  return new;
end $$;
