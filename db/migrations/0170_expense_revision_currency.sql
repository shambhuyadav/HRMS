-- 0170 A revision is in its claim's currency (BR-022 "A claim uses one currency"; BRD line 1767; CI05 "batch, instruction, revision and
-- obligation currencies match"; line 81 "test direct data writes"). The service copies the claim's currency and refuses another, but
-- only it held the rule: a direct write could give a revision a currency of its own, and the obligation would then be refused or
-- follow that revision. A stored row that disagrees must not stop an upgrade and is not for a migration to correct, so it is kept and
-- the key stays NOT VALID, which still applies to every new or changed row.
alter table expense_claim add constraint expense_claim_company_id_id_currency_key unique (company_id, id, currency_code);

alter table expense_revision add constraint expense_revision_claim_currency_fk
  foreign key (company_id, claim_id, currency_code) references expense_claim (company_id, id, currency_code) on delete restrict not valid;

do $$
begin
  alter table expense_revision validate constraint expense_revision_claim_currency_fk;
exception when foreign_key_violation then
  raise warning 'expense_revision holds stored rows in another currency than their claim; they are kept, and expense_revision_claim_currency_fk stays NOT VALID';
end $$;
