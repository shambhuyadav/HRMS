-- 0025 Outdoor-duty time windows may cross midnight (FR-027; DF05). DF05: an overnight shift belongs to the date
-- of its start, so a duty window for a night shift (e.g. 23:00-03:00) is requested on its start date; an end
-- time earlier than the start time means the window ends on the next calendar day. A zero-length window is
-- still refused. Evaluation attaches each window to the shift whose capture window it overlaps.
do $$
declare
  c record;
begin
  for c in
    select con.conname from pg_constraint con join pg_class rel on rel.oid = con.conrelid
     where rel.relname = 'outdoor_duty_request' and con.contype = 'c' and pg_get_constraintdef(con.oid) like '%end_time > start_time%'
  loop
    execute format('alter table outdoor_duty_request drop constraint %I', c.conname);
  end loop;
end $$;

alter table outdoor_duty_request add constraint outdoor_duty_window_check
  check (start_time is null or (start_date = end_date and end_time <> start_time));
