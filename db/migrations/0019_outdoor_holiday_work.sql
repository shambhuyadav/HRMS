-- 0019 Outdoor duty and work-on-holiday requests (FR-027; DF03; DF05). Each is its own typed transaction root
-- with its own states; neither is leave and neither moves a leave balance (FR-027 acceptance).

create function hrms_work_request_mirror() returns trigger language plpgsql as $$
declare
  bt_state text;
begin
  select state into bt_state from business_transaction where company_id = new.company_id and id = new.transaction_id;
  if bt_state is distinct from new.state then
    raise exception '% state % does not match its transaction state %', tg_table_name, new.state, bt_state using errcode = '23514';
  end if;
  return null;
end $$;

do $$
declare
  k text;
begin
  foreach k in array array['outdoor_duty', 'holiday_work'] loop
    execute format($t$
      create table %1$I (
        id                uuid primary key default gen_random_uuid(),
        company_id        uuid not null references company (id) on delete restrict,
        employee_id       uuid not null,
        transaction_kind  text not null default %2$L check (transaction_kind = %2$L),
        transaction_id    uuid not null,
        start_date        date not null,
        end_date          date not null,
        -- Optional duty window within a single day (both or neither).
        start_time        time,
        end_time          time,
        purpose           text not null check (btrim(purpose) <> '' and length(purpose) <= 1000),
        state             text not null check (state in ('SUBMITTED', 'RETURNED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
        created_at        timestamptz not null default now(),
        created_by        uuid references user_account (id) on delete restrict,
        updated_at        timestamptz not null default now(),
        updated_by        uuid references user_account (id) on delete restrict,
        version           integer not null default 1 check (version > 0),
        unique (company_id, id),
        unique (company_id, transaction_id),
        check (end_date >= start_date),
        check ((start_time is null) = (end_time is null)),
        check (start_time is null or (start_date = end_date and end_time > start_time)),
        foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
        foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
          on delete restrict deferrable initially deferred,
        -- "Changes the permitted daily outcome once": no two live requests of one kind cover the same day.
        exclude using gist (company_id with =, employee_id with =, daterange(start_date, end_date, '[]') with &&)
          where (state in ('SUBMITTED', 'RETURNED', 'APPROVED'))
      )$t$, k || '_request', k);
    execute format('create constraint trigger %I after insert or update on %I deferrable initially deferred for each row execute function hrms_work_request_mirror()',
                   k || '_request_mirrors_transaction', k || '_request');
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', k || '_request_touch', k || '_request');
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', k || '_request_no_delete', k || '_request');

    insert into transaction_kind (kind, root_table, routing_kind) values (k, k || '_request', 'leave_request');
    insert into transaction_state (kind, state, initial, terminal) values
      (k, 'SUBMITTED', true,  false),
      (k, 'RETURNED',  false, false),
      (k, 'APPROVED',  false, false),
      (k, 'REJECTED',  false, true),
      (k, 'WITHDRAWN', false, true);
    insert into transaction_transition (kind, from_state, to_state) values
      (k, 'SUBMITTED', 'APPROVED'),
      (k, 'SUBMITTED', 'REJECTED'),
      (k, 'SUBMITTED', 'RETURNED'),
      (k, 'SUBMITTED', 'WITHDRAWN'),
      (k, 'RETURNED',  'SUBMITTED'),
      (k, 'RETURNED',  'WITHDRAWN');
  end loop;
end $$;

-- Holiday work is for one off day per request.
alter table holiday_work_request add constraint holiday_work_single_day check (start_date = end_date);

insert into permission (resource, action, field_group) values
  ('work_request', 'submit',   'operational'),
  ('work_request', 'read',     'operational'),
  ('work_request', 'withdraw', 'operational');
