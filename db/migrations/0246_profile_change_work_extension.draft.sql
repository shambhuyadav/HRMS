-- 0246 The work phone extension in the employee's own profile change request (FR-059; DF04; DF16; I-89 item 5; decided under owner
-- delegation, 6 Nov 2026, docs/03 I-92). 0240 made the extension an operational work contact, changed under employee.update like the
-- work email, which the profile change request already covers. The request now accepts it too, under the same maker-checker route:
-- the employee asks, an HR reviewer from the explicit list approves, and approval applies it through the ordinary update path. A
-- request may also ask to clear it (JSON null). The database holds the value's format as 0240 does on the employee record (1 to 8
-- digits). Existing requests are unaffected: their keys are a subset of the new list.
-- To reverse: once no request names the field, restore the 0023 check (displayName and workEmail only).
alter table profile_change_request drop constraint profile_change_request_requested_check;
alter table profile_change_request
  add constraint profile_change_request_requested_check check (
    jsonb_typeof(requested) = 'object' and requested <> '{}'::jsonb
    and requested - array['displayName', 'workEmail', 'workPhoneExtension'] = '{}'::jsonb
    and (not requested ? 'workPhoneExtension'
         or jsonb_typeof(requested -> 'workPhoneExtension') = 'null'
         or (jsonb_typeof(requested -> 'workPhoneExtension') = 'string' and requested ->> 'workPhoneExtension' ~ '^[0-9]{1,8}$'))
  );
