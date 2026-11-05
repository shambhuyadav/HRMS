# 07 Register Templates

The schema constraint register, access matrix and verification register are generated, not written by hand: see `docs/registers/` and its README (`db/registers/generate.ts`). The tables below show their columns. The enforcement record and change record are kept here.

## Schema constraint register
| Table | Column | PK | FK | Unique | Nullability | Ref category | Interval rule | Company boundary | CI/ZT | Enforcement mechanism |
|---|---|---|---|---|---|---|---|---|---|---|

## Enforcement record (B8)

BRD line 4532: "The senior developer must record which enforcement mechanism implements each invariant and test direct data writes as well as application requests." Also B7 and line 81. Status 5 Nov 2026, with 0140-0146 live.
"Direct" means a test writes the row by SQL and the database refuses it; "API" means the rule is proved through application requests only. Those two words rest on which tests name each CI plus the ones read, not on reading every test, so read "Partly" and "API" as "not shown to be direct", not as a proven gap.

Mechanism key: **FK** composite foreign key; **CK** check constraint; **UQ** unique or exclusion key; **TR** before trigger; **DT** deferred constraint trigger, checked at commit; **LT** locked transaction in the service.

| CI | Invariant | Mechanism | Where | Proved by | Direct? |
|---|---|---|---|---|---|
| CI01 | Task, step, workflow, instance share company and workflow | FK | 0002 approval_task (line 154 note) | db/tests/workflow-constraints | Yes |
| CI02 | Instance pins the submitted revision; claim's current revision is its own | TR, FK | 0002 line 180; 0088 `expense_claim_current_revision_fk` | workflow-constraints; expense/payment-ledger | Yes |
| CI03 | Obligation belongs to the claim's approved revision; amount equals final line decisions | FK, TR | 0012 lines 275, 280 `expense_obligation_sum`; 0088 | expense/payment-ledger; expense/expense | Yes |
| CI04 | Line decision comes from the approval of its own claim revision; allowed never above claimed | TR | 0012 line 225 `expense_line_decision_check` | expense/expense line 676; expense/claim-evidence line 219 | Yes |
| CI05 | Allocation joins an obligation of the instruction's employee and currency | FK | 0012 line 371; 0088 | expense/payment-ledger | Yes |
| CI06 | Retry and reversal stay on the same party and never cycle; reversal bounded by confirmed | FK, TR | 0012 line 427; 0088 `payment_instruction_retry_same_party` | expense/payment-ledger | Yes |
| CI07 | Record's arrangement is the employee's; revision supersedes its own lineage, period and calendar, no cycle; lines bound to their head revision; a calculated record holds only segments in its own currency (rows stored before 0172 are reported by `db/pre-go-live-check.ts`) | FK, TR, DT | 0043 line 1009; 0140 `payroll_run_lineage_guard`, `*_head_binding`; 0172 `payroll_record_segment_currency`, `payroll_segment_record_currency` | payroll/lineage-guards; payroll/payroll-identity-rules | Yes |
| CI08 | Leave policy has the request's type; movement has the request's employee and type | FK | 0007 lines 144, 175; 0018 line 57 | leave/leave | API; FK refusal not written directly |
| CI09 | Grant identity, scope and approval fixed; filters typed; approver is the real actor | CK, TR | 0001; 0098; 0099 | db/tests/grant-guards; core-constraints | Yes |
| CI10 | Delegated task's assignee is the delegate; delegation live and permitted | FK, TR | 0002 line 247; 0090 | db/tests/delegation-guards; workflow/delegation | Yes |
| CI11 | Document and receipt files belong to the parent's employee | FK, TR | 0002 line 393; 0038 line 402; 0143 `expense_receipt_owner` | workflow-constraints; db/tests/decision-provenance | Yes |
| CI12 | One typed root per transaction; owner agrees with the root's employee; states agree whichever row was written | FK, DT, TR | 0002 line 83 `business_transaction_has_root`; 0142 `*_owner_agrees`, `business_transaction_state_agrees`, `*_transaction_fixed` | db/tests/typed-root-agreement; workflow-constraints | Yes |
| CI13 | One primary manager at an instant; no self, no cycle | UQ, CK, DT | 0001 line 238, `manager_assignment_no_cycle` | core-constraints; org/org-and-employment | Yes |
| CI14 | Dependent identities: feedback, settlement, timesheet line | FK | 0036 line 198; 0037 line 346; 0038 line 328; 0039 line 6 | timesheet/revision-rules; lifecycle/settlement | Partly |
| CI15 | Controlled states and codes | FK, CK, TR | 0001 line 138; 0002 `hrms_transaction_state_guard`; 0141 `hrms_state_path`; 0145 `currency` | core-constraints; db/tests/state-guards; db/tests/currency-reference | Yes |
| CI16 | Import counts reconcile to rows; a finished job's rows are final | TR | 0002 `hrms_import_job_reconcile`; 0141 `import_row_job_open` | workflow-constraints; state-guards | Yes |
| CI17 | Action and case share employee; action names a decision of its case; policy, start and initial due date retained | FK, TR | 0009 line 132; 0143 `confirmation_action_provenance`, `employee_confirmation_fixed` | decision-provenance; confirmation/confirmation | Yes |
| CI18 | Pinned template agrees; event subject is the transaction owner | FK, TR | 0010 line 51; 0143 `notification_event_subject` | decision-provenance; notification/notification | Yes |
| CI19 | Run's mapping belongs to its profile; observations reconcile; accepted event matches its punch | FK, CK, TR | 0014 lines 151, 193; 0141 `biometric_sync_run_final` | biometric/biometric; state-guards | Partly |
| CI20 | Case, history and salary share employee; basis and currency agree; preparer never applies | FK, TR | 0011 lines 175, 258; 0143 `increment_history_provenance` | decision-provenance; increment/increment; increment/correction | Yes |
| CI21 | Annual increment reconstructed from effective history | Service query over append-only history | 0011 line 220; report catalogue | report/increment-reports | API |
| CI22 | Confidential access needs eligibility, permission and row scope in one assignment | LT | access/authorize.ts `resolveAccess` | access/authorize; access/assigned-scope | API, by design: a read has no row to refuse |
| CI23 | One active dashboard definition per role and code; same-company parents | UQ, FK | 0013 line 22 | dashboard/wave2-dashboards | API |
| CI24 | Allowlist active only after approval; cross-assignment grants cannot combine | FK, TR, LT | 0001 line 464; 0099 | access/authorize; core-constraints; grant-guards | Yes |
| CI25 | Processed payroll is immutable; corrections reference it | TR | 0043 lines 677, 846, 1042 `payroll_run_guard`, `payroll_record_guard` | payroll/runs; payroll/chunks | Partly |
| CI26 | Adjustment shares employee and company; source revision unique | FK, UQ | 0129 line 50; 0037 line 14 | payroll-adjustments/payroll-adjustments | API |
| CI27 | Holds and reservations never exceed payable | TR, DT, LT | 0043 line 1566; 0045 line 428 | payroll/holds; payroll-outputs/bank | API |
| CI28 | Manifest count and control total equal its lines, in its currency | DT | 0045 line 297 | payroll-outputs/bank | API |
| CI29 | Submitted payload immutable; independent reviewer; apply once or CONFLICT | UQ, TR, LT | 0033 `employee_sensitive_change_guard`, `employee_private_profile_one_per_request`, exclusion on effective dates; sensitive-change/service.ts `deferredRecheck` | sensitive-change/sensitive-change; deferred-apply; history | Partly |
| CI30 | Issued output bound to owner, company, period and hash; own scope re-checked | FK, CK, LT | 0045 lines 23, 472; payslip routes | payroll-outputs/payslips | API |

Direct-write tests for the rows marked API or Partly are being added under gates-6 to 8 (`db/tests/direct-write-invariants.test.ts`); this column changes when those close. CI21 and CI22 are service or read rules with no row to refuse.

Later migrations add a row here when they add an invariant. This record maps invariants to mechanisms. It does not populate the column-by-column schema constraint register above, which would cover every column of 216 tenant tables and is better generated from the catalogue (gates-15).

## Access matrix
| Role | Resource | Action | Field group | Scope | Filters | Lifecycle restriction | SoD rule | Positive test | Negative test |
|---|---|---|---|---|---|---|---|---|---|

## Verification register
| ID (FR/BR/DQ/CI/ZT) | Synthetic fixture | Expected | Actual | Evidence | Tester | Date | Pass/Fail/Blocked |
|---|---|---|---|---|---|---|---|

## Navigation coverage (copy of Appendix A – statuses only Documented/Restricted/Not reachable)
| CL | Module → Page → Section → Tab | Evidence | Limitation | Status |
|---|---|---|---|---|

## Change record
| CR | Proposed deviation | Rationale | Affected IDs | Owner decision | Migrations/tests affected |
|---|---|---|---|---|---|
| CR-001…007 | See 02_completeness_inventory.md | | | Pending | |
