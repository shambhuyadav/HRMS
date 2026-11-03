-- 0071 Cell-portable keys (docs/09 §3.4 and §13.2 item 6). A company's rows must copy to another cell with their
-- keys unchanged (company move protocol), so no key may depend on the database that allocated it:
--   1. outbox_event and outbox_event_attempt get UUID keys instead of bigint identities, and an attempt references
--      its event by (company_id, event_id) like every other same-company reference (B1);
--   2. permission ids are derived from the natural key (resource, action, field_group), so every cell installs the
--      same catalogue with the same ids, and role_permission, role_assignment_permission, delegation, workflow_step
--      and role_dashboard_widget rows copy without remapping (P1 release-pinned catalogue);
--   3. a generic immutability trigger for the intra-company partition key that T-05 will pick (§4.3); it is attached
--      to no table until that decision is made.
-- Existing rows keep their data: outbox events keep their claim position, attempts stay linked to their events, and
-- every permission reference is re-pointed to the derived id of the same permission. No business value changes, so
-- versions and update times stay as they are. Company-prefixed object keys need no schema change: the stored
-- reference already names the object (storage/files.ts).

-- ---------------------------------------------------------------------------
-- 1. Outbox: UUID keys. The former identity stays as `seq`, a cell-local position that is never a key and never
-- referenced. The dispatcher claims oldest first by (created_at, seq): created_at is the writing transaction's start
-- time, comparable across cells, and seq keeps the order in which one transaction wrote its events (all in one cell).
-- Existing rows keep both values, so the events of successive transactions and the events of one transaction keep
-- their order; events of overlapping transactions follow their transactions' start times (ids were allocated before
-- commit, so their order never followed commits either). A copy to another cell keeps created_at and may keep seq.
-- ---------------------------------------------------------------------------
-- Workers lock an event and then record its attempt, so the tables are locked in that order before anything changes.
lock table outbox_event, outbox_event_attempt in access exclusive mode;

alter table outbox_event_attempt drop constraint outbox_event_attempt_event_id_fkey;
alter table outbox_event drop constraint outbox_event_pkey;
alter table outbox_event rename column id to seq;
alter table outbox_event add column id uuid not null default gen_random_uuid();
alter table outbox_event add constraint outbox_event_pkey primary key (id);
alter table outbox_event add constraint outbox_event_company_id_id_key unique (company_id, id);

drop index outbox_event_ready_idx;
create index outbox_event_ready_idx on outbox_event (created_at, seq) where (published_at is null and failed_at is null);

-- Attempts: the event reference becomes (company_id, event_id), and the attempt's own key a UUID (nothing references
-- it; attempts are ordered by `attempt` within their event).
alter table outbox_event_attempt rename column event_id to event_seq;
alter table outbox_event_attempt add column event_id uuid;
-- Re-pointing recorded attempts is a key change, not a change to what was recorded.
alter table outbox_event_attempt disable trigger outbox_event_attempt_append_only;
update outbox_event_attempt a set event_id = e.id from outbox_event e where e.seq = a.event_seq;
alter table outbox_event_attempt enable trigger outbox_event_attempt_append_only;
alter table outbox_event_attempt alter column event_id set not null;
alter table outbox_event_attempt drop constraint outbox_event_attempt_event_id_attempt_key;
alter table outbox_event_attempt drop column event_seq;
alter table outbox_event_attempt drop constraint outbox_event_attempt_pkey;
alter table outbox_event_attempt drop column id;
alter table outbox_event_attempt add column id uuid not null default gen_random_uuid();
alter table outbox_event_attempt add constraint outbox_event_attempt_pkey primary key (id);
alter table outbox_event_attempt add constraint outbox_event_attempt_event_id_attempt_key unique (event_id, attempt);
-- An attempt and its event belong to the same company (the dispatcher records the event's company); a row that did not
-- would make this constraint, and with it the migration, fail.
alter table outbox_event_attempt add constraint outbox_event_attempt_event_fkey
  foreign key (company_id, event_id) references outbox_event (company_id, id) on delete restrict;

-- ---------------------------------------------------------------------------
-- 2. Deterministic permission ids: the name-based UUID of RFC 9562 (version 8 with SHA-256, Appendix B.2) of the
-- permission key `resource.action.field_group` in a fixed HRMS namespace, which is part of every id and never changes.
-- SHA-256 is built in, so no extension is needed (UUID version 5 would need SHA-1 from pgcrypto or uuid-ossp).
-- SQL-standard bodies are bound when created, so the check constraint below also evaluates under an empty search_path
-- (restore).
-- ---------------------------------------------------------------------------
create function hrms_uuid_v8_sha256(p_namespace uuid, p_name text) returns uuid
  language sql immutable strict parallel safe
begin atomic
  select encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 128), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid
    from (select substring(sha256(uuid_send(p_namespace) || convert_to(p_name, 'UTF8')) from 1 for 16) as h) as d;
end;

create function hrms_permission_id(p_resource text, p_action text, p_field_group text) returns uuid
  language sql immutable strict parallel safe
  return hrms_uuid_v8_sha256('7b64b384-0c1e-4231-a0f9-828e2361f23c'::uuid, p_resource || '.' || p_action || '.' || p_field_group);

-- Re-key the catalogue. Every foreign key to permission is found from the system catalog, so none is missed. All of
-- them are dropped; the rows of each referencing table are re-pointed to the derived id of the permission they
-- reference, with that table's triggers off (the same permission under a new id is no business change: versions,
-- update times, append-only history and the freeze of workflows in use stay as they are); the catalogue rows take
-- their derived ids the same way; then every foreign key is added back with its exact definition and name, which
-- validates every reference again (no orphan). Every trigger is restored to the state it had.
do $$
declare
  fks jsonb;
  fk jsonb;
  steps jsonb := '[]'::jsonb;
  step jsonb;
  rel regclass;
  saved jsonb;
  trg jsonb;
begin
  if exists (select 1 from pg_constraint where contype = 'f' and confrelid = 'permission'::regclass and cardinality(conkey) <> 1) then
    raise exception 'a multi-column foreign key references permission';
  end if;
  -- Old ids are random (version 4) and derived ids are version 8, so they never meet; checked all the same, because
  -- an old id equal to another permission's derived id would collide while references are re-pointed.
  if exists (with d as (select id, hrms_permission_id(resource, action, field_group) as derived from permission)
             select 1 from d a join d b on a.id = b.derived and a.id <> b.id) then
    raise exception 'a permission id equals the derived id of another permission';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('rel', c.conrelid::regclass::text, 'col', a.attname::text, 'name', c.conname::text,
                                               'def', pg_get_constraintdef(c.oid))
                            order by c.conrelid::regclass::text, c.conname), '[]'::jsonb)
    into fks
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
   where c.contype = 'f' and c.confrelid = 'permission'::regclass and c.conparentid = 0;

  for fk in select value from jsonb_array_elements(fks) loop
    execute format('alter table %s drop constraint %I', fk ->> 'rel', fk ->> 'name');
    steps := steps || jsonb_build_array(jsonb_build_object(
      'rel', fk ->> 'rel',
      'sql', format('update %s t set %I = hrms_permission_id(p.resource, p.action, p.field_group) from permission p
                      where p.id = t.%I and t.%I <> hrms_permission_id(p.resource, p.action, p.field_group)',
                    fk ->> 'rel', fk ->> 'col', fk ->> 'col', fk ->> 'col')));
  end loop;
  steps := steps || jsonb_build_array(jsonb_build_object(
    'rel', 'permission',
    'sql', 'update permission set id = hrms_permission_id(resource, action, field_group) where id <> hrms_permission_id(resource, action, field_group)'));

  for step in select value from jsonb_array_elements(steps) loop
    rel := (step ->> 'rel')::regclass;
    -- The triggers that would fire (enabled, or enabled always), saved with their state.
    select coalesce(jsonb_agg(jsonb_build_object('name', t.tgname::text, 'enabled', t.tgenabled::text)), '[]'::jsonb)
      into saved
      from pg_trigger t
     where t.tgrelid = rel and not t.tgisinternal and t.tgparentid = 0 and t.tgenabled in ('O', 'A');
    for trg in select value from jsonb_array_elements(saved) loop
      execute format('alter table %s disable trigger %I', rel, trg ->> 'name');
    end loop;
    execute step ->> 'sql';
    for trg in select value from jsonb_array_elements(saved) loop
      execute format(case trg ->> 'enabled' when 'A' then 'alter table %s enable always trigger %I' else 'alter table %s enable trigger %I' end,
                     rel, trg ->> 'name');
    end loop;
  end loop;

  for fk in select value from jsonb_array_elements(fks) loop
    execute format('alter table %s add constraint %I %s', fk ->> 'rel', fk ->> 'name', fk ->> 'def');
  end loop;
end $$;

-- New permissions get their derived id: an insert names no id (or exactly the derived one). Every row keeps
-- id = hrms_permission_id(resource, action, field_group), so a key cannot change without its id, and an id that is
-- referenced cannot change at all (the foreign keys refuse it). Renaming a permission is therefore a new permission:
-- insert the new key, re-point the references, then delete the old row.
alter table permission alter column id drop default;
alter table permission add constraint permission_id_derived check (id = hrms_permission_id(resource, action, field_group));

create function hrms_permission_derived_id() returns trigger language plpgsql as $$
declare
  derived uuid := hrms_permission_id(new.resource, new.action, new.field_group);
begin
  if new.id is not null and new.id <> derived then
    raise exception 'permission ids are derived from resource, action and field group' using errcode = '23514';
  end if;
  new.id := derived;
  return new;
end $$;
create trigger permission_derived_id before insert on permission for each row execute function hrms_permission_derived_id();

-- ---------------------------------------------------------------------------
-- 3. Immutability of named columns, for the intra-company partition key (docs/09 §4.3: partition keys must be
-- immutable; company_id already is, through hrms_touch()). Attach as
--   create trigger <table>_partition_key before update on <table> for each row
--     execute function hrms_immutable_columns('<column>', ...);
-- once T-05 has chosen the key. Anything else is refused: a column name the table does not have (so a typo cannot
-- pass silently), no column at all, or an insert or statement-level trigger (it has no earlier row to compare with).
-- ---------------------------------------------------------------------------
create function hrms_immutable_columns() returns trigger language plpgsql as $$
declare
  col text;
  before_row jsonb := to_jsonb(old);
  after_row jsonb := to_jsonb(new);
begin
  if tg_op <> 'UPDATE' or tg_level <> 'ROW' then
    raise exception 'hrms_immutable_columns() on % must be a row-level update trigger', tg_table_name;
  end if;
  if tg_nargs = 0 then
    raise exception 'hrms_immutable_columns() on % needs at least one column name', tg_table_name;
  end if;
  foreach col in array tg_argv loop
    if not (after_row ? col) then
      raise exception 'hrms_immutable_columns(): % has no column %', tg_table_name, col;
    end if;
    if (after_row -> col) is distinct from (before_row -> col) then
      raise exception '%.% is immutable', tg_table_name, col using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;
