-- 0131 Expense payment duties C3 and C5 name that the first build folded into others (C3 Payment "read_liability, prepare,
-- release, confirm_outcome, reverse, export ... confirmation actor explicitly assigned"; C5 "payment batch DRAFT then READY",
-- "READY release", "authorised outcome actor"; DF07; I-49 stays as it is).
--
--   payment.confirm_outcome   its own action. A ceiling of the role that already holds the release duty (DF07 "eligible
--                             Admin"), no default duty. No assignment changes here (0099 froze the allowlists), so nobody
--                             holds it until a grant is approved: outcomes fail closed until then.
--   payment.export            its own action: the payable ageing and payment reconciliation outputs move to it.
--   batch DRAFT -> READY      a new batch starts DRAFT and only READY can be released. The preparer moves it (C5's actor for
--                             that row is the treasury preparer), recorded with the time. Existing batches keep their state.
--   outcome actor             named on the instruction when it is released, changed only while it waits for its outcome, and
--                             never a person the release rule excludes (hrms_payment_release_conflict, I-49). Only the named
--                             person records CONFIRMED or FAILED. An instruction released before this migration names nobody,
--                             so it needs a name before an outcome can be recorded. Reversals keep their own duty (C5).

insert into permission (resource, action, field_group) values
  ('payment', 'confirm_outcome', 'operational'),
  ('payment', 'export', 'operational');

insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join permission p on p.resource = 'payment' and p.action in ('confirm_outcome', 'export') and p.field_group = 'operational'
 where r.code = 'HR_ADMINISTRATOR'
on conflict (company_id, role_id, permission_id) do nothing;

-- C5: all state writes use the controlled catalogue. READY stops being a state a batch can start in.
insert into transaction_state (kind, state, initial, terminal) values ('payment_batch', 'DRAFT', true, false);
update transaction_state set initial = false where kind = 'payment_batch' and state = 'READY';
insert into transaction_transition (kind, from_state, to_state) values ('payment_batch', 'DRAFT', 'READY');

alter table payment_batch drop constraint payment_batch_state_check;
alter table payment_batch add constraint payment_batch_state_check check (state in ('DRAFT', 'READY', 'RELEASED', 'CLOSED'));
alter table payment_batch
  add column ready_by uuid references user_account (id) on delete restrict,
  add column ready_at timestamptz,
  add constraint payment_batch_draft_not_marked check (state <> 'DRAFT' or (ready_by is null and ready_at is null));

create or replace function hrms_payment_batch_guard() returns trigger language plpgsql as $$
begin
  if (new.transaction_id, new.prepared_by, new.currency_code) is distinct from (old.transaction_id, old.prepared_by, old.currency_code) then
    raise exception 'a payment batch''s transaction, preparer and currency never change' using errcode = '23514';
  end if;
  if old.state = 'DRAFT' and new.state <> 'DRAFT' then
    if new.ready_by is distinct from old.prepared_by or new.ready_at is distinct from now() then
      raise exception 'the preparer marks a draft payment batch READY, stamped with that transaction''s time' using errcode = '23514';
    end if;
  elsif (new.ready_by, new.ready_at) is distinct from (old.ready_by, old.ready_at) then
    raise exception 'who marked a payment batch READY, and when, never changes' using errcode = '23514';
  end if;
  return new;
end $$;

alter table payment_instruction
  add column outcome_actor_id uuid references user_account (id) on delete restrict,
  add column outcome_assigned_by uuid references user_account (id) on delete restrict,
  add column outcome_assigned_at timestamptz,
  add constraint payment_instruction_outcome_assignment_whole
    check ((outcome_actor_id is null) = (outcome_assigned_by is null) and (outcome_actor_id is null) = (outcome_assigned_at is null));

create or replace function hrms_payment_instruction_guard() returns trigger language plpgsql as $$
declare
  batch_state text;
  prior_state text;
begin
  if tg_op = 'INSERT' then
    select state into batch_state from payment_batch where company_id = new.company_id and id = new.batch_id;
    if new.state <> 'PREPARED' or new.released_by is not null or batch_state is distinct from 'DRAFT' then
      raise exception 'a payment instruction is recorded as prepared, unreleased, into a draft batch' using errcode = '23514';
    end if;
    if new.outcome_actor_id is not null then
      raise exception 'the outcome actor is named at release' using errcode = '23514';
    end if;
    if new.retry_of_id is not null then
      select state into prior_state from payment_instruction where company_id = new.company_id and id = new.retry_of_id for update;
      if prior_state is null or prior_state not in ('FAILED', 'CANCELLED') then
        raise exception 'a retry replaces only a definitively failed or cancelled instruction' using errcode = '23514';
      end if;
    end if;
    return new;
  end if;
  if (new.batch_id, new.employee_id, new.amount, new.currency_code, new.idempotency_key, new.retry_of_id, new.payment_date)
     is distinct from (old.batch_id, old.employee_id, old.amount, old.currency_code, old.idempotency_key, old.retry_of_id, old.payment_date) then
    raise exception 'a payment instruction''s batch, payee, amount, currency, key, date and retry link never change' using errcode = '23514';
  end if;
  if old.released_by is not null and new.released_by is distinct from old.released_by then
    raise exception 'the release actor of a payment instruction never changes' using errcode = '23514';
  end if;
  -- C3 "confirmation actor explicitly assigned": named while the instruction is (or is becoming) RELEASED, and never someone
  -- the release rule excludes.
  if (new.outcome_actor_id, new.outcome_assigned_by, new.outcome_assigned_at) is distinct from (old.outcome_actor_id, old.outcome_assigned_by, old.outcome_assigned_at) then
    if new.state <> 'RELEASED' or new.outcome_actor_id is null then
      raise exception 'the outcome actor is named only for a released instruction that has no outcome yet' using errcode = '23514';
    end if;
    if new.outcome_assigned_at is distinct from now() then
      raise exception 'an outcome actor''s naming is stamped with that transaction''s time' using errcode = '23514';
    end if;
    perform hrms_payment_assert_independent(new.company_id, new.id, new.outcome_actor_id);
  end if;
  if new.state = old.state then
    return new;
  end if;
  if old.state = 'PREPARED' and new.state = 'RELEASED' then
    select state into batch_state from payment_batch where company_id = new.company_id and id = new.batch_id;
    if batch_state is distinct from 'READY' then
      raise exception 'only an instruction of a READY batch is released' using errcode = '23514';
    end if;
    if new.outcome_actor_id is null then
      raise exception 'a release names the outcome actor' using errcode = '23514';
    end if;
    perform hrms_payment_assert_independent(new.company_id, new.id, new.released_by);
  elsif old.state = 'PREPARED' and new.state = 'CANCELLED' then
    null; -- nothing was released, so nothing can have been paid: the reservation ends here.
  elsif old.state = 'RELEASED' and new.state in ('CONFIRMED', 'FAILED') then
    if not exists (select 1 from payment_event where company_id = new.company_id and instruction_id = new.id and event_kind = new.state) then
      raise exception 'a payment instruction becomes % only with its recorded outcome event', new.state using errcode = '23514';
    end if;
  else
    raise exception 'invalid payment instruction transition % -> %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;

create or replace function hrms_payment_event_guard() returns trigger language plpgsql as $$
declare
  i payment_instruction%rowtype;
  a payment_allocation%rowtype;
  charged numeric;
begin
  -- One writer per instruction at a time: its events are checked against each other under this lock.
  select * into i from payment_instruction where company_id = new.company_id and id = new.instruction_id for update;
  if not found then
    raise exception 'unknown payment instruction' using errcode = '23503';
  end if;
  perform hrms_payment_assert_independent(new.company_id, new.instruction_id, new.recorded_by);
  if new.event_kind in ('CONFIRMED', 'FAILED') then
    if i.state <> 'RELEASED' then
      raise exception 'an outcome is recorded only for a released payment instruction' using errcode = '23514';
    end if;
    if new.recorded_by is distinct from i.outcome_actor_id then
      raise exception 'only the outcome actor named on the instruction records its outcome' using errcode = '23514';
    end if;
    if exists (select 1 from payment_event where company_id = new.company_id and instruction_id = new.instruction_id and event_kind in ('CONFIRMED', 'FAILED')) then
      raise exception 'a payment instruction has one definitive outcome' using errcode = '23514';
    end if;
    if new.amount <> i.amount then
      raise exception 'an outcome covers the whole instruction amount' using errcode = '23514';
    end if;
    return new;
  end if;
  -- CI06: a reversal references a confirmation of the same instruction and returns at most what its allocation was paid.
  if not exists (select 1 from payment_event e where e.company_id = new.company_id and e.id = new.reverses_event_id
                   and e.instruction_id = new.instruction_id and e.event_kind = 'CONFIRMED') then
    raise exception 'a reversal must reference a confirmation of the same instruction' using errcode = '23514';
  end if;
  select * into a from payment_allocation where company_id = new.company_id and id = new.allocation_id and instruction_id = new.instruction_id;
  if not found then
    raise exception 'a reversal is charged to an allocation of its own instruction' using errcode = '23514';
  end if;
  select coalesce(sum(amount), 0) into charged from payment_event where company_id = new.company_id and allocation_id = new.allocation_id and event_kind = 'REVERSED';
  if charged + new.amount > a.amount then
    raise exception 'reversal exceeds the net confirmed amount of its allocation' using errcode = '23514';
  end if;
  return new;
end $$;
