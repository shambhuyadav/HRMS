-- 0088 Expense payment ledger (B5 payment conservation; C4; C5; CI02; CI03; CI05; CI06; DB055-DB059; DF02; DF03; DF07;
-- ZT14; ZT15). 0012 counted an allocation as paid whenever its instruction's state said CONFIRMED and charged every
-- reversal of an instruction to each of its allocations; instruction states, outcome events and claim payment states
-- agreed only because the service wrote them together. From here the database keeps the ledger itself:
--   1. A reversal names the allocation it returns (payment_event.allocation_id, an allocation of the same instruction),
--      so an instruction covering several obligations of one employee (CI05) charges it to one obligation only, never
--      above what that allocation was paid. Recorded reversals belong to the only allocation of their instruction (the
--      service prepares one allocation per instruction).
--   2. Per obligation (DF07): net paid = allocations whose instruction has its CONFIRMED event - the reversals charged
--      to them; pending = allocations whose instruction has no definitive outcome event and was not cancelled.
--   3. Instruction states follow PREPARED -> RELEASED -> CONFIRMED | FAILED and PREPARED -> CANCELLED (C5). An
--      instruction is CONFIRMED or FAILED exactly when its one outcome event exists, recorded for its whole amount
--      while it was RELEASED, so a confirmation reduces pending and increases paid once (B5). A released instruction
--      keeps its reservation until an outcome is recorded from evidence (DF07: unknown outcomes stay pending).
--      Batch, payee, amount, currency, key, date and retry link never change; nor do the release actor and the
--      batch's preparer once recorded. New instructions are prepared, into a batch that is still READY.
--   4. An instruction's amount equals the sum of its allocations (CI05), checked at commit.
--   5. A retry replaces a FAILED or CANCELLED instruction of the same employee and currency, at most once, and covers
--      the same obligations (CI06). Its link is fixed when it is created and points at an older, settled instruction,
--      so no cycle can form.
--   6. Duties (DF02 "preparation, entitlement approval and payment release are distinct actors"; DF03 "a third
--      independent payment release"; C4; DB056). Nobody who approved the entitlement (the final approver and every
--      financial reviewer who decided its line amounts) and not the claimant prepares a payment. The release actor and
--      whoever records an outcome or a reversal differ from the batch preparer, from the claimant, and from the final
--      approver and every decider of the approval of each allocated claim, the manager step included.
--   7. A claim's current revision is one of its own revisions (CI02). An obligation belongs to the APPROVED claim's
--      current, submitted revision and has its currency (CI03), and keeps belonging to it.
--   8. A claim's payment_state is the C5 derivation from its ledger, checked at commit; the service writes it with the
--      same function, after locking the claim.
--   9. The conservation check of 0012 locks its obligation, so concurrent writers of one obligation are serialised by
--      the database as well (ZT14).
-- Existing rows are checked first; a violation of the money rules stops the migration (B5: reject before adding
-- constraints). Duties are not judged on existing rows: they are checked when an act is recorded, the wider rule of
-- item 6 was not in force when those rows were written, and an append-only record could not be repaired anyway. Rows
-- already recorded stay as they are; every further act on them is checked.

-- ---------------------------------------------------------------------------------------------------------------
-- Existing rows
-- ---------------------------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from payment_event e
              where e.event_kind = 'REVERSED'
                and (select count(*) from payment_allocation a where a.company_id = e.company_id and a.instruction_id = e.instruction_id) <> 1) then
    raise exception 'a recorded reversal cannot be charged to a single allocation of its instruction' using errcode = '23514';
  end if;
  if exists (select 1 from payment_event where event_kind in ('CONFIRMED', 'FAILED') group by company_id, instruction_id having count(*) > 1) then
    raise exception 'a payment instruction has more than one definitive outcome' using errcode = '23514';
  end if;
  if exists (select 1 from payment_event e join payment_instruction i on i.company_id = e.company_id and i.id = e.instruction_id
              where e.event_kind in ('CONFIRMED', 'FAILED') and (e.amount <> i.amount or i.state <> e.event_kind))
     or exists (select 1 from payment_instruction i
                 where i.state in ('CONFIRMED', 'FAILED')
                   and not exists (select 1 from payment_event e where e.company_id = i.company_id and e.instruction_id = i.id and e.event_kind = i.state)) then
    raise exception 'a payment instruction''s state, amount and outcome event disagree' using errcode = '23514';
  end if;
  if exists (select 1 from payment_instruction i
              where i.amount <> coalesce((select sum(a.amount) from payment_allocation a where a.company_id = i.company_id and a.instruction_id = i.id), 0)) then
    raise exception 'a payment instruction''s amount differs from the sum of its allocations' using errcode = '23514';
  end if;
  if exists (select 1 from payment_instruction i join payment_instruction p on p.company_id = i.company_id and p.id = i.retry_of_id
              where p.id = i.id or p.state not in ('FAILED', 'CANCELLED') or p.employee_id <> i.employee_id or p.currency_code <> i.currency_code
                 or exists (select a.obligation_id from payment_allocation a where a.company_id = i.company_id and a.instruction_id = i.id
                            except select a.obligation_id from payment_allocation a where a.company_id = p.company_id and a.instruction_id = p.id)
                 or exists (select a.obligation_id from payment_allocation a where a.company_id = p.company_id and a.instruction_id = p.id
                            except select a.obligation_id from payment_allocation a where a.company_id = i.company_id and a.instruction_id = i.id))
     or exists (select 1 from payment_instruction where retry_of_id is not null group by company_id, retry_of_id having count(*) > 1) then
    raise exception 'a payment retry does not replace one settled instruction for the same liabilities' using errcode = '23514';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Reversals are charged to one allocation of their instruction
-- ---------------------------------------------------------------------------------------------------------------
alter table payment_allocation add constraint payment_allocation_instruction_member unique (company_id, id, instruction_id);
alter table payment_event add column allocation_id uuid;
-- Naming the allocation of a recorded reversal adds a key to what was recorded; it changes nothing recorded.
alter table payment_event disable trigger payment_event_append_only;
update payment_event e set allocation_id = a.id
  from payment_allocation a
 where e.event_kind = 'REVERSED' and a.company_id = e.company_id and a.instruction_id = e.instruction_id;
alter table payment_event enable trigger payment_event_append_only;
alter table payment_event
  add constraint payment_event_allocation_fk foreign key (company_id, allocation_id, instruction_id)
      references payment_allocation (company_id, id, instruction_id) on delete restrict,
  add constraint payment_event_allocation_reversal_only check ((event_kind = 'REVERSED') = (allocation_id is not null));

create index payment_event_instruction_idx on payment_event (company_id, instruction_id, event_kind);
create index payment_event_allocation_idx on payment_event (company_id, allocation_id) where allocation_id is not null;
create index payment_allocation_obligation_idx on payment_allocation (company_id, obligation_id);

-- CI06: a retry belongs to the same employee and currency, replaces its instruction at most once and never itself.
create unique index payment_instruction_retried_once on payment_instruction (company_id, retry_of_id) where retry_of_id is not null;
alter table payment_instruction
  add constraint payment_instruction_retry_same_party foreign key (company_id, retry_of_id, employee_id, currency_code)
      references payment_instruction (company_id, id, employee_id, currency_code) on delete restrict,
  add constraint payment_instruction_retry_not_itself check (retry_of_id <> id),
  add constraint payment_instruction_release_recorded check ((released_by is not null) = (state in ('RELEASED', 'CONFIRMED', 'FAILED')));

-- CI02: the current revision of a claim is one of its own revisions (a new draft writes the claim before revision 1).
alter table expense_claim add constraint expense_claim_current_revision_fk foreign key (company_id, id, current_revision)
  references expense_revision (company_id, claim_id, revision) deferrable initially deferred;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. The ledger per obligation, from allocations and outcome events (same columns as 0012)
-- ---------------------------------------------------------------------------------------------------------------
create or replace view expense_obligation_ledger as
select o.company_id, o.id as obligation_id, o.claim_id, o.approved_amount, o.currency_code,
       coalesce((select sum(a.amount) from payment_allocation a
                  where a.company_id = o.company_id and a.obligation_id = o.id
                    and exists (select 1 from payment_event c
                                 where c.company_id = a.company_id and c.instruction_id = a.instruction_id and c.event_kind = 'CONFIRMED')), 0)
       - coalesce((select sum(r.amount) from payment_allocation a
                     join payment_event r on r.company_id = a.company_id and r.allocation_id = a.id and r.event_kind = 'REVERSED'
                    where a.company_id = o.company_id and a.obligation_id = o.id), 0) as net_paid,
       coalesce((select sum(a.amount) from payment_allocation a
                   join payment_instruction i on i.company_id = a.company_id and i.id = a.instruction_id and i.state <> 'CANCELLED'
                  where a.company_id = o.company_id and a.obligation_id = o.id
                    and not exists (select 1 from payment_event d
                                     where d.company_id = a.company_id and d.instruction_id = a.instruction_id and d.event_kind in ('CONFIRMED', 'FAILED'))), 0) as pending
  from expense_obligation o;

-- C5 derived claim payment state: NO_PAYABLE_AMOUNT for an approved claim with no obligation (zero approved), UNPAID
-- while nothing is net paid, PART_PAID below the approved amount, PAID at it. Pending reservations never count.
create function hrms_expense_claim_payment_state(p_company uuid, p_claim uuid) returns text language sql stable as $$
  select case when c.state <> 'APPROVED' then 'NOT_APPLICABLE'
              when l.obligation_id is null then 'NO_PAYABLE_AMOUNT'
              when l.net_paid <= 0 then 'UNPAID'
              when l.net_paid < l.approved_amount then 'PART_PAID'
              else 'PAID' end
    from expense_claim c
    left join expense_obligation_ledger l on l.company_id = c.company_id and l.claim_id = c.id
   where c.company_id = p_company and c.id = p_claim
$$;

-- CI03 and C5 for one claim: its obligation belongs to its approved current revision, and its payment state is derived.
create function hrms_expense_claim_ledger_check(p_company uuid, p_claim uuid) returns void language plpgsql as $$
declare
  c expense_claim%rowtype;
  derived text;
begin
  select * into c from expense_claim where company_id = p_company and id = p_claim;
  if exists (select 1 from expense_obligation o where o.company_id = p_company and o.claim_id = p_claim)
     and not exists (select 1 from expense_obligation o
                       join expense_revision r on r.company_id = o.company_id and r.id = o.revision_id
                      where o.company_id = p_company and o.claim_id = p_claim and c.state = 'APPROVED' and r.claim_id = c.id
                        and r.revision = c.current_revision and r.submitted_at is not null and r.currency_code = o.currency_code) then
    raise exception 'an expense obligation belongs to the approved current revision of its claim' using errcode = '23514';
  end if;
  derived := hrms_expense_claim_payment_state(p_company, p_claim);
  if c.payment_state is distinct from derived then
    raise exception 'claim payment state % differs from its ledger (%)', c.payment_state, derived using errcode = '23514';
  end if;
end $$;

do $$
begin
  if exists (select 1 from payment_allocation a
              where coalesce((select sum(e.amount) from payment_event e
                               where e.company_id = a.company_id and e.allocation_id = a.id and e.event_kind = 'REVERSED'), 0) > a.amount) then
    raise exception 'recorded reversals exceed what their allocation was paid' using errcode = '23514';
  end if;
  perform hrms_expense_claim_ledger_check(c.company_id, c.id) from expense_claim c;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3-6. Instructions, outcome events and duties
-- ---------------------------------------------------------------------------------------------------------------
-- The people a payment must be independent of (item 6). A user link of any date counts: it is the same person.
create function hrms_payment_preparer_conflict(p_company uuid, p_obligation uuid, p_actor uuid) returns boolean language sql stable as $$
  select exists (select 1 from expense_obligation o where o.company_id = p_company and o.id = p_obligation and o.approved_by = p_actor)
      or exists (select 1 from expense_obligation o
                   join expense_line l on l.company_id = o.company_id and l.revision_id = o.revision_id
                   join expense_line_decision ld on ld.company_id = l.company_id and ld.line_id = l.id
                   join approval_decision d on d.company_id = ld.company_id and d.id = ld.approval_decision_id
                  where o.company_id = p_company and o.id = p_obligation and d.actor_user_id = p_actor)
      or exists (select 1 from expense_obligation o
                   join user_employee_link u on u.company_id = o.company_id and u.employee_id = o.employee_id
                  where o.company_id = p_company and o.id = p_obligation and u.user_id = p_actor)
$$;

create function hrms_payment_release_conflict(p_company uuid, p_instruction uuid, p_actor uuid) returns boolean language sql stable as $$
  select exists (select 1 from payment_instruction i join payment_batch b on b.company_id = i.company_id and b.id = i.batch_id
                  where i.company_id = p_company and i.id = p_instruction and b.prepared_by = p_actor)
      or exists (select 1 from payment_instruction i join user_employee_link u on u.company_id = i.company_id and u.employee_id = i.employee_id
                  where i.company_id = p_company and i.id = p_instruction and u.user_id = p_actor)
      or exists (select 1 from payment_allocation a join expense_obligation o on o.company_id = a.company_id and o.id = a.obligation_id
                  where a.company_id = p_company and a.instruction_id = p_instruction and o.approved_by = p_actor)
      or exists (select 1 from payment_allocation a
                   join expense_obligation o on o.company_id = a.company_id and o.id = a.obligation_id
                   join expense_revision r on r.company_id = o.company_id and r.id = o.revision_id
                   join expense_claim c on c.company_id = o.company_id and c.id = o.claim_id
                   join approval_instance ai on ai.company_id = c.company_id and ai.transaction_id = c.transaction_id and ai.transaction_revision = r.revision
                   join approval_task t on t.company_id = ai.company_id and t.instance_id = ai.id
                   join approval_decision d on d.company_id = t.company_id and d.task_id = t.id
                  where a.company_id = p_company and a.instruction_id = p_instruction and d.actor_user_id = p_actor)
$$;

create function hrms_payment_assert_independent(p_company uuid, p_instruction uuid, p_actor uuid) returns void language plpgsql as $$
begin
  if hrms_payment_release_conflict(p_company, p_instruction, p_actor) then
    raise exception 'the preparer, the claim''s approvers and the claimant never release a payment or record its outcome' using errcode = '23514';
  end if;
end $$;

create function hrms_payment_allocation_duties() returns trigger language plpgsql as $$
declare
  preparer uuid;
begin
  select b.prepared_by into preparer
    from payment_instruction i join payment_batch b on b.company_id = i.company_id and b.id = i.batch_id
   where i.company_id = new.company_id and i.id = new.instruction_id;
  if hrms_payment_preparer_conflict(new.company_id, new.obligation_id, preparer) then
    raise exception 'an entitlement approver or the claimant never prepares its payment' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payment_allocation_duties before insert on payment_allocation for each row execute function hrms_payment_allocation_duties();

create function hrms_payment_instruction_guard() returns trigger language plpgsql as $$
declare
  batch_state text;
  prior_state text;
begin
  if tg_op = 'INSERT' then
    select state into batch_state from payment_batch where company_id = new.company_id and id = new.batch_id;
    if new.state <> 'PREPARED' or new.released_by is not null or batch_state is distinct from 'READY' then
      raise exception 'a payment instruction is recorded as prepared, unreleased, into a ready batch' using errcode = '23514';
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
  if new.state = old.state then
    return new;
  end if;
  if old.state = 'PREPARED' and new.state = 'RELEASED' then
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
create trigger payment_instruction_guard before insert or update on payment_instruction for each row execute function hrms_payment_instruction_guard();

create function hrms_payment_event_guard() returns trigger language plpgsql as $$
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
drop trigger payment_reversal_check on payment_event;
drop function hrms_payment_reversal_check();
create trigger payment_event_guard before insert on payment_event for each row execute function hrms_payment_event_guard();

-- At commit, an outcome event and its instruction's state agree (the instruction moves in the same transaction).
create function hrms_payment_event_settles() returns trigger language plpgsql as $$
begin
  if new.event_kind in ('CONFIRMED', 'FAILED')
     and not exists (select 1 from payment_instruction where company_id = new.company_id and id = new.instruction_id and state = new.event_kind) then
    raise exception 'a % outcome event and its instruction''s state must agree', new.event_kind using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger payment_event_settles_instruction after insert on payment_event deferrable initially deferred
  for each row execute function hrms_payment_event_settles();

-- CI05 / CI06 at commit: an instruction's amount equals its allocations; a retry covers the obligations it replaces.
create function hrms_payment_instruction_balanced() returns trigger language plpgsql as $$
declare
  iid uuid := (to_jsonb(new) ->> case when tg_table_name = 'payment_instruction' then 'id' else 'instruction_id' end)::uuid;
  i payment_instruction%rowtype;
  allocated numeric;
begin
  select * into i from payment_instruction where company_id = new.company_id and id = iid;
  select coalesce(sum(amount), 0) into allocated from payment_allocation where company_id = new.company_id and instruction_id = iid;
  if allocated <> i.amount then
    raise exception 'a payment instruction''s amount must equal the sum of its allocations' using errcode = '23514';
  end if;
  if i.retry_of_id is not null
     and (exists (select obligation_id from payment_allocation where company_id = i.company_id and instruction_id = i.id
                  except select obligation_id from payment_allocation where company_id = i.company_id and instruction_id = i.retry_of_id)
          or exists (select obligation_id from payment_allocation where company_id = i.company_id and instruction_id = i.retry_of_id
                     except select obligation_id from payment_allocation where company_id = i.company_id and instruction_id = i.id)) then
    raise exception 'a retry covers the same obligations as the instruction it replaces' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger payment_instruction_balanced after insert on payment_instruction deferrable initially deferred
  for each row execute function hrms_payment_instruction_balanced();
create constraint trigger payment_allocation_balanced after insert on payment_allocation deferrable initially deferred
  for each row execute function hrms_payment_instruction_balanced();

-- The preparer is the recorded actor the release is checked against, so it is not an editable attribution (C4).
create function hrms_payment_batch_guard() returns trigger language plpgsql as $$
begin
  if (new.transaction_id, new.prepared_by, new.currency_code) is distinct from (old.transaction_id, old.prepared_by, old.currency_code) then
    raise exception 'a payment batch''s transaction, preparer and currency never change' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payment_batch_guard before update on payment_batch for each row execute function hrms_payment_batch_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- 7-8. Claims and obligations agree with their ledger at commit
-- ---------------------------------------------------------------------------------------------------------------
create function hrms_expense_claim_ledger_trigger() returns trigger language plpgsql as $$
declare
  r jsonb := to_jsonb(new);
begin
  if tg_table_name = 'payment_event' then
    perform hrms_expense_claim_ledger_check(o.company_id, o.claim_id)
       from payment_allocation a join expense_obligation o on o.company_id = a.company_id and o.id = a.obligation_id
      where a.company_id = new.company_id and a.instruction_id = (r ->> 'instruction_id')::uuid;
  else
    perform hrms_expense_claim_ledger_check(new.company_id, (r ->> case when tg_table_name = 'expense_claim' then 'id' else 'claim_id' end)::uuid);
  end if;
  return null;
end $$;
create constraint trigger expense_claim_ledger_agrees after insert or update on expense_claim deferrable initially deferred
  for each row when (new.state = 'APPROVED') execute function hrms_expense_claim_ledger_trigger();
create constraint trigger expense_obligation_ledger_agrees after insert on expense_obligation deferrable initially deferred
  for each row execute function hrms_expense_claim_ledger_trigger();
create constraint trigger payment_event_ledger_agrees after insert on payment_event deferrable initially deferred
  for each row execute function hrms_expense_claim_ledger_trigger();

-- ---------------------------------------------------------------------------------------------------------------
-- 9. Conservation (ZT14), serialised per obligation
-- ---------------------------------------------------------------------------------------------------------------
create or replace function hrms_payment_allocation_conservation() returns trigger language plpgsql as $$
declare
  l record;
begin
  -- A writer that has not locked the obligation waits here for one that has; the ledger read that follows then
  -- includes every reservation committed before it.
  perform 1 from expense_obligation where company_id = new.company_id and id = new.obligation_id for update;
  select * into l from expense_obligation_ledger where company_id = new.company_id and obligation_id = new.obligation_id;
  if l.net_paid + l.pending > l.approved_amount then
    raise exception 'payment allocation exceeds the approved obligation' using errcode = '23514';
  end if;
  return null;
end $$;
