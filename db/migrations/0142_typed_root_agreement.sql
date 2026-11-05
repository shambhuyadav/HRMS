-- 0142 A transaction and its typed root agree (CI12; B5 "owner_employee_id agrees with claimant/employee on that root where
-- applicable" line 4547; C4 self-approval). Routing and self-exclusion read business_transaction.owner_employee_id, so a root
-- naming another employee would be decided as if it were someone else's. Needs hrms_columns_fixed (0141).

-- 1. The root's employee is the transaction's owner, checked at commit because either row may be written first. Since the owner
--    never changes (hrms_transaction_state_guard) and a root keeps its transaction (3 below), this also fixes the root's
--    employee. A stored row that disagrees must not stop an upgrade, and which of the two is right is not for a migration
--    to guess: the row is kept, the table's constraint stays NOT VALID (it still applies to every new or changed row) and the
--    migration says so. Any such row is then a data question for the owner of that record.
alter table business_transaction add constraint business_transaction_owner_key unique (company_id, id, owner_employee_id);

do $$
declare
  r record;
begin
  for r in
    select tk.root_table, c.column_name
      from transaction_kind tk
      join information_schema.columns c on c.table_schema = current_schema() and c.table_name = tk.root_table
     where c.column_name in ('employee_id', 'requesting_employee_id')
     order by tk.root_table
  loop
    execute format(
      'alter table %I add constraint %I foreign key (company_id, transaction_id, %I)
         references business_transaction (company_id, id, owner_employee_id) on delete restrict deferrable initially deferred not valid',
      r.root_table, r.root_table || '_owner_agrees', r.column_name);
    begin
      execute format('alter table %I validate constraint %I', r.root_table, r.root_table || '_owner_agrees');
    exception when foreign_key_violation then
      raise warning '% holds stored rows whose employee differs from their transaction owner; they are kept, and % stays NOT VALID', r.root_table, r.root_table || '_owner_agrees';
    end;
  end loop;
end $$;

-- 2. Every root mirrors the transaction state, but its mirror fires only when the root is written, so a state write on the
--    transaction alone used to commit with the two apart. This reads both rows as they stand at commit, whatever happened
--    between. A kind whose root keeps no state has nothing to compare. A stored pair already apart is caught only when
--    its transaction next changes state, which then has to bring the root along.
create function hrms_transaction_state_agrees() returns trigger language plpgsql as $$
declare
  root regclass;
  bt_state text;
  root_state text;
begin
  select to_regclass(root_table) into root from transaction_kind where kind = new.kind;
  if root is null or not exists (select 1 from pg_attribute where attrelid = root and attname = 'state' and attnum > 0 and not attisdropped) then
    return null;
  end if;
  select state into bt_state from business_transaction where company_id = new.company_id and id = new.id;
  execute format('select state from %s where company_id = $1 and transaction_id = $2', root) into root_state using new.company_id, new.id;
  if root_state is distinct from bt_state then
    raise exception 'transaction % is in state % but its % root is in state %', new.id, bt_state, new.kind, root_state using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger business_transaction_state_agrees
  after update on business_transaction deferrable initially deferred
  for each row when (new.state is distinct from old.state)
  execute function hrms_transaction_state_agrees();

-- 3. A root keeps its transaction: its approvals, decisions and audit all hang on that link.
do $$
declare
  t text;
begin
  for t in select root_table from transaction_kind order by root_table loop
    execute format('create trigger %I before update on %I for each row execute function hrms_columns_fixed(%L)', t || '_transaction_fixed', t, 'transaction_id');
  end loop;
end $$;
