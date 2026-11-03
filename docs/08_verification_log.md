# 08 Verification Log

Evidence = automated test run on the developer machine. Environment: Windows 11, Node 24.19, PostgreSQL 17.10 (embedded binaries via `embedded-postgres`, ephemeral data directory). Synthetic fixtures only.
Command: `npx vitest run`. Latest result (24 Oct 2026): **6 files, 82 tests, 82 passed** (run 2: 68/68; run 1: 55/55).

These are **partial, layer-level** results. A gate (ZT) is complete only when every delivered resource, action and output passes it; none is complete yet.

| ID | What was verified | Test file | Result | Gate status |
|---|---|---|---|---|
| ZT06 / B1 | Cross-company FK rejected; referenced master delete rejected | db/tests/core-constraints.test.ts | Pass | Partial (tables in 0001/0002 only) |
| ZT07 / BR-001 | Duplicate/normalised employee code; import idempotency key replay | core, workflow | Pass | Partial |
| ZT08 / CI15 | Wrong reference category; non-catalogued state rejected | core, workflow | Pass | Partial |
| ZT09 / CI13 | Overlapping assignment/manager rejected; adjacent [from,to) accepted; manager cycle over overlap rejected; self-manager rejected | core | Pass | Partial |
| CI09 / C4 | ACTIVE assignment needs approver; approver ≠ beneficiary ≠ requester; scope filter exactly-one-typed-ref + no duplicates | core | Pass | Partial |
| CI24 / DB109 | Grant must be role-allowed, inside parent period, active only after parent approval | core | Pass | DB layer done |
| DF03 | Delegation ≤ 30 days, no self delegation, delegate cannot approve | core | Pass | DB layer done |
| DF08 | Employee physical delete refused; version system-managed; company_id immutable | core | Pass | Partial |
| CI12 | Transaction without typed root rejected at commit; second root rejected; unregistered kind rejected | workflow | Pass | DB layer done |
| ZT10 | Initial state required; only catalogued transitions; terminal final; instance/task states final | workflow | Pass | Partial |
| CI01 | Task step from another workflow rejected by FK | workflow | Pass | DB layer done |
| CI02 | Instance pins current revision; one ACTIVE instance; decision on superseded revision rejected | workflow | Pass | DB layer done |
| ZT04 | Decision by non-assignee, self decision (owner as assignee), foreign acting assignment rejected | workflow | Pass | Partial (payroll/payment SoD pending) |
| ZT11 (DB) | Stale expected version → 40001; second decision on a task rejected | workflow | Pass | Partial (true concurrent test pending) |
| ZT12 | Decision and audit append-only; audit before/after shape | workflow | Pass | Partial |
| CI10 | Delegated task assignee must equal delegate | workflow | Pass | DB layer done |
| CI11 | Employee document attachment must belong to same employee | workflow | Pass | Partial (receipts pending) |
| CI16 | Import job commit refused unless counts reconcile with rows | workflow | Pass | Partial |
| ZT01 / ZT02 | C1 engine: TEAM = current direct reports only; OWN; COMPANY + department filter; no cross-company; list predicate = detail check | apps/api/.../authorize.test.ts | Pass | Engine done; API surfaces pending |
| ZT03 / ZT29 / BR-044 | Ineligible role denied confidential even with grant; own salary denied; eligible manager needs DB109 grant | authorize | Pass | Engine done; surfaces pending |
| ZT05 | Revoked, expired, foreign assignment, inactive user, mid-session grant deactivation denied | authorize | Pass | Engine done; export/download pending |
| ZT30 / CI22 | No stitching of grants across assignments; F3 finance-duty Admin fixture | authorize | Pass | Engine done |

### Run 2: Employee API (apps/api/src/modules/employee/employee.api.test.ts, 13 tests, all pass)
| ID | What was verified at the HTTP surface | Result |
|---|---|---|
| FR-001 / DF10 | Missing/forged token → 401; token lifetime > 12 h → 401; missing company/assignment context → 400 | Pass |
| FR-006 / BR-001 / ZT07 | Create DRAFT employee + assignment + audit + outbox atomically; code normalised; duplicate → 409 | Pass |
| FR-004 | Inactive or other-company master → 422 | Pass |
| ZT12 / ZT11 | PATCH with stale expectedVersion → 409; success bumps version; audit before/after grouped by field group | Pass |
| ZT03 / ZT29 | Personal fields absent (keys not present) without grant; personal create without grant → 403 + ACCESS_DENIED audit | Pass |
| ZT02 / FR-094 (base) | Manager list = current direct reports, total matches; unrelated → 404 | Pass |
| BR-044 | Employee own record readable without personal fields; cannot list | Pass |
| ZT01 | Other company's employee → 404; assignment replayed with another company header → 403 | Pass |
| ZT05 | Assignment revoked mid-session → next request 403 | Pass |
| BR-006 | Department-filtered HR admin cannot create outside its department | Pass |

### Run 3: access administration, org masters, employment changes (14 new tests, all pass)
| ID | What was verified | Result |
|---|---|---|
| FR-067 / C4 / ZT04 | Pending grant gives no access; requester and beneficiary cannot approve; independent approver activates; second approval 409; stale version 409 | Pass |
| DF02 / BR-044 | Permission outside the role ceiling → 422; confidential grant to an eligible role needs a business purpose | Pass |
| C4 scope containment | Department-filtered administrator cannot propose or approve wider grants; can grant within its department | Pass |
| FR-068 / ZT05 | Rejection needs a reason and grants nothing; revocation ends access on the next request; history retained (both REVOKED rows listed) | Pass |
| BR-046 | Role selection (`/v1/me/assignments`) works without an assignment header; every other route still requires it | Pass |
| FR-004 / BR-004 | Master create (code normalised), duplicate 409, stale 409, deactivate (never delete), inactive hidden by default, inactive master unusable for new employee | Pass |
| FR-004 scope | HR reads but cannot maintain masters; filtered administrators cannot maintain company-wide masters | Pass |
| FR-003 / BR-002 / BR-005 | Manager change closes the prior period and opens a new one; history shows both; back-dating behind latest change 409; reporting cycle 422; inactive manager 422; removal needs reason | Pass |
| FR-006 / BR-002 | Transfer closes and opens assignment periods; change before joining date 422 | Pass |
| FR-089 (base) | Employment history needs `read_history`; manager without it 403 | Pass |

### Run 4: shifts, holidays, activation (7 new tests; suite 7 files, 89 tests, all pass)
| ID | What was verified | Result |
|---|---|---|
| FR-005 / DF05 | Default shift 09:00–18:00 with 60-min break = 540 elapsed / 480 net minutes; overnight 22:00–06:00 flagged spans-midnight = 480 elapsed | Pass |
| BR-008 | Zero-length shift, break outside shift, overlapping breaks rejected; failed creation leaves no partial rows | Pass |
| FR-005 | Holiday per location; duplicate date/type 409; unknown type 422 | Pass |
| DF04 activation | Missing work email/shift/manager-or-reason listed together; activation → ACTIVE_PROBATION; second activation 409; manager satisfies requirement; inactive shift unassignable; System Administrator cannot activate | Pass |

### Run 5: Leave module + generic workflow engine (11 new tests; suite 8 files, 100 tests, all pass)
| ID | What was verified | Result |
|---|---|---|
| DF05 / BR-010 | Seeded leave policies are DRAFT → requests blocked (POLICY_NOT_FOUND); independent activation; author cannot activate own policy | Pass |
| FR-025 / DF05 / F3 | Monthly accrual 24/12 = 2.0000 for a full month; joining month prorated 27/31 → 1.7419; sick/casual 0.5000 / 0.4355; rerun credits nothing | Pass |
| FR-025 / ZT07 | One opening balance per type with reason; duplicate 409; same-key replay no-op; balance = signed ledger sum | Pass |
| FR-026 / DF03 | Submission reserves units, routes to direct manager; non-permission 403, non-assignee 404; approval consumes once; replay of decision returns recorded outcome without a second effect | Pass |
| DF02 | Leave reason absent for manager and HR without a reason grant | Pass |
| FR-026 | Overlap with approved request refused; weekends and location holidays excluded from day count; holiday-only request refused | Pass |
| DF03 / ZT10 | Reject requires reason and releases reservation; withdrawal cancels task and releases; second withdrawal 409 | Pass |
| DF05 | Request beyond paid balance → INSUFFICIENT_BALANCE | Pass |
| DF03 / DF05 / ZT04 | Back-dated > 7 days routes to HR fallback; manager's own leave (no manager) routes to HR, never self; no eligible reviewer blocks with NO_ELIGIBLE_REVIEWER | Pass |
| ZT11 (true concurrency) | Two simultaneous requests on a 3-day balance: exactly one 201, one 422, balance 0; two simultaneous decisions on one task: one 200, one 409, one reservation release | Pass |

### Run 6: Attendance (23 new tests: 17 unit + 6 API; suite 10 files, 123 tests, all pass)
| ID | What was verified | Result |
|---|---|---|
| F6 thresholds (unit) | 8-h net shift: 360 = PRESENT, 361 PRESENT, 359 HALF_DAY, 240 HALF_DAY, 239 ABSENT; full day 09:00–18:00 = 480 after break | Pass |
| F6 grace (unit) | 09:10 on time with 10-min inclusive grace; 09:11 late; status unchanged by lateness; early departure flagged | Pass |
| DF05 punches (unit) | Missing IN/OUT, double IN, zero-length pair → EXCEPTION (never ABSENT) | Pass |
| DF05 precedence (unit) | Weekly off / holiday beat punches; full leave beats absence; half-day leave needs 50 %; no shift → EXCEPTION; overnight 22:00–06:00 = 450 | Pass |
| FR-022 | Employees without an ACTIVE policy listed (NO_POLICY), not guessed; default policy seeded DRAFT, activated independently | Pass |
| FR-020 (API) | Present/late/half-day/missing-punch/absent/weekly-off computed from imported punches; holiday and approved leave override | Pass |
| FR-022 | Rerun with unchanged inputs creates/updates nothing; late correction punch updates the same record once | Pass |
| FR-019 / DF09 / ZT07 | Identical replay counted as duplicate; same key with different content rejected as conflict; unknown employee and offset-less timestamp rejected; received = accepted + duplicates + rejected; one stored punch | Pass |
| FR-021 | Amendment needs reason and current version; trail lists old/new/reason; processing never overwrites an amended record | Pass |
| Scope | Employee sees own attendance only; cannot import or process | Pass |

### Run 7: Flexible confirmation (6 new tests; suite 11 files, 129 tests, all pass)
| ID | What was verified | Result |
|---|---|---|
| FR-080 / DF11 | Default 3 calendar months from 31 Jan → 30 Apr (month-end clamp); more specific 1-month intern policy → 28 Feb | Pass |
| FR-080 | Case only for probationers; one live case per employee (second → 409) | Pass |
| BR-030 / ZT22 | Overdue case stays OPEN (never auto-confirmed); only the current direct manager recommends; second recommendation while under review 409 | Pass |
| FR-081 / CI17 | Extension records prior 30 Apr → new 30 May; confirmation date after decision date refused with full rollback; RETURN reopens; confirmation sets actual date and employee ACTIVE_CONFIRMED; history EXTENDED → RETURNED → CONFIRMED | Pass |
| DF11 | Third extension refused (EXTENSION_LIMIT_REACHED) | Pass |
| ZT04 | HR administrator's own case routes to the next fallback reviewer, never to themselves | Pass |
| FR-082 | Employee sees only own case in detail and list | Pass |

### Run 8: Notifications (8 new tests; suite 12 files, 137 tests, all pass)
| ID | What was verified | Result |
|---|---|---|
| FR-084 / BR-033 | Submission notifies only the assigned reviewer; text carries type/dates/days, never the private reason; decision notifies the claimant with outcome | Pass |
| BR-034 | Replaying the whole outbox creates no duplicate notification | Pass |
| ZT18 | A rolled-back (refused) submission writes no outbox event | Pass |
| FR-085 / CI18 | Delivery re-checks authority: a reviewer whose task closed before delivery is SUPPRESSED (RECIPIENT_NOT_ELIGIBLE); the withdrawal notice is delivered | Pass |
| FR-085 | Read marks per recipient (others 404); delivery log needs its own permission and contains no message content | Pass |
| FR-083 / BR-032 / DF12 | Celebrations opt-in only; 29 Feb birthday observed 28 Feb 2027; text has name and department only (no date/year/age); same-day rerun creates nothing; optional opt-out suppresses for that recipient | Pass |
| FR-083 | Work anniversary from joining date (not on the joining day itself); separated employees excluded | Pass |
| CI18 | Template rendering allows approved placeholders only and blocks on a missing value | Pass |

Not built yet: email channel (DF12: needs real service configuration), reminder schedules (DF03 2/5 business days, DF11 30/7/1 days), 09:00 scheduler wiring for celebrations, retry ceiling for external channels.

### Run 9: Salary, increment cycles, history and annual growth (10 new tests; suite 13 files, 147 tests, all pass)
| ID | What was verified | Result |
|---|---|---|
| FR-091 / DF15 / BR-040 | Roster for 2027: effective 1 Apr, cutoff 30 Sep 2026; exclusions reported (joined after cutoff, not confirmed, on notice, no salary baseline); rerun creates nothing (ALREADY_IN_REVIEW) | Pass |
| BR-040 | A due review changes no salary until an approved decision | Pass |
| BR-044 | Case amounts hidden without the salary field grant; employee cannot read own increment history; HR without salary grant cannot read salary | Pass |
| FR-092 / CI20 / ZT25 | Manager proposes; roster preparer skipped as reviewer; independent HR approves; new arrangement from 2027-04-01 and old one closed; decision replay applies nothing again | Pass |
| DF15 | Off-cycle proposed by one HR, approved by the other | Pass |
| ZT26 / FR-090 / BR-039 | 100000 → 110000 → 121000: change amounts 10000 / 11000, two 10.00 % changes, annual growth FY2027 = 21.00 % (not 20) | Pass |
| BR-041 | Two pending cases on one baseline: first applies, second refused STALE_BASELINE with no extra arrangement | Pass |
| BR-041 | NO_CHANGE and REJECTED outcomes create no salary revision | Pass |
| DF14 | Zero baseline → percent N/A (ZERO_BASELINE) in history and annual growth | Pass |
| CI20 | Non-manager cannot propose; database refuses a history row applied by the case preparer | Pass |

Defects found and fixed: D-004 off-cycle insert reused one SQL parameter as uuid and text (42P08 → 500); D-005 decision response returned 4-decimal percentage instead of DF14's 2-decimal display.

Not built yet: anniversary-basis cycles, plan overrides with approval, increment components, locked-payroll arrears (needs payroll, wave 2), increment reminders.

### Run 10: Expense claims and payment tracking (11 new tests; suite 14 files, 158 tests, all pass)
| ID | What was verified | Result |
|---|---|---|
| FR-078 / DF06 | DRAFT policy blocks submission; independent activation; INR, 30-day window, 50,000 threshold | Pass |
| FR-071 / DF06 | Future date and unsupported currency refused; over-limit (MEALS 1,500 > 1,000/day), late (40 days) and missing receipt flagged and require reasons; flags recorded after explanation | Pass |
| FR-075 / BR-023 | Receipt reused from another live claim flagged DUPLICATE_SUSPECTED | Pass |
| FR-070 / BR-017 | Submitted claim cannot be edited | Pass |
| FR-072 / FR-073 / CI04 / F3 | Claimant cannot decide; manager approval → FINANCE_PENDING; finance must decide every line; reduction without reason and amount above claimed refused; 600 + 400 approved at 500 + 300 → one obligation 800, UNPAID | Pass |
| DF02 | Claimant sees receipt presence only, never its reference | Pass |
| DF06 / C4 | Total 50,000.00 approved after finance; 50,000.01 goes to a distinct high-value approver (finance approver excluded) | Pass |
| C4 / ZT04 | Manager's own claim routed to fallback; finance step then goes to someone other than the manager-step decider | Pass |
| C5 | Zero entitlement → APPROVED with NO_PAYABLE_AMOUNT and no obligation | Pass |
| FR-074 | Return needs reason; revision 2 created on edit; both submitted revisions retained | Pass |
| DF07 / ZT14 / ZT15 | Approve 1000 → prepare 600 → over-allocation refused → entitlement approver and preparer cannot release → released ≠ paid → confirmed (replay idempotent) → PART_PAID 600 → reverse 100 (excess reversal refused) → net 500 / outstanding 500 → pending 300 leaves exactly 200 → failure releases its reservation once | Pass |
| ZT07 / ZT11 | Same preparation key returns the same instruction; two concurrent 400 preparations on 400 remaining → one 201, one 422 | Pass |
| Scope | Claimant cannot prepare payments | Pass |

Defects found and fixed: D-006 submission wrote exception flags before validating reasons (generic RULE_VIOLATION instead of the reason list); D-007 decision endpoint rejected the 4-decimal amounts the API itself returns; D-008 (found in review, before tests) shared trigger function referenced a column absent from one table — split; D-009 (found in review) high-value threshold and outstanding were computed with JavaScript numbers — moved to SQL numeric. Test-data fixes: evidence keys shorter than the 8-character minimum; one test reused another claim's receipts (correctly flagged as duplicates).

Not built yet: receipt file storage/upload (ADR-07; metadata only), approved-claim correction/cancellation (DF06: disabled in wave 1), payroll payout route (wave 2), expense reports/ageing (FR-079 outputs).

### Run 11: My Team and role dashboards (9 new tests; suite 15 files, 167 tests, all pass; 55 s after test-infrastructure change)
| ID | What was verified | Result |
|---|---|---|
| FR-094 / BR-042 / ZT27 | My Team = current direct reports in active employment (probation/confirmed/notice); reassigned-away, separated and unrelated excluded; total stays 3 on an empty page 2; status filter | Pass |
| ZT27 / ZT01 | Former, unrelated, separated and other-company members return 404 by id | Pass |
| FR-095 / DF16 / BR-044 | Detail tabs: permitted tabs present, unbuilt tabs empty (not hidden), confidential tabs absent without the grant; personal grant adds private tab only; salary tab still absent without salary grant | Pass |
| FR-094 | Employee role cannot use My Team | Pass |
| FR-096 / DF17 | Dashboard labels role and scope; all 14 baseline roles get their own dashboard | Pass |
| BR-045 / ZT28 | Manager team count = My Team total; HR active-employee widget = sum of employee list totals for active statuses | Pass |
| F2 | Employee balance shows "Policy not active" before activation (no fabricated zero); today's attendance NOT_PROCESSED; unbuilt metric NOT_AVAILABLE | Pass |
| FR-097 | Widget whose permission is not active in the assignment is omitted (not zero) | Pass |

Test infrastructure: one embedded PostgreSQL per run with a migrated template; each file clones it (`CREATE DATABASE … TEMPLATE`). Same isolation, 255 s → 55 s.

### Run 12: Biometric API ingestion (11 new tests; suite 16 files, 178 tests, all pass; fake provider, no external calls)
| ID | What was verified | Result |
|---|---|---|
| FR-086 / BR-035 | Mapping missing EMPLOYEE_KEY refused; executable-looking path refused (INVALID_PATH); activation refused without approved mapping; credential/config references never returned; System Administrator without the explicit bundle has no API authority | Pass |
| FR-086 / DF13 | Two different provider schemas (nested JSON + coded direction; flat local-time) preview to the same canonical fields; preview writes nothing | Pass |
| C4 | Mapping author cannot approve; independent approver can | Pass |
| FR-087 / BR-037 | 3-page fetch: all pages read; 6 observations = 3 accepted + 2 rejected + 1 quarantined (unknown employee); 3 punches | Pass |
| ZT24 / BR-036 | Overlapping replay: identical event duplicate (no new punch); same key with different time quarantined CONFLICTING_PAYLOAD; original punch time kept | Pass |
| FR-087 | Unknown-employee event: reprocess refused until linked, then ACCEPTED once; second reprocess 409 | Pass |
| FR-088 / BR-037 | Page-2 failure → PARTIAL with checkpoint at p1; retry → missing event accepted, page-1 event duplicate; exactly 2 punches | Pass |
| FR-088 | Second concurrent run of a profile refused (RUN_IN_PROGRESS) | Pass |
| FR-088 / CI19 | Cross-company employee link refused; overlapping identity link refused | Pass |
| DF13 | Run without a configured provider adapter refused (PROVIDER_NOT_CONFIGURED) | Pass |
| BR-036 | America/New_York 2026-11-01 01:30 (DST overlap) quarantined AMBIGUOUS_LOCAL_TIME; 09:00 accepted | Pass |
| DF09 (no false absence) | Failed fetch covering the day → EXCEPTION PUNCH_SOURCE_UNAVAILABLE, not ABSENT; only a completed run covering the whole capture window (shift ± 4 h) restores normal evaluation | Pass |

Not built yet: real provider adapters (need private provider contracts, DF13), the 15-minute scheduler and nightly 7-day lookback wiring (DF09), sync-failure notification rule (event is queued), manual correction of ambiguous-time events.

### Run 13: Reports and exports (7 new tests; suite 17 files, 185 tests, all pass)
| ID | What was verified | Result |
|---|---|---|
| FR-056 / BR-026 / ZT17 | Request → QUEUED → worker → COMPLETED; employee register row count = employee list total; header row; not-ready download 409 | Pass |
| FR-065 | Formula-like text (`=HYPERLINK(…)`, `-5`) written with a leading apostrophe; quotes doubled; `no-store` caching | Pass |
| BR-006 | Department-filtered exporter receives only its department | Pass |
| FR-056 | Period reports require a valid from/to period | Pass |
| ZT03 / BR-044 | Increment history export needs `increment.export.salary`; expense register needs the finance-duty bundle; manager cannot export the employee register | Pass |
| ZT05 | Access revoked between request and generation → FAILED ACCESS_REVOKED, nothing generated | Pass |
| ZT05 / BR-046 | Completed output: another user 404; same user under another assignment 403; export grant deactivated 403; expired 410 and status EXPIRED | Pass |

Defects found and fixed:
- D-010 (confidentiality, found in review): HR Administrator default duties included `expense.read` with company scope, exposing every claim amount contrary to DF02. Moved into the finance-duty bundle (`EXPENSE_FINANCE_ADMIN`); expense tests now grant it explicitly to finance actors.
- D-011: migration 0002 constrained `report_code` to lower case, unlike every other business code; aligned to upper case in 0015.

Not built yet: XLSX/PDF formats (FR-056: report-specific, need approval), scheduled reports (disabled by DF09), purge of expired outputs, payroll/statutory reports (wave 2).

### Run 14: Sessions, reminders/escalation, scheduler (5 new tests; suite 18 files, 190 tests, all pass)
| ID | What was verified | Result |
|---|---|---|
| DF10 | Every token names a server-side session; 31 minutes idle → 401 SESSION_IDLE; sign-out → next request SESSION_REVOKED; past absolute expiry → SESSION_EXPIRED; token bound to another user's session → SESSION_WRONG_USER | Pass |
| DF03 | Pending task ≥ 2 business days → one reminder to the assignee (rerun adds none); ≥ 5 business days → one escalation to the fallback list; task stays PENDING | Pass |
| DF11 / BR-031 | 7 days before due → one reminder each to manager and HR fallback (rerun adds none); 14 days overdue → weekly overdue reminder naming the overdue days | Pass |
| DF09 / DF12 | Scheduler ledger: before 08:00 local nothing runs; at 10:00 reminders and celebrations run once; a later tick the same day runs nothing; outbox drained by the tick | Pass |

All 185 earlier tests were re-run on session-bound tokens (the employee API test now uses the shared harness).

Fixture note: ageing a task in a test bypasses triggers for that one statement (`session_replication_role = replica`), because creation metadata is immutable by design; no product rule was relaxed.

Scale note: the PostgreSQL session store throttles `last_seen` writes to once a minute per session; at NFR-S01 volume this must move to the session cache (ADR-05).

### Run 15: Web frontend, development seed, end-to-end smoke (API 19 files / 195 tests; web 6 tests; all pass)
| ID | What was verified | Result |
|---|---|---|
| BR-046 (client) | Every request carries token + selected company + assignment; only role selection omits the assignment | Pass |
| DF10 (client) | 401 (e.g. SESSION_IDLE) signs the user out; status badges always carry text | Pass |
| Build | `tsc` (web) and `vite build` succeed; bundle 234 kB (74 kB gzip) | Pass |
| Seed / smoke (in-process) | Dev sign-in, role list, `/me/context`, `/me/permissions`, dashboard, balances, claims, My Team (2), employees (3), report catalogue, finance task queue; unknown account 401; reseeding is a no-op | Pass |
| Smoke (real HTTP) | Embedded dev DB + seed + API server: manager signs in, has two roles, team dashboard TEAM_COUNT = 2, My Team = 2 synthetic reports, employee list scoped to the 2 reports; no tokens in server logs | Pass (manual run, servers stopped afterwards) |

Defect found and fixed: D-012 two React versions installed (React 19 hoisted by an earlier partial install while the app requires 18) — would have broken the production bundle at runtime; pinned via npm `overrides` and lockfile regenerated; all suites re-run green.

UI gaps (not built yet): finance-step line decisions in the decision inbox (the API refuses a finance approval without line amounts and the UI shows that error), payment screens, confirmation/increment management screens, access administration screens, receipt upload (needs object storage). The UI was not exercised in a real browser in this run.

Follow-up: `getConfirmation` filters the scoped list in code; replace with a single-case query (performance, not correctness).

New DB rule in 0005: a REVOKED assignment must carry a decision reason. Two earlier tests revoked via SQL without a reason and were updated to supply one; the rule itself stays strict.

### Run 16: Finance line decisions and payment screens (API 19 files / 197 tests; web 6 tests; all pass)
| ID | What was verified | Result |
|---|---|---|
| DF03 (API) | Payables list reconciles approved, net paid, pending and allocatable amounts per claim; instructions list per claim (both `payment.read`, scope predicate) | Pass |
| DF03 (API) | With two pending claims, each finance task names its own claim (`claimId` mapped by transaction) | Pass |
| UI | Finance step shows per-line allowed amount + reason; payments screen prepares, releases, confirms/fails (evidence key ≥ 8 chars) and reverses with inline amount + reason | Typecheck + build pass; not exercised in a real browser |

### Run 17: Employee documents and bulk employee import (API 21 files / 207 tests; web 7 tests; all pass)
| ID | What was verified | Result |
|---|---|---|
| FR-010 / DF02 | Default HR duties cannot upload or list documents (confidential `document` group, ceiling only); with the grant, upload stores by SHA-256 content reference, list returns metadata only (no reference or checksum), expired documents stay listed and flagged | Pass |
| FR-057 | Each document content read writes a `READ_CONTENT` audit event; response is `no-store`, `nosniff`, attachment disposition | Pass |
| File safety | Content sniffing accepts PDF/JPEG/PNG only, whatever the file name; unknown document type rejected | Pass |
| ZT tenancy | Another company's employee, document and import job return 404 | Pass |
| FR-009 / DF09 | Preview validates every row through the real create path inside a rolled-back transaction: duplicate within the file, unknown department and impossible date rejected per row with codes; nothing is created before commit | Pass |
| FR-009 | Commit applies only VALID rows, re-validated; a row made invalid after preview is rejected at commit; counts reconcile with rows (DB trigger); repeat commit is idempotent; same idempotency key returns the same job; cancelled/committed jobs cannot change state | Pass |
| DF02 | Import header must match exactly; personal columns (e.g. date of birth) are refused; a manager without the import duty gets 403 | Pass |
| CSV | Quoted values, escaped quotes, CRLF, BOM; unterminated/misplaced quotes rejected | Pass |
| UI | Import page uploads, shows row preview with problems and offers to create only valid rows (jsdom test); documents page per employee (typecheck + build only) | Pass |

Defects found and fixed: D-013 import date check used `Date.parse`, which rolls 2026-02-30 over to March, so the row would have reached the database as a generic error; replaced by a strict round-trip check. D-014 three web source files were double-encoded by a shell edit (`—`, `←` corrupted); found by the amount-format test, repaired byte-exactly, all suites re-run green.

Design notes: file bytes are stored outside the database behind the `FileStore` interface (ADR-07; memory in tests, local directory in development, S3-compatible store required in production — the app refuses to start in production without one). The stored import file, verified against its checksum, is the only source of row values at commit. The 5,000-row and 2 MB import limits are technical batch limits, not business rules. One neutral `GENERAL` document type is seeded because the BRD names no catalogue.

### Run 18: Expense receipt upload and confidential receipt viewing (API 21 files / 209 tests; web 7 tests; all pass)
| ID | What was verified | Result |
|---|---|---|
| DF06 | Claimant uploads a receipt first (content-sniffed PDF/JPEG/PNG, ≤ 10 MB) and attaches it by id; a fake file is refused; a receipt uploaded by another employee is refused (`INVALID_RECEIPT`) | Pass |
| BR-021 | Duplicate suspicion now fires both for a re-uploaded identical file and for re-using the same uploaded receipt on another live claim | Pass |
| DF02 / FR-057 | Receipt content needs the confidential `expense.view_receipt.receipt` grant plus row scope: claimant 403, manager with default duties 403, manager with the grant 200 (bytes match, `no-store`), out-of-team manager 404; each read audited `READ_CONTENT` | Pass |
| Regression | All existing expense tests pass with real uploaded receipts instead of client-supplied references; claim views never expose references or checksums | Pass |
| UI | Claim form uploads a receipt per line; reviewers with the grant see a View action (typecheck + build; not exercised in a real browser) | Pass |

Defect found and fixed: D-015 the claim API accepted a client-supplied receipt reference and checksum, so a claimant could attach a file that was never uploaded or name another user's file, and re-using one stored file across claims escaped duplicate detection (the check required two different attachment rows). Receipts are now server-side uploads bound to the claimant; the duplicate check compares checksums across other live claims regardless of attachment row.

### Run 19: Leave resubmission and cancellation of approved leave (API 22 files / 214 tests; web 7 tests; all pass)
| ID | What was verified | Result |
|---|---|---|
| DF03 (I-03) | Return releases the reservation; resubmission with a stale version is refused (409); resubmitted request becomes revision 2 with new dates, a new reservation (pending 2 → 0 → 1 day) and a new approval instance (prior RETURNED, new ACTIVE); both revisions kept in `leave_request_revision`; only RETURNED requests can be resubmitted | Pass |
| FR-026 / DF03 (I-01) | Approved leave cannot be withdrawn; cancellation needs a reason and leaves the leave APPROVED until decided; a second open cancellation is refused; RETURN refused for cancellations; approval is idempotent on replay; leave becomes CANCELLED, ledger keeps CONSUMPTION −3 and adds REVERSAL +3, taken balance drops by 3; the dates become free for a new request; an approved-cancelled leave cannot be cancelled again | Pass |
| FR-026 | Rejected cancellation leaves the leave approved and the balance unchanged; a new cancellation may follow | Pass |
| DF05 (I-02) | Cancelling leave that started 14 days ago routes to the HR fallback list, not the manager | Pass |
| C1 / CI | Manager cannot cancel an employee's leave (403); another employee gets 404; the database refuses CANCELLED without an approved cancellation (deferred trigger, 23514) | Pass |
| FR-084 | Reviewer receives "cancellation waiting" and the employee "cancellation APPROVED" in-app notifications with operational fields only | Pass |
| Dev seed | Re-running the seed re-provisions an existing dev company to the current baseline (idempotent; smoke tests unchanged) | Pass |
| UI | Own requests show "Correct and resubmit" (returned) and "Cancel leave" (approved); decision inbox labels cancellations and hides Return for them (typecheck + build only; not exercised in a real browser) | Pass |

Test-isolation fixes: two new tests initially picked "the first pending task" and so acted on another test's request; they now match tasks by transaction id. No product code changed for this.

Known limitation (I-04): attendance days already evaluated before a cancellation are not re-evaluated automatically.

### Run 20: Outdoor duty and work on holiday (API 23 files / 222 tests; web 7 tests; all pass)
| ID | What was verified | Result |
|---|---|---|
| FR-027 (I-05, unit) | Full-day duty gives ON_DUTY on a working day even with an incomplete punch; holiday and full leave keep precedence; timed duty 09:00–13:00 + punches 14:00–18:00 = 480 → PRESENT; duty alone 240 → HALF_DAY (never ABSENT); overlapping duty and punches counted once (480, not 600) | Pass |
| FR-027 (I-05, API) | Approved full-day duty on a past Tuesday → ON_DUTY after processing, while a colleague without punches is ABSENT; rerun changes nothing; no leave movement created; a second live request for the day is refused (409) | Pass |
| FR-027 | Timed duty is ignored until approved (HALF_DAY 240), then the same day re-processes to PRESENT 480 | Pass |
| FR-027 validation | Weekend-only outdoor duty refused (NO_WORKING_DAYS); timed request across days, end before start, or one time only refused; outdoor duty overlapping a leave request refused (OVERLAPS_LEAVE) | Pass |
| FR-027 (I-06) | Holiday work on a working day refused (NOT_AN_OFF_DAY); multi-day refused; approved Saturday work creates no leave movement and appears in the HR view with its times | Pass |
| DF03 / DF05 (I-07) | Past requests (> 7 days) route to HR, future ones to the direct manager; return → resubmit gives revision 2 and a new task; withdrawal cancels the open task | Pass |
| FR-084 | Reviewer notified with kind and dates only (purpose not included) | Pass |
| Scope | Manager reads the team member's requests; another employee gets 404 and sees only own rows in the HR view; an employee has no decision queue (403) | Pass |
| UI | Outdoor & holiday work page (submit, own list with withdraw, scoped register by kind and dates); decision inbox queue (typecheck + build only; not exercised in a real browser) | Pass |

Not built: supporting evidence files on work requests (I-07); cancellation of approved outdoor duty or holiday work (no controlled reversal yet — approved requests stay approved).

### Run 21: Private reasons made confidential; access-administration pickers (API: confirmation 6, attendance, access 29 tests pass)
| ID | What was verified | Result |
|---|---|---|
| DF02 / DF11 (D-016) | Confirmation case history: default HR duties, the direct manager and the employee get the actions (dates, outcomes) without reasons; only an assignment granted `confirmation.read.reason` sees them | Pass |
| DF02 / BRD "attendance … detail excludes private reasons" (D-016) | Attendance amendment trail: default HR and the employee get old/new status without the reason; `attendance.read.reason` grant shows it | Pass |
| FR-066 | `GET /v1/access/roles`: every role with its ceiling sorted by key, each permission's classification (missing policy = confidential, as proposal decides) and default-duty flag; `confirmation.read.reason` listed as confidential, ceiling-only | Pass |
| FR-066 / C4 | `GET /v1/access/users`: linked and assignment-only users of the company with active/pending counts; operational identity fields only; never another company's users; search by code or account key is case-insensitive with `%`/`_` literal; paging keeps the total; page size above 100 refused | Pass |
| C4 / DF02 | A department-filtered administrator sees only users of employees in that department and no unlinked accounts; the duty outside company scope, a manager and an employee get 403 | Pass |

Defect found and fixed: D-016 confirmation action reasons and attendance amendment reasons were returned to anyone with the operational read duty, including the employee concerned (run 6/7 code). They are now separate confidential `reason` field groups (migration 0020), in the HR Administrator and Reporting Manager ceilings only, never default duties.

### Run 22: Audit trail read/export and retention controls (FR-058; audit-trail 8 + report 7 tests pass)
| ID | What was verified | Result |
|---|---|---|
| FR-058 acceptance (I-08) | An employee and HR (no audit duty) get 403; an auditor gets the trail; a department-filtered auditor gets 403 | Pass |
| FR-058 / DF02 (I-08) | An employee creation event shows resource, record, actor, acting role, value groups `operational, personal` and operational field names, but neither the work email nor the birth date value | Pass |
| Tenancy / paging | Another company's events never appear; paging keeps the total | Pass |
| FR-058 / DF09 (I-08) | Audit export needs `audit.export` (an auditor without it and HR holding ordinary exports get 403); period over 31 days refused; the execution records requester, acting assignment, scope snapshot and time; the CSV has field names and record ids but no values; another user cannot download it | Pass |
| DF08 (I-09) | Without an active rule nothing is eligible and `purgeEnabled` is false; a rule is activated only by someone other than its author | Pass |
| FR-058 acceptance (I-09) | Dry run with three 10-day-old events and a 1-day rule: 3 eligible; a pending hold protects nothing; the hold requester cannot decide it; an approved hold on one record leaves 2 eligible / 1 held; a whole-kind hold leaves 0 / 3; releasing it restores 2 / 1; a rejected hold protects nothing; no event is deleted | Pass |

Not evidenced: an actual purge (disabled by DF08 until an approved retention schedule exists).

### Run 23: Self-service change requests and reviewer-routing administration (FR-059, DF03; self-service 6 tests pass)
| ID | What was verified | Result |
|---|---|---|
| DF03 (I-10) | Routing list per kind with steps; profile changes use their own list, attendance corrections the leave list; a non-eligible reviewer, duplicate entries and shared kinds are refused; changes are audited; employees get 403 | Pass |
| FR-059 / DF04 (I-11) | Confidential fields cannot be requested; unchanged or invalid values refused; one open request at a time; the record is unchanged until approval; the reviewer sees requested and current values; the employee and an unassigned HR user cannot decide; approval applies through the update path (audited as the reviewer); rejection and withdrawal leave the record unchanged; another employee cannot see or withdraw the request | Pass |
| FR-059 / DF03 (I-12) | Another employee cannot request a correction of someone else's record; the direct manager gets the task without the private reason; approval amends the record (trail attributed to the manager) and later processing keeps it; the reason is visible only with `attendance.read.reason`; rejection changes nothing; withdrawal clears the task; employees have no decision queue | Pass |
| FR-084 | Reviewer and employee notifications carry field names, dates and statuses only — never requested values or reasons | Pass |

Platform note found while testing: request schemas with `additionalProperties: false` drop unknown fields (Fastify default) rather than rejecting them; unknown fields are therefore ignored, never applied.

### Run 24: Shift-plan imports and mobile-app links (FR-023; plan import 4 + mobile link 4 tests pass)
| ID | What was verified | Result |
|---|---|---|
| FR-023 / DF09 (I-13) | Template SHIFT_PLAN_V1 preview changes nothing; commit applies every row through the ordinary effective-dated shift change (history kept); repeat commit is idempotent | Pass |
| FR-023 acceptance / DF09 | A batch with any invalid row is rejected whole with row codes: before joining, employment ended, unknown employee, unknown shift, impossible date, wrong cell count, and the valid row marked BATCH_REJECTED; commit refused; nothing applied | Pass |
| DF09 | A row made invalid before commit (a later shift change recorded meanwhile) rejects the batch at commit with CHANGE_NOT_LATEST; no row of the batch is applied | Pass |
| C4 (sec-2 pattern) | Jobs belong to their submitter: another HR user gets 404 for view, commit and cancel, and 409 for reusing the key; the same submitter gets the same job; a department-filtered importer gets OUT_OF_SCOPE for rows outside the filter; employees get 403; wrong header refused | Pass |
| FR-023 acceptance (I-14) | A link exists only after review; the employee cannot decide; one pending request per employee; stale version refused; the requester cannot decide; an HR user cannot decide their own employee's link; an app account linked to one employee cannot be linked to another | Pass |
| FR-023 (I-14) | Re-linking needs the same review; the previous link stays active while pending and is revoked only on approval; revoke needs a reason and happens once; employees cannot see or request links for others | Pass |

### Run 25: Baseline moved to BRD v8.2; H1 Employee OWN exception; concurrency and import fixes (test-first)
Baseline: `HRMS_AI_Developer_Master_Prompt (3).md` = BRD v8.2 (CR-017). Earlier runs used v8.1 text; the v8.2 delta is Appendix H (FR-099–FR-110, BR-047–BR-055, DB110–DB118, CI25–CI30, ZT36–ZT40) and the H1/BR-053 Employee OWN ESS exception.

| ID | What was verified | Result |
|---|---|---|
| H1 / BR-053 (I-16) | Employee in OWN context now reads own permitted private values (birth date) and the reasons they submitted (leave, attendance correction); HR without a personal grant still does not see another person's birth date; a manager without the reason grant does not see the reason; HR-authored amendment notes stay hidden from the employee; confirmation reasons stay reviewer-only; the role catalogue marks exactly the Employee own-ESS permissions (`ownEss`) and no other role | Pass |
| data-1 (critical) | Two-connection race: a withdrawal arriving while a resubmission is in progress now waits, then withdraws revision 2 and releases its reservation (pending 0, available restored). Before the fix the verifier's reproduction left revision 2's reservation held forever | Pass |
| data-7 | Decision racing a withdrawal (leave and outdoor duty): one succeeds, the other gets 409; no deadlock 500 (before: 500 INTERNAL after the deadlock timeout) | Pass |
| data-3 / brd-4 (I-05) | Leave on an approved outdoor-duty day is refused (OVERLAPS_OUTDOOR_DUTY), the reverse still refused; both checks share a per-employee lock | Pass |
| data-2 / brd-1 / brd-13 (DF09, I-13) | Employee import is all-or-nothing: a batch with duplicate, unknown-reference, impossible-date or wrong-cell-count rows is REJECTED at upload with row codes (others BATCH_REJECTED) and creates nobody; a clean batch commits every row; a row invalid at commit rejects the batch and creates nobody; 10,001 rows refused | Pass |
| sec-2 / sec-3 | Import jobs belong to their submitter (another HR user: 404 for view/commit/cancel, 409 IDEMPOTENCY_KEY_IN_USE for the key, no file name leaked); stored import files are CONFIDENTIAL | Pass |
| brd-15 / web-3 | A resubmitted leave keeps the earlier private reason unless a new one is given; a new reason replaces it; both revisions recorded | Pass |
| brd-11 | Cancellation without a reason 400, whitespace-only refused | Pass |
| sec-4 | Another reviewer's cancellation task reads 404 for every decision | Pass |
| web-5 (API) | Leave and work-request decision queues return what each task decides (type, dates, units/times, purpose) | Pass (API; UI by the web fixer) |
| DF02 | Increment decision reasons need their own `increment.read.reason` grant; salary amounts alone no longer carry the approver's free text | Pass |
| C4 (access screen review) | Grants list limited to company-scope administrators and their filters; grants show their own scope filters and account keys; a grant that ends before it starts is refused (INVALID_PERIOD); session context names the user | Pass |

### Run 26: Sensitive private-profile changes, My ESS index, module registry (FR-103, FR-104, FR-105; 25 Oct 2026)
Tests: `sensitive-change.api.test.ts` 8, `field-crypto.test.ts` 5, `ess.api.test.ts` 4, plus the affected shared suites (access 4 files, dashboard, dev 2 files, worker, self-service, notification 3 files): all pass. Three deliberate mutations (base-revision check removed, bank always shown in full, row scope removed from the request list) each made a test fail and were reverted.

| ID | What was verified | Result |
|---|---|---|
| FR-104 / H2 / BR-054 | ADDRESS draft → submit → reviewer starts review → approve: the approved values stay unchanged until approval, then exactly one DB116 revision is appended (revision 1, effective today); approval without a reason, or before the review is started, is refused; a submitted request cannot be edited; a second open request for the same category is refused | Pass |
| FR-104 (I-18) | Unknown field, invalid email, impossible date, unchanged value, clearing a required field, past effective date, non-alphanumeric account identifier: each refused with its own code | Pass |
| FR-105 / H3 TN03 | A BANK change needs evidence; another employee's document is refused as evidence; leading zeros are kept; the employee's own view is masked (••••6789), an eligible HR Admin with the bank grant sees the full value; the reviewer sees the previous account masked and the proposal in full | Pass |
| H2 return / revise | RETURN needs an employee-visible message; the employee sees the message but never the reviewer's private note; revise creates a new draft that supersedes the returned request (only once) | Pass |
| H2 conflict | An Admin's direct birth-date change after submission makes the approval end in CONFLICT with no overwrite and no revision; the rebased request shows the new before-value and applies cleanly | Pass |
| H2 scheduled | A future-dated approval is SCHEDULED; the daily job applies it on the effective date only, once; the earlier revision's interval closes on that date | Pass |
| H2 withdraw | The employee withdraws a request under review; the reviewer's task closes (409 TASK_CLOSED) | Pass |
| H1 / BR-053 / BR-055 | Altered identifiers (another employee's private profile or requests) read 404; an HR Admin without the confidential grant gets 403 (audited); an HR assignment cannot submit own-ESS requests (403) | Pass |
| H4 protected payload | Proposed and approved values are stored only as AES-256-GCM envelopes bound to company, employee and row; audit records and outbox payloads carry field names, not values; envelopes moved to another row, owner, company or purpose, tampered or truncated, fail to open; key rotation opens old envelopes; production refuses to start without keys | Pass |
| FR-103 / H3 | `GET /v1/me/ess` lists TN01–TN18 in H3 order with the own-record context; built tabs AVAILABLE with own-record links only; payroll, Form 16, tax, investment proof, loan and asset tabs UNAVAILABLE with a named reason and no links; a switched-off duty shows NOT_PERMITTED; a non-Employee assignment gets 403 EMPLOYEE_CONTEXT_REQUIRED | Pass |
| H1 (D-018) | `/v1/me/permissions` lists the Employee OWN assignment's own-ESS groups and no other confidential group | Pass |
| I-16 (D-019) | A re-seed gives the Employee OWN assignment its own-ESS default duties, as a fresh seed does, and no other confidential group | Pass |
| FR-109 / H3 | `GET /v1/me/requests` lists the employee's own requests of every kind with state, pending reviewer and per-step decisions; the reviewer's note never appears; another employee sees none of them; a non-Employee assignment gets 403 EMPLOYEE_CONTEXT_REQUIRED (`ess.api.test.ts`) | Pass |
| FR-009 update import (DF09, I-13) | Template EMPLOYEE_UPDATE_V1 (`update-import.api.test.ts`, 4 tests): the preview shows each row's proposed changes (field from/to, operational values only) and changes nothing; commit renames, closes and opens the assignment period on the effective date and sets the manager; one bad row (unknown employee or master or manager, repeated code, nothing to change, missing effective date) rejects the whole batch and nothing applies; a department-filtered HR user's out-of-scope rows are OUT_OF_SCOPE; jobs are private to the submitter, keys cannot be reused by another user, a wrong header is refused. Existing onboarding and shift-plan imports unchanged (22 tests) | Pass |
| DF11 exceptions (I-19) | `exceptions.api.test.ts` (4 tests): a due-date override changes nothing until a different HR user approves it, then becomes the due date with an audit entry; the proposer cannot approve; a second open proposal is refused; the private justification shows only with the confirmation reason grant; a date before joining, an unchanged date, a case under review and self-action are refused; two extensions then EXTENSION_LIMIT_REACHED, one approved exception allows exactly one more; only the proposer can withdraw. Existing confirmation tests unchanged (6) | Pass |
| FR-106 (I-21) | `documents-quarantine.api.test.ts` (5 tests): the employee uploads and reads own released documents and gets 404 for a colleague's; a file carrying the EICAR test string is QUARANTINED, unreadable by anyone (409 FILE_NOT_RELEASED), unverifiable, audited, and the database refuses to release it; with the scanner unavailable a file stays PENDING_SCAN and unreadable until a later scan releases it; verification needs the grant, someone other than the uploader, a note to reject, and is final; the employee sees the verdict but not the note; a quarantined receipt cannot be attached to a claim; the claimant reads their own released receipt, a colleague gets 404. Sensitive changes: approval without verified evidence is refused (EVIDENCE_NOT_VERIFIED) | Pass |
| FR-027 evidence (I-22) | `work-request/evidence.api.test.ts` (3 tests): the requester links own released documents; the assigned manager reads them through the evidence route without any document grant (the general document route still refuses), the requester too; a colleague, an unassigned manager and an unlinked document get 404; reads are audited; another person's document and a quarantined file are refused; a resubmission carries the evidence to revision 2 and both revisions keep their links. Sensitive-change evidence: reviewer and owner read it, a colleague gets 404, HR without the grant 403 | Pass |
| Registry | Draft migrations are applied only when named in HRMS_DRAFT_MIGRATIONS; modules being built are inactive unless named in HRMS_DRAFT_MODULES (never in production); every transaction kind is classified for the dashboard through its registration; the daily scheduler runs the private-profile job from 00:00 and the ledger shows 3 daily runs | Pass |

### Run 27: Wave-2 modules active, platform hardening, UTF-8 test cluster (26 Oct 2026)
Full API suite on the new UTF-8 / ICU root-collation test cluster, before any of the day's relaunched agents changed code: 71 files passed and 6 skipped (the payroll draft), 616 tests passed and 42 skipped (all payroll). Web suite: 13 files, 279 tests; both typechecks clean. Evidence retained in the session scratchpad (`full-api-1310.txt`). Active registry modules: sensitive-change, hiring, lifecycle, appraisal, timesheet, assets, training. Second baseline on 27 Oct with the payroll core active as well: 80 files and 696 tests, all passing once the weekday test defect D-030 was fixed (evidence `full-api-1027.txt` plus the re-run of the four affected files); web 15 files, 396 tests. Each new platform check below was mutation-tested: with the check disabled its tests fail, and they pass again once it is restored.

| ID | What was verified | Result |
|---|---|---|
| Test cluster encoding | Test databases are created UTF-8 with ICU root collation on every platform; the Devanagari and emoji file-name download test, previously skipped on the single-byte Windows default, now runs | Pass |
| NFR-S10 / ADR-14 | A statement, lock or idle-in-transaction timeout, too many connections, the pool's wait timeout and a dropped connection each answer 503 `UNAVAILABLE` with `Retry-After: 5` and no cause; any other failure stays a 500 without driver detail (`errors.api.test.ts`) | Pass |
| Cache safety | Every `/v1` answer, success or failure, carries `cache-control: no-store`; `/health` does not (`errors.api.test.ts`) | Pass |
| NFR-S11 logs | Request log lines carry the route pattern, never the raw URL, search terms, tokens, row values or the client address (`errors.api.test.ts`, captured log stream) | Pass |
| docs/09 §6.5 decisions (I-25) | A decision whose DB109 entry was withdrawn, whose assignment was revoked or whose user was deactivated after the route guard ran is refused with 403 and records nothing; an unchanged decider still decides (`workflow/decision-recheck.api.test.ts`, 4 tests) | Pass |
| docs/09 §6.5 payments (I-25) | An expense payment release under authority withdrawn after the route guard is refused and the instruction stays PREPARED; with the authority restored the release succeeds (`expense.api.test.ts`) | Pass |
| DF03 reviewer scope (I-25) | A fallback reviewer whose row scope does not cover the employee is skipped and the next one routes; with nobody left, submission is refused NO_ELIGIBLE_REVIEWER and nothing is created (`workflow/reviewer-scope.api.test.ts` 3 tests; `assets.api.test.ts` updated from the old routed-to-unreachable behaviour) | Pass |
| FR-027 evidence | The reviewer's work-request task names its request (`summary.requestId`); the web opens evidence through it without reading the requester's request list (`evidence.api.test.ts`, `work.test.tsx`) | Pass |
| FR-040–FR-044 (I-23, I-24) | Independent appraisal review: 4 files, 23 tests; weights total exactly 100, scores 1–5, the F1 weighted result exact at 2 decimals, C4 on both reviewer levels, own appraisal never shows ratings in any context, export refuses above 10,000 rows instead of truncating; three mutation spot checks each caught | Pass |
| Web DF11 exceptions | Exception decisions carry an idempotency key per intended decision; a lost answer retried with the same decision replays and applies once; a different decision gets a new key (`confirmation.test.tsx`, 33 tests) | Pass |

### Run 28: Wave 2 complete at API level, payroll active, wave-2 screens, platform hardening (28 Oct 2026)
Full API suite with every module active (payroll and payroll outputs included): 86 files, 740 tests, all passed, none skipped (evidence `full-api-1028.txt` in the session scratchpad; 577 s). Web suite: 21 files, 533 tests, all passed; both typechecks clean. Load-harness smoke test 22/22 (mechanics only, no capacity claim; ZT31–ZT35 stay BLOCKED). Every wave-2 module was reviewed independently after its build; each review spot-checked critical rules by temporarily breaking them and confirming a test failed, then restoring them.

| ID | What was verified | Result |
|---|---|---|
| FR-028–FR-033, FR-037, FR-099, FR-101 (I-28) | Payroll calculation, freeze and holds: DF05 proration and half-up rounding per component then summed (worked cases incl. a mid-month increment with components); ZT36 freeze under edits, reruns and backdated masters; preparer, reviewer and approver distinct, covering approval for a decider's own record; holds bounded by the unreserved net; run and hold state machines enforced in the database (payroll suites 57 tests) | Pass |
| FR-034, FR-038, FR-039, FR-102, FR-107 (I-32) | Bank manifests from processed runs only, independent authorisation recomputed under locks, run actors refused as authorisers and outcome recorders, outcomes only from evidence with idempotent keys, bounded reversals, nothing paid without CONFIRMED; payslips own-only with version and hash; interest-free loans recovered only from processed payroll and never above the balance; statutory outputs NOT_CONFIGURED (payroll-outputs 8 tests) | Pass |
| FR-011–FR-018, FR-040–FR-055, FR-110, FR-091–FR-093 | Hiring, processes/letters/exit/settlement, appraisal, timesheets, training, assets and increment cycles after their independent reviews (module suites 46, 35, 23, 27, 37, 17 and 40 tests) | Pass |
| I-25 platform | Reviewer row scope, decision and money re-checks inside the transaction, start exclusions at every step, scoped reminder notices (workflow suites) | Pass |
| NFR-S09 (I-34) | Attendance processing and leave accrual run as chunked, resumable bulk jobs under re-checked authority; retries 1/5/15 minutes then FAILED; audit once (bulk 8 tests, 100 affected tests) | Pass |
| FR-106 (I-21) | Import files scanned before any row is read; quarantined refused; unscanned held and never committed; settlement uploads scanned (imports scan 7 tests) | Pass |
| F2 (FR-096/FR-097) | All 14 baseline roles have their catalogues; counts reconcile with their source lists; financial dashboards counts only (dashboard 13 tests) | Pass |
| Run 28 close (28 Oct, 21:40) | After the wave-1 audit (FR-007, FR-082, FR-085), company policy documents and bulk mapping (FR-010, module `documents`, 0054) and the FR-105 payroll cutoff warning: full API suite 89 files, 756 tests, all passed (`full-api-1028b.txt`); web 21 files, 568 tests (payroll screens incl. configuration, 70) | Pass |
| Run 29 (29 Oct, 16:35) | After increment review opening as a bulk job (0055) with counts-only results and per-employee rows (0057, 0058), DF04 reference-value route, held-import list and resume on every import (`imports/routes.ts`), staged-document discard (0056), cutoff warning in the own change list, asset holder identity, and the web screens for policies, bulk mapping, notification rules, confirmation attention list, cutoff warning, timesheet imports, background jobs and increment opening rows: full API suite 91 files, 785 tests, all passed, none skipped (`full-api-1029.txt`, 747 s); web 23 files, 629 tests, all passed; `npm run typecheck` (API and web) clean | Pass |
| Run 30 (29 Oct, 19:11) | After the wave-2 completeness audit and its fixes (approved last working date in leave, work requests, accrual and attendance; settlement balances; templates on every import; policy expiry notices 0060; increment reports; salary master 0062; paging and totals on wave-2 lists; own hold status; loan upload; timesheet exports and XLSX 0067), the review of the day's code and its fixes (import key reuse, accrual and policy activation scope, report filters, failed-opening reruns, 0066 job-row kinds, asset lock order, own requests paging): full API suite 101 files, 878 tests, all passed, none skipped (`full-api-1029b.txt`, 1,219 s); `npm run typecheck` clean; web 24 files, 665 tests: the first run, concurrent with the API suite, had 1 failure (664 passed; the failing test was not captured), and three reruns, two of them concurrent with the API suite, passed 665/665 — recorded as an unidentified intermittent web test (D-035) | Pass (web: 1 intermittent, open) |
| Web | Wave-2 screens for hiring, lifecycle, appraisal, timesheets, assets, training and payroll, each reviewed; My ESS panels TN06, TN13, TN15–TN18 and module decision queues wired into the hub and inbox (registry test); App.tsx routes not yet wired (owner) | Pass |

## Defects found and fixed during this run
| # | Defect | Fix |
|---|---|---|
| D-001 | Workflow immutability trigger referenced a column absent on one of its tables | Split into two trigger functions |
| D-002 | Scope predicate added an unreferenced, untyped parameter (OWN/COMPANY scopes) → query error | Parameter added on first use; explicit uuid casts |
| T-001 | Two tests expected FK code where a BEFORE trigger rejects first (still rejected) | Expected code corrected; assertion of rejection unchanged |
| D-003 | Grant classification lookup used the database date instead of the company business date | Uses `hrms_business_date(company, now())` |
| D-004 | Off-cycle case insert used `$3` as uuid and text → inconsistent parameter types (500) | Occurrence key built in code |
| D-005 | Increment decision returned `10.0000` instead of DF14 two-decimal `10.00` | Formatted with `to_char` like other outputs |
| D-006 | Expense submission recorded flags before validating reasons | Validate first, then record |
| D-007 | Decision endpoint rejected 4-decimal amounts returned by the API | Accept 4 decimals; DB still requires whole paise |
| D-008 | Shared expense trigger referenced a column missing on one table | Split into two functions |
| D-009 | Money compared/subtracted in JavaScript | Moved to SQL numeric |
| D-010 | HR default duties exposed all expense claim amounts (DF02) | `expense.read` moved to the finance-duty bundle |
| D-011 | `report_code` constrained to lower case | Aligned to upper case (0015) |
| D-012 | Two React versions installed (19 hoisted, app on 18) | npm `overrides` + regenerated lockfile |
| D-013 | Import date validation accepted impossible dates (`Date.parse` rollover) | Strict round-trip calendar check |
| D-014 | Shell edit double-encoded three web source files | Byte-exact repair; edits now made with UTF-8-safe tools |
| D-015 | Client-supplied receipt references accepted; same stored receipt reused across claims escaped duplicate detection | Server-side upload bound to claimant; checksum comparison across claims |
| D-016 | Confirmation and attendance-amendment reasons visible with operational read duties, including to the employee | Separate confidential `reason` groups (0020); ceiling-only |
| D-017 | The shared mirror trigger compares the row as queued at each update, so a transaction passing through two states (IN_REVIEW → APPROVED → APPLIED) failed at commit (found while building FR-104; no existing path changed state twice) | Sensitive changes use a mirror check that reads the row's current state (0033); new modules are told to copy it |
| D-018 | `/v1/me/permissions` dropped every confidential group for Employee-class roles, so the UI could not offer the v8.2 own-ESS views | Same rule as resolveAccess: own-ESS groups listed in the Employee OWN context only |
| D-019 | A re-seeded older development database did not give the Employee OWN assignment its own-ESS default duties (I-16 parity) | Re-seed backfills catalogued own-ESS groups for Employee OWN assignments only; test updated to v8.2 |
| D-020 | One outbox event whose description failed (malformed id, or any describer error) was retried first on every tick and held back every later event for every company (found by the API review) | Malformed ids are read as absent (review fix); every event is processed in its own savepoint and a failure is retried after 1, 5 and 15 minutes, then FAILED, with each attempt recorded (DF12; 0047; `outbox-retry.api.test.ts` 3 tests) |
| D-021 | A request body over the route limit, or malformed JSON, answered 500 INTERNAL and was logged as an unhandled error | Fastify client errors keep their status (413 PAYLOAD_TOO_LARGE, 400 INVALID_REQUEST); `errors.api.test.ts` |
| D-022 | Amending a day to ON_DUTY, LEAVE, HOLIDAY or WEEKLY_OFF kept the late and early flags of the punch evaluation (found by the API review) | Amendments to those outcomes clear the flags, with the before values in the audit trail |
| D-023 | A document-expiry notice was lost for good when its day was missed (worker outage, failed run) or the document was uploaded after that day's run; a failing reminders part also skipped document expiry | Expiry notices catch up within 7 days (operational window), still once per document; both parts of the daily run are attempted (`document-expiry.api.test.ts` catch-up test) |
| D-024 | Run 27: the staff detail route served one's own appraisal with reviewer-only details (pending task and decider identities, the manager's rating progress) in the Employee OWN context and to HR or managers viewing their own record; no scores leaked (found by the appraisal review) | One's own appraisal reads as the own view in every context (appraisal module) |
| D-025 | Run 27: a task could be routed to a fallback reviewer whose row scope did not cover the employee, who then could not open it (found by the appraisal review) | Reviewer eligibility includes row scope; with nobody eligible, submission is refused NO_ELIGIBLE_REVIEWER (I-25) |
| D-026 | Run 27: decisions and payment actions used the authority resolved before their transaction, so a narrowing committed in between went unseen | Re-resolved inside the transaction after its locks, with the acting assignment share-locked (I-25, docs/09 §6.5) |
| D-027 | Run 27: overload (pool wait, statement or lock timeout) answered 500; API answers could be stored by caches; request logs recorded raw URLs with search terms and client addresses | 503 with Retry-After; `cache-control: no-store` on every `/v1` answer; route-pattern request logs (ADR-14) |
| D-028 | Run 27: confirmation-exception decisions from the web were sent without an idempotency key, so a retry after a lost answer could be refused or double-applied (found by the web review) | One key per intended decision, reused on retry (`confirmation.tsx`) |
| D-029 | Run 27: the reviewer's evidence "Open" found its request by matching the requester's whole request list, reading data it never showed and failing for two identical requests (found by the web review) | The task summary carries the request id |
| D-030 | Run 27 (27 Oct): four test files picked each weekday separately ("the next Monday", "the next Tuesday" at least N weeks ahead), so on a Tuesday the Tuesday fell before the Monday and leave requests were refused (end before start): a test defect, not a product one | The helper anchors every weekday to the same week (the first Monday at least N weeks ahead) |
| D-032 | Run 27 (28 Oct): the people who created, calculated, reviewed or approved a payroll run could still authorise its bank release and record payment outcomes and reversals; a non-independent caller's replay returned 200 (found by the payroll-outputs review) | Run actors and run task approvers refused (NOT_INDEPENDENT), independence checked before replay, and the database refuses events recorded by the manifest preparer or out of manifest order |
| D-033 | Run 27: an applied increment created a salary arrangement without components, so payroll reported SALARY_COMPONENTS_MISSING; another HR user who edited a cycle draft could activate it (found by the payroll build and the increment review) | Approved component lines become the arrangement's components on application; neither author nor last editor activates |
| D-034 | Run 27: assets issue/return/retire, timesheet exception resolution and over-allocation, lifecycle task completion, increment proposal and activation did not re-check authority inside their transaction (found by the module reviews) | reassertAccess after the locks on each (I-25) |
| D-035 | Run 30: one web test failed once in a full web run that ran concurrently with the full API suite; the output was not kept, and three reruns (two under the same load) passed 665/665 | OPEN: keep the full output of every web run; the earlier timing fix for the appraisal web test (wait for the control to be enabled; testTimeout 20000) is the likely remedy once the test is known |
| D-036 | Run 30 review: an idempotency key reused on a different import resumed a held batch under the other import's rules or answered an empty 200; monthly accrual and leave policy activation accepted a department-filtered company scope; leave and work-request approval did not re-check the approved last working date; a failed increment opening was not counted as a run | 409 IDEMPOTENCY_KEY_IN_USE; unrestricted company scope; approval re-check; openedBefore() (I-33, I-34, I-41) |
| D-037 | BRD audit (exit-2): a report generation failing for any reason except the report's own refusal rolled back and stayed QUEUED, so every tick claimed the same oldest execution again and no later report of any company was generated | Generation runs in a savepoint; a failure counts an attempt, waits 1, 5 and 15 minutes, then ends FAILED with an error class, never its message; other reports are claimed meanwhile; an empty result stays COMPLETED with zero rows (0097; report.api.test.ts, 5 tests) |
| D-031 | Run 27: in a multi-step approval a user excluded when it started (its preparer or requester) could be picked for a later step; only the first step honoured the exclusion (found by the hiring review) | Exclusions kept with the approval instance and applied at every step (0052; `workflow/exclusions.api.test.ts`) |

## Not run yet
(Updated 26 Oct 2026.) Full-scale capacity tests ZT31–ZT35: BLOCKED until the G4 environment exists (the workload harness smoke test proves its mechanics only, never capacity, G5). Payroll and payroll outputs (FR-028–FR-039, FR-099–FR-102, FR-107, FR-108): being built. Real external delivery (email, SMS, push), bank files against a bank-accepted specification, a production identity provider and malware scanner: not configured, so not run. The web screens are verified with jsdom tests only; no browser run has been made (no development server is started in this environment).
