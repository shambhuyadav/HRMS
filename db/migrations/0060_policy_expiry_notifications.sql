-- 0060 Company policy expiry notification recipients (DF12 "document expiry"; FR-010; FR-084; DF02).
-- POLICY_MANAGERS: the users who can currently manage the company policy a notice is about, i.e. an active, approved
-- assignment whose role ceiling ALLOWs and whose DB109 allowlist holds company_policy.manage for the policy's
-- classification (operational, plus the confidential group for a CONFIDENTIAL policy) from an unrestricted company
-- scope, as the policy publishing routes require. The dispatcher resolves them with the C1 access decision and checks
-- them again at delivery; a notification never grants access to the policy itself.
--
-- The selector list is extended rather than restated, so any selector another migration has added stays allowed.
do $$
declare
  allowed text[];
begin
  select array_agg(distinct v order by v) into allowed
    from (select m[1] as v
            from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([A-Z][A-Z0-9_]*)''', 'g') as m
           where c.conrelid = 'notification_rule'::regclass and c.conname = 'notification_rule_recipient_selector_check'
          union select 'POLICY_MANAGERS') s;
  alter table notification_rule drop constraint notification_rule_recipient_selector_check;
  execute format('alter table notification_rule add constraint notification_rule_recipient_selector_check check (recipient_selector = any (%L::text[]))', allowed);
end $$;
