-- 0118 Withdrawing an expense claim still in review (FR-074; DF03 "Withdraw only before a final decision"; C5; DF12).
-- C5 denied a submitted withdrawal "until decided"; Appendix F, which supersedes pending target wording on the topics it maps
-- (DF03 traces to C5), decided it. The claimant may withdraw at any step before the final approval commits; a decided claim
-- stays out of reach, since APPROVED, REJECTED and WITHDRAWN have no way out.
insert into transaction_transition (kind, from_state, to_state) values
  ('expense_claim', 'MANAGER_PENDING',    'WITHDRAWN'),
  ('expense_claim', 'FINANCE_PENDING',    'WITHDRAWN'),
  ('expense_claim', 'HIGH_VALUE_PENDING', 'WITHDRAWN');
