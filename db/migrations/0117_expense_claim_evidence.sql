-- 0117 What a submitted expense revision keeps (FR-071; FR-072; FR-075; FR-078; FR-106; BR-017; BR-023; DF06; line 103).

-- 1. The business purpose belongs to the revision that was reviewed ("keep claimant facts immutable after submission"), and
--    is frozen with it by hrms_expense_revision_frozen (0012). expense_claim.purpose stays as the current revision's copy.
--    Existing rows: the claim's text is the current revision's purpose. An earlier revision's text was overwritten before
--    this migration and cannot be recovered, so it stays NULL, which reads as "not recorded", never a guess. The check is
--    NOT VALID for that reason: it holds for every row written from now on, and those old submitted rows can no longer change.
alter table expense_revision add column purpose text;
alter table expense_revision disable trigger expense_revision_frozen;
alter table expense_revision disable trigger expense_revision_touch;
update expense_revision r set purpose = c.purpose
  from expense_claim c
 where c.company_id = r.company_id and c.id = r.claim_id and c.current_revision = r.revision;
alter table expense_revision enable trigger expense_revision_touch;
alter table expense_revision enable trigger expense_revision_frozen;
alter table expense_revision add constraint expense_revision_purpose_present check (purpose is not null and btrim(purpose) <> '') not valid;

-- 2. FR-078 "retain the rules used": the rule each line was judged under at submission, frozen with the line and pointing at a
--    rule that activation froze (0116). Lines submitted earlier stay NULL: they are not judged again.
alter table expense_line add column applied_rule_id uuid;
alter table expense_line add constraint expense_line_applied_rule_fk foreign key (company_id, applied_rule_id)
  references expense_policy_rule (company_id, id) on delete restrict;

-- 3. FR-075, BR-023 "exact invoice/receipt reuse requires a recorded review": a merchant's invoice as a comparable key, trimmed
--    and case-normalised like other identifiers (DF04), inner spaces collapsed. No key without a reference: a merchant alone
--    proves nothing. Similar references do not match, as similarity alone decides nothing (BR-023).
create function hrms_expense_invoice_key(p_merchant text, p_reference text) returns text language sql immutable as $$
  select case when nullif(btrim(p_reference), '') is null then null
              else lower(regexp_replace(btrim(p_merchant), '\s+', ' ', 'g')) || chr(31) || lower(regexp_replace(btrim(p_reference), '\s+', ' ', 'g')) end
$$;
create index expense_line_invoice_key_idx on expense_line (company_id, hrms_expense_invoice_key(merchant, invoice_reference));

-- 4. FR-071, FR-106: a receipt the scanner has not released is not evidence, and it can be quarantined after the revision was
--    submitted. The line's flags are frozen by then, so the line decision is where it counts: accepting such a line is a
--    documented exception like a flagged one (DF06 "any receipt omission"), needing the reviewer's own reason. New decisions
--    only: decisions already recorded stay as they are. (Replaces the function as 0096 left it.)
create or replace function hrms_expense_line_decision_check() returns trigger language plpgsql as $$
declare
  ok boolean;
  claimed numeric;
  flags text[];
  unreleased boolean;
begin
  select l.claimed_amount, l.exception_flags,
         exists (select 1 from approval_decision d
                   join approval_task t on t.company_id = d.company_id and t.id = d.task_id
                   join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
                   join expense_claim c on c.company_id = i.company_id and c.transaction_id = i.transaction_id
                  where d.company_id = new.company_id and d.id = new.approval_decision_id
                    and c.id = r.claim_id and i.transaction_revision = r.revision),
         exists (select 1 from expense_receipt er join attachment a on a.company_id = er.company_id and a.id = er.attachment_id
                  where er.company_id = l.company_id and er.line_id = l.id and a.scan_state is distinct from 'CLEAN')
    into claimed, flags, ok, unreleased
    from expense_line l join expense_revision r on r.company_id = l.company_id and r.id = l.revision_id
   where l.company_id = new.company_id and l.id = new.line_id;
  if not ok then
    raise exception 'line decision does not belong to the approval of its claim revision' using errcode = '23514';
  end if;
  if new.allowed_amount > claimed then
    raise exception 'allowed amount exceeds the claimed amount' using errcode = '23514';
  end if;
  if new.allowed_amount < claimed and (new.exception_reason is null or btrim(new.exception_reason) = '') then
    raise exception 'a reduced or rejected line needs a reason' using errcode = '23514';
  end if;
  if cardinality(flags) > 0 and (new.exception_reason is null or btrim(new.exception_reason) = '') then
    raise exception 'a flagged line needs a recorded clearance reason' using errcode = '23514';
  end if;
  if unreleased and (new.exception_reason is null or btrim(new.exception_reason) = '') then
    raise exception 'a line whose receipt is not released needs a recorded reason' using errcode = '23514';
  end if;
  return new;
end $$;
