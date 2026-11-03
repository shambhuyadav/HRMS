-- 0113 One candidate becomes one employee (FR-014 "the same accepted offer cannot create two employees"; FR-013 "avoid
-- duplicate identity records"; F1 hiring; audit line 2140 "no repeated conversion").
--
-- The unique keys of hiring_handover (0034) hold per offer and per application, so one person could still convert twice:
-- through two accepted offers on two requisitions, or through the retired duplicate record of someone already hired. A
-- person here is a candidate record and every record joined to it by confirmed duplicate reviews. While any of those
-- records has another accepted offer not yet handed over, or a handover to an employee who is not separated or archived,
-- no acceptance and no handover goes through; and neither does one for a record that is not ACTIVE. A rehire after
-- separation stays possible: an ended employment no longer counts.
--
-- Conversions of one company run one after another under one advisory lock (lockConversion in hiring/common.ts takes the
-- same key before its own check): a person's records can join at any moment, so a lock per record could miss the other
-- record, and acceptances and handovers are rare. A duplicate review needs no lock: it only ever adds to what a later
-- conversion finds, and a conversion that read before the review committed is simply ordered before it.

-- The candidate and every record joined to it by confirmed duplicate reviews, in either direction, however many steps.
create function hrms_candidate_identity(p_company uuid, p_candidate uuid) returns table (candidate_id uuid) language sql stable as $$
  with recursive same_person (id) as (
    select p_candidate
    union
    select case when f.candidate_id = s.id then f.matched_candidate_id else f.candidate_id end
      from same_person s
      join candidate_duplicate_flag f on f.company_id = p_company and f.state = 'CONFIRMED_DUPLICATE'
           and (f.candidate_id = s.id or f.matched_candidate_id = s.id)
  )
  select id from same_person
$$;

-- Why this offer cannot convert the candidate now, as the API's error code; null when it can. The offer itself never counts.
create function hrms_candidate_conversion_block(p_company uuid, p_candidate uuid, p_offer uuid) returns text language sql stable as $$
  select case
    when exists (select 1 from candidate c where c.company_id = p_company and c.id = p_candidate and c.state <> 'ACTIVE')
      then 'CANDIDATE_NOT_ACTIVE'
    when exists (
      select 1 from hrms_candidate_identity(p_company, p_candidate) g
        join hiring_handover h on h.company_id = p_company and h.candidate_id = g.candidate_id and h.offer_id <> p_offer
        join employee e on e.company_id = h.company_id and e.id = h.employee_id
        join reference_value st on st.company_id = e.company_id and st.id = e.status_id
       where st.code not in ('INACTIVE_SEPARATED', 'ARCHIVED'))
      then 'CANDIDATE_ALREADY_EMPLOYED'
    when exists (
      select 1 from hrms_candidate_identity(p_company, p_candidate) g
        join hiring_offer o on o.company_id = p_company and o.candidate_id = g.candidate_id and o.state = 'ACCEPTED' and o.id <> p_offer
       where not exists (select 1 from hiring_handover h where h.company_id = o.company_id and h.offer_id = o.id))
      then 'CANDIDATE_OFFER_ACCEPTED'
  end
$$;

create function hrms_hiring_single_conversion() returns trigger language plpgsql as $$
declare
  offer_id uuid;
  reason text;
begin
  if tg_table_name = 'hiring_offer' then
    if tg_op = 'UPDATE' and old.state = 'ACCEPTED' then
      return new;
    end if;
    offer_id := new.id;
  else
    offer_id := new.offer_id;
  end if;
  -- The same key as lockConversion. The check below reads after the lock, in its own statement, so it sees every
  -- conversion that held the lock before this one.
  perform pg_advisory_xact_lock(hashtextextended('hiring:conversion:' || new.company_id::text, 0));
  reason := hrms_candidate_conversion_block(new.company_id, new.candidate_id, offer_id);
  if reason is not null then
    raise exception 'candidate cannot convert: %', reason using errcode = '23514';
  end if;
  return new;
end $$;

create trigger hiring_offer_single_conversion before insert or update of state on hiring_offer
  for each row when (new.state = 'ACCEPTED') execute function hrms_hiring_single_conversion();
create trigger hiring_handover_single_conversion before insert on hiring_handover
  for each row execute function hrms_hiring_single_conversion();
