-- FR-039 labour welfare fund packs (decided under owner delegation, 6 Nov 2026): the database checks an LWF_<state> revision's parameters
-- as statutory/rule-packs.ts lwfDefinition reads them, as 0236 does for the other families: exactly stateCode (the pack code's state),
-- contributionMonths (1 to 12, whole, ascending, at least one) and slabs (1 to 50 objects of upTo, employee and employer; upTo a
-- decimal amount rising from slab to slab, null on the last; employee and employer decimal amounts). The seeds (LWF_MH, LWF_KA) are
-- written by ensureStatutoryPacks as drafts, as every pack is. Upgrade safety as 0236: added NOT VALID, validated when every stored row
-- satisfies it. Nothing stored is changed.

create function hrms_lwf_pack_parameters_ok(code text, p jsonb) returns boolean language plpgsql immutable as $$
declare
  s jsonb;
  i bigint;
  n integer;
  prev numeric;
  m jsonb;
  v_month numeric;
  prev_month numeric := 0;
begin
  if not hrms_statutory_keys_ok(p, array['stateCode', 'contributionMonths', 'slabs']) then
    return false;
  end if;
  if jsonb_typeof(p -> 'stateCode') is distinct from 'string' or (p ->> 'stateCode') <> substr(code, 5) then
    return false;
  end if;
  if jsonb_typeof(p -> 'contributionMonths') is distinct from 'array' or jsonb_array_length(p -> 'contributionMonths') = 0 then
    return false;
  end if;
  for m in select e.value from jsonb_array_elements(p -> 'contributionMonths') with ordinality e(value, i) order by e.i loop
    if jsonb_typeof(m) <> 'number' then
      return false;
    end if;
    v_month := (m #>> '{}')::numeric;
    if v_month <> trunc(v_month) or v_month < 1 or v_month > 12 or v_month <= prev_month then
      return false;
    end if;
    prev_month := v_month;
  end loop;
  if jsonb_typeof(p -> 'slabs') is distinct from 'array' then
    return false;
  end if;
  n := jsonb_array_length(p -> 'slabs');
  if n < 1 or n > 50 then
    return false;
  end if;
  for s, i in select e.value, e.i from jsonb_array_elements(p -> 'slabs') with ordinality e(value, i) order by e.i loop
    if not hrms_statutory_keys_ok(s, array['upTo', 'employee', 'employer']) then
      return false;
    end if;
    if i = n then
      if jsonb_typeof(s -> 'upTo') is distinct from 'null' then
        return false;
      end if;
    else
      if not hrms_statutory_amount_ok(s -> 'upTo', 4) then
        return false;
      end if;
      if prev is not null and (s ->> 'upTo')::numeric <= prev then
        return false;
      end if;
      prev := (s ->> 'upTo')::numeric;
    end if;
    if not hrms_statutory_amount_ok(s -> 'employee', 4) or not hrms_statutory_amount_ok(s -> 'employer', 4) then
      return false;
    end if;
  end loop;
  return true;
end $$;

alter table statutory_rule_pack add constraint statutory_rule_pack_lwf_parameters_check check (code !~ '^LWF_[A-Z]{2}$' or hrms_lwf_pack_parameters_ok(code, parameters)) not valid;

do $$
begin
  alter table statutory_rule_pack validate constraint statutory_rule_pack_lwf_parameters_check;
exception when check_violation then
  raise notice 'statutory_rule_pack_lwf_parameters_check is left NOT VALID: a stored row predates it';
end $$;
