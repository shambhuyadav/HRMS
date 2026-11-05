-- 0095 Correcting an applied increment (BR-038 "later corrections use controlled attributable superseding events"; DF14
-- "Correction retains original/superseding records; report selects the approved effective chain"; FR-089 "Reversal/correction
-- is a new linked event rather than history deletion"; FR-090).
--
-- A correction is its own increment case with its own independent decision. It adds a history record linked to the one it
-- corrects; history stays append-only, so "superseded" means a record has a successor, and increment_history_in_force is the
-- approved effective chain. The arrangement the corrected record made leaves the chain but stays on record, with its
-- components: it is closed to an empty period and marked superseded, which no date in force can match. Only a marked row may
-- be empty, so an ordinary arrangement still needs an end after its start, and once marked it never changes again.

alter table salary_arrangement
  add column superseded_at timestamptz,
  drop constraint salary_arrangement_check,
  add constraint salary_arrangement_period check (effective_to > effective_from or (superseded_at is not null and effective_to = effective_from)),
  add constraint salary_arrangement_superseded_is_empty check (superseded_at is null or (effective_to is not null and effective_to = effective_from));

create or replace function hrms_salary_arrangement_frozen() returns trigger language plpgsql as $$
begin
  if (new.employee_id, new.effective_from, new.annual_ctc, new.monthly_gross, new.currency_code)
     is distinct from (old.employee_id, old.effective_from, old.annual_ctc, old.monthly_gross, old.currency_code) then
    raise exception 'salary arrangement values are immutable; create a new arrangement' using errcode = '23514';
  end if;
  if old.superseded_at is not null and (new.superseded_at, new.effective_to) is distinct from (old.superseded_at, old.effective_to) then
    raise exception 'a superseded salary arrangement stays as it was' using errcode = '23514';
  end if;
  return new;
end $$;

alter table increment_history
  add column corrects_history_id uuid,
  add constraint increment_history_employee_key unique (company_id, id, employee_id),
  add constraint increment_history_corrects_fk foreign key (company_id, corrects_history_id, employee_id) references increment_history (company_id, id, employee_id) on delete restrict,
  add constraint increment_history_corrects_other check (corrects_history_id <> id);
-- A record has at most one successor, so the chain cannot fork.
create unique index increment_history_one_successor on increment_history (company_id, corrects_history_id) where (corrects_history_id is not null);

alter table increment_case
  add column corrects_history_id uuid,
  add constraint increment_case_corrects_fk foreign key (company_id, corrects_history_id, employee_id) references increment_history (company_id, id, employee_id) on delete restrict,
  add constraint increment_case_correction_off_cycle check (corrects_history_id is null or off_cycle);
create unique index increment_case_one_open_correction on increment_case (company_id, corrects_history_id) where (corrects_history_id is not null and state = 'SUBMITTED');

create view increment_history_in_force as
  select h.* from increment_history h
   where not exists (select 1 from increment_history n where n.company_id = h.company_id and n.corrects_history_id = h.id);
