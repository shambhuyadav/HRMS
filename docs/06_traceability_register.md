# 06 Requirement Traceability Register

Status: **Not started** unless noted below. Evidence: see 08_verification_log.md.

| Status update (24 Oct 2026) | Rows |
|---|---|
| In progress (DB + engine + API slice, tests passing) | FR-001, FR-002, FR-003, FR-004, FR-006, FR-008, FR-057, FR-062, FR-066, FR-067, FR-068, FR-069, FR-089 (employment timeline only), FR-098; BR-001, BR-002, BR-004, BR-005, BR-006, BR-007, BR-043, BR-044, BR-046 |
| In progress (DB + API, tests passing), added run 4–8 | FR-005, FR-019, FR-020, FR-021, FR-022, FR-024, FR-025, FR-026, FR-060 (leave/confirmation queues), FR-061, FR-080, FR-081, FR-082 (views; reminders pending), FR-083, FR-084, FR-085 (in-app only), FR-029 (arrangement base), FR-089, FR-090, FR-091 (common-date cycles), FR-092, FR-070, FR-071, FR-072, FR-073, FR-074, FR-075, FR-076 (direct route), FR-077, FR-078, FR-094, FR-095, FR-096, FR-097, FR-086, FR-087, FR-088, FR-007 (exports), FR-056, FR-065, FR-079 (register), FR-093, FR-082 (reminders), FR-085 (scheduled); BR-031, BR-026, BR-035, BR-036, BR-037, BR-042, BR-045, BR-017, BR-018, BR-019, BR-020, BR-021, BR-022, BR-023, BR-024, BR-025, BR-008, BR-009, BR-010, BR-029, BR-030, BR-032, BR-033, BR-034, BR-038, BR-039, BR-040, BR-041 |
| In progress (DB + API + UI, tests passing), added run 16–20 | FR-009 (employee CSV import: preview, commit, cancel), FR-010 (employee documents; policies/communication pending), FR-064 (import jobs/rows), FR-026 (resubmission, cancellation of approved leave), FR-027 (outdoor duty, work on holiday, HR views; evidence files pending) |
| In progress (DB + API, tests passing), added run 21–23 | FR-058 (audit trail viewer and separate audit export; retention rules, holds and eligibility dry run — purge disabled by DF08), FR-059 (profile change requests and attendance correction requests; payslips, declarations, appraisal, timesheets and training are wave 2), FR-066 (role catalogue and company user pickers), FR-021 (employee-requested corrections), FR-023 (shift-plan import SHIFT_PLAN_V1; reviewed mobile-app links); DF03 routing administration |
| In progress (DB + API, tests passing), added run 26 | FR-027 (supporting evidence files on outdoor duty and holiday work, readable by requester and assigned reviewer), FR-106 (quarantine, scan, released-only access, own upload, independent verification; receipts released-only), FR-080/FR-081 (DF11 employee due-date override and extension-limit exception, independently approved), FR-009 (separate employee update import EMPLOYEE_UPDATE_V1 with proposed-change preview), FR-109 (own requests with pending reviewer and decision history), FR-103 (My ESS index of TN01–TN18 with named unavailable states; wave-2 tabs become available as their modules are activated), FR-104 (PERSONAL and ADDRESS sensitive changes), FR-105 (BANK changes; the payroll cutoff warning waits for the payroll calendar); BR-053, BR-054, BR-055 (ESS parts) |
| In progress (DB + API active and independently reviewed, tests passing; web screens built and tested, wired into the My ESS hub and the decision inbox, routed and in the menu since 30 Oct, I-47), added run 27 (26–28 Oct) | Hiring FR-011–FR-014 (I-27); employee processes, letters, exit and settlement FR-015–FR-018, FR-051–FR-055 (I-29; FR-018 sending, FR-054 sending and the disbursement-month filter not built (I-40 items 2, 3; outputs and bulk upload built run 30, I-46); FR-052 calculation NOT_CONFIGURED; FR-055 account deactivation and asset clearance wait for an offboarding policy); appraisal FR-040–FR-044 (I-23, I-24; competencies, configurable sections and an employee-visible result blocked by owner inputs); timesheets FR-045–FR-048 (I-30); training FR-049–FR-050 (I-26); assets FR-110 assets part (I-31); payroll calculation, freeze and holds FR-028–FR-033, FR-037, FR-099, FR-101 (I-28; rule-pack heads block until packs exist; grade structures, PT and challan masters not built); payroll outputs FR-034 loans, FR-038 reports (register, disbursement, comparison; JV NOT_CONFIGURED), FR-039 statutory outputs NOT_CONFIGURED, FR-102 bank files, FR-107 payslips (Form 16 NOT_CONFIGURED) (I-32); increment cycles FR-091–FR-093 and DF15 (I-33; arrears for increments landing in locked payroll not built); F2 dashboards for all 14 baseline roles (counts reconciled with their source lists; financial roles counts and states only; widgets without a source or grant NOT_AVAILABLE); NFR-S09 bulk jobs for attendance processing and leave accrual (I-34); BR-013–BR-016, BR-047–BR-052; CI25–CI28; ZT36 freeze tests; reviewer scope, decision re-check and start exclusions for all workflows (I-25) |
| Blocked by owner inputs (run 27; mechanics built 4 Nov, I-70, nothing calculates or feeds payroll) | (Arrears, FR-035, and late-timesheet adjustments, FR-100, left this row on 6 Nov 2026: valued and paid under owner delegation, I-79, 0205, 0206.) FR-036/FR-108 tax declarations and investment proofs: capture and review built (0128); still need an active tax rule pack with regimes and categories; Form 16 and statutory registers (need statutory templates and rule packs, H8); bank files in production (need a bank-accepted specification and sample validation) |
| In progress (DB + API, tests passing), added run 28 (28 Oct) | FR-085 and FR-061 (notification rule and template revisions: future-dated, audited, one revision in force; mandatory rules cannot be switched off; approved placeholders only; channel, recipients, timing and retry ceiling carried over unchanged; I-35), FR-082 (EXTENDED view; read-only HR attention list for missing or ambiguous policy, unopened case, missing manager and missing HR reviewer; I-36), FR-007 (employee list and employee register share search, status, department and joining-date filters; reversed ranges refused on both; other reports refuse list filters; I-37); FR-063 confirmed by existing evidence (idempotent imports, payroll calculation replay and decisions, service-side scope). FR-010 company policy documents with versions, classification and expiry, and bulk document mapping DOCUMENT_MAPPING_V1 (I-38; new module `documents`, 0054); FR-105 payroll cutoff warning on BANK changes (I-18). Still open with owner inputs: FR-010 event planner and ticker (undefined) and document export, FR-058 purge (retention schedule), FR-085 external email delivery (provider), FR-007 export column approval |
| In progress (DB + API + web, tests passing), added run 29 (29 Oct) | NFR-S09: increment review opening is bulk kind INCREMENT_REVIEW_OPENING (0055; FR-091 opening answers 202), every kind keeps counts only in its result with per-employee rows read through paged routes (0057 increment cases and exclusions with repair paths; 0058 attendance employees without a policy; I-34); web "My background jobs" screen. DF04 GET /v1/reference-values for lists named by active modules (I-39). FR-106/DF09: every framework import and the document mapping list the submitter's own batches and resume a batch held for the malware scan (`imports/routes.ts`; I-21). FR-010: discard of a staged, unmapped document kept as DISCARDED per DF08 (0056; I-38). FR-105: cutoff warning also in the employee's own change list (I-18). Web screens (page modules registered in `screens-registry.ts`): company policies (read, publish, versions), bulk document mapping, notification rules, confirmation EXTENDED view and attention list, payroll cutoff warning (TN03 and reviewer), timesheet allocation and line imports, increment opening status and rows. Asset holder identity on GET /v1/employees/:id/assets |
| In progress (DB + API + web, tests passing), added run 30 (29 Oct, after the wave-2 completeness audit) | DF04/FR-051 approved last working date in leave and work-request submission and approval, accrual and attendance (I-41); FR-034 settlement shows outstanding loans and leave balances (I-41) and loans can be uploaded (LOAN_REQUESTS_V1, each decided independently; I-32); DF09 published templates on every import, payroll inputs and settlement lines (I-21); DF12 company policy expiry notices (0060; I-38); FR-093 INCREMENT_DUE_DECISION and ANNUAL_INCREMENT reports; FR-029 salary master list, SALARY_MASTER_V1 upload of initial salaries, SALARY_MASTER and ANNUAL_SALARY exports (0062; I-42); FR-056 paging and totals on every wave-2 list, the utilisation report and own requests (I-43); H7 own hold status, status only (I-43); review fixes (import key reuse across imports, unrestricted scope for accrual and policy activation, unsupported report filters refused, failed-opening reruns, 0066 job-row kinds, asset issue lock order; I-33, I-34, I-37); FR-046/FR-048 RESOURCE_ALLOCATION and TMS_HOURS exports with XLSX output (0067; I-44); FR-038/H7 run exports PAYROLL_REGISTER, PAYROLL_DISBURSEMENT, PAYROLL_COMPARISON (0069) and held-salary reserved and confirmed totals, outstanding open (I-45); FR-054 outputs and bulk upload (I-46); all screens routed and in the menu (I-47). Not built (owner/BRD open, I-40): reimbursement register, estimated in-hand, CTC category, grade structures |
| Correction from the full BRD audit (30 Oct, recorded 2 Nov) | "In progress" in the rows above does not mean complete, and some rows overstated the work. The audit of all 13 BRD slices found 154 gaps against the code (35 confirmed by an independent verifier, 1 refuted, 118 not yet verified; full list: docs/audit/brd-audit-2026-10-30.json). Notably: FR-003 and FR-068 delegation exists only as a table (no API, no engine routing, `access.delegate` not in the baseline); FR-093 lacks the celebration, notification-delivery and sync report families; FR-080 has no policy maintenance; FR-001 has no way to link accounts to employees; FR-079/FR-084 expense and increment events produce no notices. Owner questions it raised are in docs/03 I-48. These rows change only as each gap is built and tested |
| Audit gaps closed, added run 31 (2 Nov) | Expense money and duty controls: FR-069, FR-073, FR-075–FR-077, DF07 (0088, 0096; I-49). Confirmation policies, cancellation and exit handling: FR-080, FR-082, BR-029, BR-031, DF11 (0081, 0082; I-50; DF15 increment re-check open). Report generation failures: FR-056 (0097). Request deadlines, metrics, payroll re-checks and portable keys: docs/09 §13.2 items 2–4 and 6 (0071). Bank proposal masking: FR-105 (I-18). Loan recovery limits, input reversal and own-record payroll reads: FR-031, FR-033, FR-034, FR-038, FR-107 (0084; I-51). Access scope, own-record and grant guards: FR-066, FR-067, CI09, CI24, ZT02, ZT04 (0089, 0098, 0099; I-52; reroute waits on the owner). Hiring, punch imports, letters and attendance policies: FR-013, FR-014, FR-017, FR-019, FR-020 (0113–0115; I-53). Attendance and leave controls: FR-021–FR-026 (0086, 0087, 0110–0112; I-54; the FR-021 E07 filters wait on the owner). User links and deactivation, status history, master periods, reference maintenance, employee sort, location-scope tests: FR-001, FR-004, FR-006, FR-007, FR-066 (0100–0102, 0105; I-55; FR-007 family and qualification exports wait on I-48 item 3). Settlement export right, exit letters, payroll trace, report state and recovery, dashboard task widgets, sorted lists: FR-054–FR-058, FR-060 (0119–0122; I-56). Delegation end to end: FR-003, FR-068 (0090; I-57; supersedes the earlier "table only" correction). Calendars: FR-005, shift revisions, weekly-off patterns, holiday correction (0103, 0104; I-58). Event notices, preferences and delivery log: FR-079, FR-084, FR-085, FR-088 (0092; I-59). Re-checks at submission and deferred application: FR-045, FR-047, FR-104, FR-105 (revision-rules.api.test.ts, deferred-apply.api.test.ts; I-60). Expense policies, invoice reuse, night checks, pending withdrawal, EXPENSE_* reports: FR-071, FR-072, FR-074, FR-075, FR-078, FR-079 (0116–0118; I-61; report columns await I-40 item 12). My Team membership, tabs and export, dashboard links and task list: FR-094–FR-098 (0093; I-62). Biometric administration: FR-086–FR-088 (0094; I-63). Employee timeline: FR-089 (I-64). Increment correction: FR-089, FR-090, BR-038 (0095; I-65; the DF15 arrears case waits on FR-035). Claim read rule, report scope and context, FR-093 report families, salary-stop treatment in outputs: FR-031, FR-038, FR-056, FR-065, FR-083, FR-093 (0123–0125; I-66; columns await I-40 item 12). Core web screens: FR-004 organisation masters, FR-006 single-employee create, edit and activation with manager, transfer and shift changes, FR-008 profile without the I-48 item 3 sections; status history through the FR-089 screen (org.tsx, employee.tsx; web tests with a mocked API). Employee list filters, sort and export, company screen, record facts: FR-004, FR-007 (I-67). Distinct history grants: C4, C6, FR-082, FR-089, FR-090 (0126; I-68). Reviewer routing and row scope: C1, C4, DF03 (I-69). Payment batch DRAFT and READY, named outcome actor, confirm_outcome and export duties: FR-076, FR-077 (0131; I-71). Role-permission proposals with independent decision and scoped DENY: FR-066, FR-067 (0132; I-71). Notification rule publication approval: FR-085 (0133; I-71). Raised-again links for assets and hiring, context block on appraisal, training and settlement direct CSVs (I-71). Database guards and accountable actors: CI07, CI11, CI12, CI15–CI18, CI20, B1, B5, DF06, DF07 (0140–0146; I-72; enforcement record in docs/07). Worker queues: outbox relay outside the company loop, per-company claims, bounded reminders and celebrations, scans in the worker: NFR-S09, FR-106, DF12 (0160; I-73; docs/09 §7) |
| In progress (DB layer only) | BR-027 |

W = delivery wave (DF01). Screens and permissions are proposed. Acceptance tests are taken from each FR's acceptance clause in the BRD. Test IDs are assigned when the tests are written.

## Functional requirements

| FR | Title | Pri | W | Module | Source | Decision | Primary tables | Permission (resource.action) | Gates |
|---|---|---|---|---|---|---|---|---|---|
| FR-001 | Authentication & session | Must | 1 | Access | E01/E16 | DF10 | user_account | session.* | ZT05, 32 |
| FR-002 | Granular authorisation | Must | 1 | Access | E01/E16 | DF02 | role, permission, role_permission, role_assignment, DB109 | access.* | ZT01–05, 29, 30 |
| FR-003 | Hierarchy & delegation | Must | 1 | Access | E16 | DF03 | manager_assignment, delegation | access.delegate | ZT02, 04, 05 |
| FR-004 | Organisation masters | Must | 1 | Org | E02 | DF04 | company, department, location, designation, grade, reference_value | master.* | ZT06, 08, 09 |
| FR-005 | Shifts, holidays, calendars | Must | 1 | Attendance | E04 | DF05 | shift, shift_break, holiday | shift.* | ZT08, 16 |
| FR-006 | Employee record & status | Must | 1 | Employee | E03 | DF04 | employee, employment_assignment | employee.create/update | ZT07–09 |
| FR-007 | Search & exports | Must | 1 | Employee | E02/E03 | DF09 | report_execution | employee.list/export | ZT03, 17 |
| FR-008 | Employee profile detail | Must | 1 | Employee | E03 | DF02/04 | employee (+ child schemas pending) | employee.read; field groups | ZT03, 29 |
| FR-009 | Bulk onboarding & update | Must | 1 | Employee | E17 | DF09 | import_job, import_row | employee.import | ZT07, 19 |
| FR-010 | Documents, policies, communication | Must | 1 | Employee | E17 | DF02/12 | employee_document, attachment, notification | document.* | ZT01, 03 |
| FR-011 | Manpower budget & requisition | Must | 2 | Hiring | E10 | F1 | requisition (+ budget ext.) | requisition.* | ZT07, 10 |
| FR-012 | Requisition approval | Must | 2 | Hiring | E10 | F1/DF03 | requisition, approval_* | requisition.approve | ZT04, 10 |
| FR-013 | Candidate & CV register | Must | 2 | Hiring | E17 | F1 | candidate, application | candidate.* | ZT03, 07 |
| FR-014 | Tracker & employee handover | Must | 2 | Hiring | E17 | F1 | application, employee | candidate.hire | ZT07 |
| FR-015 | Lifecycle process definition | Must | 2 | Lifecycle | E15 | F1 | lifecycle_process (+ steps ext.) | process.manage | ZT10 |
| FR-016 | Employee process tracking | Must | 2 | Lifecycle | E17 | F1 | employee_process | process.* | ZT10, 12 |
| FR-017 | Letter templates & printing | Must | 2 | Lifecycle | E17 | DF09 | letter_output (+ template ext.) | letter.generate | ZT12 |
| FR-018 | Controlled correspondence | Must | 2 | Lifecycle | E17 | DF12 | notification | letter.send | ZT18, 23 |
| FR-019 | Attendance ingestion | Must | 1 | Attendance | E17 | DF09 | attendance_punch, import_job | attendance.import | ZT07, 24 |
| FR-020 | Daily policy evaluation | Must | 1 | Attendance | E05 | DF05/F6 | attendance_record, attendance_policy | attendance.process | ZT16 |
| FR-021 | Attendance controller | Must | 1 | Attendance | E07 | DF05 | attendance_record, attendance_amendment | attendance.read/amend | ZT02, 12 |
| FR-022 | EOD & processing control | Must | 1 | Attendance | E17 | DF05 | attendance_record (+ run control ext.) | attendance.process | ZT07, 16 |
| FR-023 | Shift planning & mobile linking | Must | 1 | Attendance | E17 | DF05 | shift_assignment (+ mobile link ext.) | shift.assign | ZT09 |
| FR-024 | Leave policy & mapping | Must | 1 | Leave | E06 | DF05 | leave_type, leave_policy, leave_policy_mapping | leave_policy.* | ZT09 |
| FR-025 | Opening balances & ledger | Must | 1 | Leave | E17 | DF05 | leave_movement | leave.adjust/import | ZT07, 16 |
| FR-026 | Leave request & approval | Must | 1 | Leave | E06 | DF03/05 | leave_request, leave_movement, approval_* | leave.submit/approve | ZT04, 10, 11, 16 |
| FR-027 | Outdoor & work on holiday | Must | 1 | Leave | E17 | DF05 | new typed roots (ext.) | outdoor.* | ZT10 |
| FR-028 | Payroll master configuration | Must | 2 | Payroll | E17 | DF05 | pay_component (+ structure ext.) | payroll_config.* | ZT09 |
| FR-029 | Employee salary master | Must | 1/2 | Payroll | E08 | DF05/14 | salary_arrangement, salary_component | salary.read/input | ZT03, 09, 29 |
| FR-030 | Period controller | Must | 2 | Payroll | E09 | DF05 | payroll_run | payroll.* | ZT10 |
| FR-031 | Monthly inputs & salary stop | Must | 2 | Payroll | E17 | DF05 | employee_financial_input | payroll.input | ZT07 |
| FR-032 | Paid days & proration | Must | 2 | Payroll | E17 | DF05 | payroll_record | payroll.calculate | ZT16 |
| FR-033 | Payroll calculation & review | Must | 2 | Payroll | E17 | DF05 | payroll_record, payroll_line | payroll.calculate/review | ZT04, 16, 17 |
| FR-034 | Loans, advances & recovery | Must | 2 | Payroll | E17 | DF05 | employee_financial_input (+ schedule ext.) | loan.* | ZT16 |
| FR-035 | Arrears & increments | Must | 2 | Payroll | E17 | DF05/15 | payroll_line (+ arrears ext.) | payroll.calculate | ZT07, 25 |
| FR-036 | Tax & declarations | Must | 2 | Payroll | E17 | DF05 (EXT) | declaration ext. | tax.* | ZT16 |
| FR-037 | Lock & controlled reopen | Must | 2 | Payroll | E17 | DF05 | payroll_run | payroll.lock/reopen | ZT10, 12 |
| FR-038 | Reports, disbursement, accounting | Must | 2 | Payroll | E17 | DF07 | report_execution | payroll.export | ZT17 |
| FR-039 | Compliance & salary certificates | Must | 2 | Payroll | E17 | DF05 (EXT) | rate pack ext. | compliance.export | ZT16, 17 |
| FR-040 | Appraisal cycle & schedule | Must | 2 | Appraisal | E11 | F1 | appraisal_cycle | appraisal_config.* | ZT09 |
| FR-041 | KRA & competencies | Must | 2 | Appraisal | E11 | F1; I-86 | appraisal_item, appraisal_competency, appraisal_competency_set, appraisal_competency_set_item, appraisal_competency_item, appraisal_scoring_setting | goal.*, appraisal_cycle.manage | ZT08 |
| FR-042 | Appraisal entry & scoring | Must | 2 | Appraisal | E11 | F1; I-86 | appraisal, appraisal_item, appraisal_competency_entry, appraisal_section_entry | appraisal.submit | ZT16 |
| FR-043 | Manager & reviewer decision | Must | 2 | Appraisal | E11 | F1/DF03 | appraisal, approval_* | appraisal.review | ZT04, 10 |
| FR-044 | Appraisal visibility & reports | Must | 2 | Appraisal | E11 | DF02/F1 | report_execution | appraisal.report | ZT03, 17 |
| FR-045 | Projects, jobs, activities | Must | 2 | Timesheet | E17 | F1 | project, job, activity | project.* | ZT06, 09 |
| FR-046 | Resource allocation | Must | 2 | Timesheet | E12 | F1 | resource_allocation | allocation.* | ZT09 |
| FR-047 | Entry approval & locking | Must | 2 | Timesheet | E17 | F1 | timesheet, timesheet_line | timesheet.* | ZT04, 10 |
| FR-048 | Reporting & payroll linkage | Must | 2 | Timesheet | E17 | F1 | report_execution | timesheet.report | ZT17 |
| FR-049 | Training plan | Must | 2 | Training | E13 | F1 | training_plan | training.* | ZT08 |
| FR-050 | Participants & feedback | Must | 2 | Training | E17 | F1 | training_participant, training_feedback | training.participant | ZT07, 17 |
| FR-051 | Employee exit record | Must | 2 | Exit | E14 | F1 | exit_case | exit.* | ZT10 |
| FR-052 | Settlement calculation | Must | 2 | Exit | E14 | DF05 (EXT) | settlement, settlement_line | settlement.calculate | ZT16 |
| FR-053 | Settlement review & release | Must | 2 | Exit | E14 | DF03 | settlement | settlement.approve/release | ZT04, 10 |
| FR-054 | Settlement upload & outputs | Must | 2 | Exit | E14 | DF09 | import_job, report_execution | settlement.prepare.amount (upload), settlement.read.amount (exports) | ZT07, 17 |
| FR-055 | Letters & access closure | Must | 2 | Exit | E17 | F1 | letter_output, role_assignment | exit.close | ZT05, 12 |
| FR-056 | Report usability & consistency | Must | 1 | Reporting | E17 | DF09 | report_execution | report.run/export | ZT17 |
| FR-057 | Attributable history | Must | 1 | Platform | E17 | DF08 | audit_event | audit.read | ZT12 |
| FR-058 | Audit export & retention | Must | 1 | Platform | E17 | DF08 | audit_event, report_execution | audit.export | ZT03, 12 |
| FR-059 | Employee portal | Must | 1 | Self-service | E01 | DF02 | (shared entities) | own.* | ZT02, 29 |
| FR-060 | Manager work queue | Must | 1 | Workflow | E01 | DF03 | approval_task | task.read/decide | ZT02, 28 |
| FR-061 | Alerts & delivery | Should | 1 | Notifications | E01/E17 | DF12 | notification | notification.* | ZT18, 23 |
| FR-062 | Integrity & effective dates | Should | 1 | Platform | E03/E17 | DF08 | all (B1) | — | ZT06, 09, 11 |
| FR-063 | Service responsibilities | Should | 1 | Platform | E03/E17 | DF10 | — (no-storage: design boundary) | — | ZT07 |
| FR-064 | Import lifecycle | Must | 1 | Platform | E12/E14 | DF09 | import_job, import_row | import.* | ZT07, 19 |
| FR-065 | Export protection | Must | 1 | Platform | E03/E08 | DF09 | report_execution | *.export | ZT03, 05 |
| FR-066 | Company-scoped role permissions | Must | 1 | Access | E16 | DF02 | role_assignment, role_scope_filter | access.assign_role | ZT01, 02 |
| FR-067 | Independent permission review | Must | 1 | Access | Request | DF02 | role_assignment, DB109 | access.approve_role_grant | ZT04 |
| FR-068 | Access expiry & delegation | Must | 1 | Access | E16 | DF03 | delegation | access.delegate | ZT05 |
| FR-069 | Output & field visibility | Must | 1 | Access | E03/E08 | DF02 | DB106 | field groups | ZT03, 29 |
| FR-070 | Expense draft & lines | Must | 1 | Expense | Request | DF06 | expense_claim, expense_revision, expense_line | expense.draft | ZT08 |
| FR-071 | Expense submission validation | Must | 1 | Expense | Request | DF06 | expense_policy, expense_policy_rule, expense_receipt | expense.submit | ZT13 |
| FR-072 | Manager expense review | Must | 1 | Expense | Request | DF03/06 | approval_* | expense.manager_decide | ZT04, 10 |
| FR-073 | Finance expense review | Must | 1 | Expense | Request | DF06 | expense_line_decision, expense_obligation | expense.finance_decide | ZT04, 13 |
| FR-074 | Claim correction & withdrawal | Must | 1 | Expense | Request | DF03/06 | expense_revision | expense.withdraw | ZT10, 11 |
| FR-075 | Duplicate expense review | Must | 1 | Expense | Request | DF06 | expense_line (fingerprint) | expense.finance_decide (with the clearance reason), expense.read.reason | ZT07 |
| FR-076 | Single expense payment route | Must | 1 | Payment | Request | DF07 | payment_batch, payment_instruction, payment_allocation | payment.prepare | ZT14 |
| FR-077 | Payment confirmation & reversal | Must | 1 | Payment | Request | DF07 | payment_event | payment.confirm/reverse | ZT14, 15 |
| FR-078 | Expense policy & eligibility | Must | 1 | Expense | Request | DF06 | expense_policy, expense_policy_rule | expense_policy.* | ZT09, 13 |
| FR-079 | Expense reports & notices | Must | 1 | Expense | Request | DF06/12 | report_execution, notification | expense.report | ZT17, 23 |
| FR-080 | Flexible confirmation period | Must | 1 | Confirmation | Request | DF11 | confirmation_policy, employee_confirmation | confirmation_policy_manage | ZT22 |
| FR-081 | Confirmation extension & history | Must | 1 | Confirmation | Request | DF11 | confirmation_action | confirmation_decide | ZT11, 22 |
| FR-082 | Confirmation reminders & lists | Must | 1 | Confirmation | Request | DF11/12 | employee_confirmation, notification | confirmation_history_read | ZT22, 23 |
| FR-083 | Birthday & anniversary events | Must | 1 | Notifications | Request | DF12 | notification_event, notification_preference | notification.* | ZT23 |
| FR-084 | Request & HR status notifications | Must | 1 | Notifications | Request | DF12 | notification_event, notification | notification.* | ZT18, 23 |
| FR-085 | Notification config & delivery | Must | 1 | Notifications | Request | DF12 | notification_rule, notification_template, notification_delivery_attempt | notification_rule_manage | ZT23 |
| FR-086 | Biometric API & field mapping | Must | 1 | Biometric | Request | DF09/13 | biometric_profile, biometric_mapping_revision, biometric_field_mapping | biometric_profile_manage, mapping_manage | ZT24 |
| FR-087 | Biometric validation & replay | Must | 1 | Biometric | Request | DF09 | biometric_ingest_event, biometric_run_observation, attendance_punch | sync_run | ZT07, 24 |
| FR-088 | Biometric recovery & authorisation | Must | 1 | Biometric | Request | DF09/13 | biometric_sync_run, biometric_employee_link | sync_run, employee_link_manage | ZT11, 24 |
| FR-089 | Employee history with salary | Must | 1 | History | Request | DF14 | increment_history, employment_assignment, audit_event | increment_history_read | ZT12, 26, 29 |
| FR-090 | Per-increment & annual % | Must | 1 | History | Request | DF14 | increment_history, salary_arrangement | increment_history_read | ZT26 |
| FR-091 | Increment cycles | Must | 1 | Increments | Request | DF15 | increment_cycle, employee_increment_plan | increment_cycle_manage | ZT25 |
| FR-092 | Increment approval & application | Must | 1 | Increments | Request | DF15 | increment_case, increment_component, salary_arrangement | increment_propose/approve/apply | ZT04, 11, 25 |
| FR-093 | Confirmation/notif/sync/increment reports | Must | 1 | Reporting | Request | DF09/17 | report_execution | *.report | ZT17 |
| FR-094 | My Team member list | Must | 1 | My Team | Request | DF16 | manager_assignment, employee | team.list | ZT27 |
| FR-095 | My Team employee detail | Must | 1 | My Team | Request | DF16 | DB106 + existing | team.read; field groups | ZT27, 29 |
| FR-096 | Distinct role dashboards | Must | 1 | Dashboards | Request | DF17/F2 | role_dashboard_definition, role_dashboard_widget | dashboard.read | ZT28 |
| FR-097 | Dashboard metric consistency | Must | 1 | Dashboards | Request | DF17 | DB108 | widget permission | ZT17, 28 |
| FR-098 | Confidentiality across all surfaces | Must | 1 | Access | Request | DF02 | DB106, DB109, role.access_class | all | ZT29, 30 |
| FR-099 | Freeze processed payroll | Must | 2 | Payroll | v8.2 H2 | H/BR-047 | payroll_run (DB036 additions), payroll_record | payroll.process | ZT36 |
| FR-100 | Carry late timesheets forward | Must | 2 | Payroll | v8.2 H2 | H/BR-048, BR-049 | DB111 payroll_adjustment, timesheet | payroll.adjust | ZT37 |
| FR-101 | Control salary hold criteria | Must | 2 | Payroll | v8.2 H2 | H/BR-050, BR-051 | DB110 payroll_hold | payroll.hold | ZT38 |
| FR-102 | Generate bank format files | Must | 2 | Payroll | v8.2 H2/H4 | H/BR-052; §13.1 | DB112–DB114, DB118 | payroll.bank_file | ZT38 |
| FR-103 | Provide complete ESS tabs (TN01–TN18) | Must | 1 | ESS | v8.2 H3 | H1/BR-053, BR-055 | existing + DB115–DB117 | ess.* (Employee OWN) | ZT39 |
| FR-104 | Approve private profile changes | Must | 1 | ESS | v8.2 H4 | H/BR-054 | DB115, DB116 | sensitive_change.submit/read.private (Employee own-ESS); sensitive_change.review.private; employee.read.private | ZT40 |
| FR-105 | Approve bank detail changes | Must | 1 | ESS | v8.2 H4 | H/BR-054 | DB115, DB116 (bank revisions) | sensitive_change.submit/read.private (Employee own-ESS); sensitive_change.review.private; employee.read.bank (full values, Admin only) | ZT40 |
| FR-106 | Control employee documents (quarantine, scan) | Must | 1 | ESS | v8.2 H4 | H/BR-053 | employee_document, attachment | document.* | ZT39, 40 |
| FR-107 | Issue own payroll and tax documents | Must | 2 (payslips reference payroll records; Form 16 needs the statutory template) | ESS | v8.2 H3/H7 | H/BR-053; H8 | DB117 employee_issued_output | issued_output.* | ZT39 |
| FR-108 | Submit tax declarations and proofs | Must | 2 | Payroll/ESS | v8.2 H3 | H; F4 tax rule pack | declaration child tables (to be detailed) | ess.tax_declaration | ZT39 |
| FR-109 | Expose own business requests | Must | 1 (leave, attendance, regularisation, expense); 2 (timesheet, loan) | ESS | v8.2 H3 | H/BR-055 | existing | own-scope reads | ZT39 |
| FR-110 | Expose own assets and development | Must | 2 | ESS | v8.2 H3 | H | asset/training/appraisal (wave 2) | own-scope reads | ZT39 |

## Business rules

| BR | Rule | Enforced in (module) | Mechanism (proposed) | Related FR | Gates |
|---|---|---|---|---|---|
| BR-001 | Employee identity uniqueness | Employee | UNIQUE(company_id, employee_code), normalised; no reuse | FR-006 | ZT07 |
| BR-002 | Employment dates & history | Employee | Check constraints + EXCLUDE intervals | FR-006, 089 | ZT09 |
| BR-003 | Status facets | Employee | Lifecycle state catalogue (DF04) | FR-006 | ZT10 |
| BR-004 | Master deactivation | Org | Deactivate only; RESTRICT FKs | FR-004 | ZT06 |
| BR-005 | Manager authority | Access/Workflow | Cycle check + self-check at assignment and decision | FR-003 | ZT04 |
| BR-006 | Role data scope intersection | Access | C1 same-assignment evaluation | FR-066 | ZT01, 02 |
| BR-007 | Sensitive grant changes | Access | Independent approval workflow for grants | FR-067 | ZT04 |
| BR-008 | Shift duration | Attendance | Overnight → start date (DF05) | FR-005 | ZT16 |
| BR-009 | Attendance classifications | Attendance | DF05/F6 thresholds | FR-020 | ZT16 |
| BR-010 | Leave mapping | Leave | Unambiguous policy match | FR-024 | ZT09 |
| BR-011 | Payroll values | Payroll | No inferred formulas; versioned rules | FR-028–033 | ZT16 |
| BR-012 | Payroll period & release | Payroll | DF05 lifecycle | FR-030, 037 | ZT10 |
| BR-013 | Appraisal review levels | Appraisal | F1 single step by default | FR-043 | ZT10 |
| BR-014 | Appraisal rating & upload | Appraisal | F1 rules; upload creates DRAFT | FR-041, 042 | ZT08 |
| BR-015 | Training date views | Training | F1 derived FUTURE/CURRENT/PAST | FR-049 | ZT16 |
| BR-016 | Settlement states | Exit | Separate calc/review/release | FR-053 | ZT10 |
| BR-017 | Expense ownership & evidence | Expense | Immutable submitted revision | FR-070, 074 | ZT12 |
| BR-018 | Expense route | Expense | Workflow definition per DF03/06 | FR-071–073 | ZT04, 10 |
| BR-019 | Expense policy eligibility | Expense | Fail on missing/ambiguous match | FR-078 | ZT13 |
| BR-020 | Expense amounts | Expense | Check constraints; derived total | FR-073 | ZT13 |
| BR-021 | Partial approval | Expense | Reason required for reductions | FR-073 | ZT13 |
| BR-022 | Expense currency | Expense | Claim and payment in the policy currency (INR); a line may be in an enabled currency, converted once at submission at the dated company rate (I-87) | FR-071 | ZT08 |
| BR-023 | Duplicate control | Expense | Fingerprint review flag | FR-075 | ZT07 |
| BR-024 | Payment uniqueness | Payment | UNIQUE obligation per claim; allocation ledger | FR-076 | ZT14 |
| BR-025 | Unknown & reversal outcomes | Payment | Pending holds reservation; reversal bound | FR-077 | ZT15 |
| BR-026 | Reports & filters | Reporting | Shared query layer for list/export/dashboard | FR-056 | ZT17 |
| BR-027 | Import & message actions | Platform | Dry-run + explicit commit/send | FR-064, 018 | ZT07, 18 |
| BR-028 | Zero-tolerance gates | QA | Release blocked on any failing gate | All | All |
| BR-029 | Confirmation duration | Confirmation | Positive duration; month-end clamp | FR-080 | ZT22 |
| BR-030 | Confirmation decisions | Confirmation | No auto-confirm; append-only actions | FR-081 | ZT22 |
| BR-031 | Confirmation reminders | Confirmation | 30/7/1/0 days + weekly overdue | FR-082 | ZT22 |
| BR-032 | Celebration privacy | Notifications | Opt-in; no DOB/year/age in payload | FR-083 | ZT23 |
| BR-033 | Notification routing | Notifications | Outbox after commit; recheck at delivery | FR-084 | ZT18, 23 |
| BR-034 | Dedup & delivery | Notifications | Unique occurrence key; 1/5/15 min retries | FR-085 | ZT07, 23 |
| BR-035 | Biometric dynamic config | Biometric | Allowlisted paths/transforms; secret refs | FR-086 | ZT24 |
| BR-036 | Biometric identity integrity | Biometric | Profile-scoped event key; quarantine | FR-087 | ZT24 |
| BR-037 | Fetch state & counts | Biometric | Atomic checkpoint; lease per profile | FR-088 | ZT24 |
| BR-038 | Increment basis & history | History | Append-only increment_history | FR-089, 092 | ZT26 |
| BR-039 | Increment percentages | History | Exact decimal; N/A reasons; no summing | FR-090 | ZT26 |
| BR-040 | Increment cycle eligibility | Increments | Snapshot at open; no overlapping plans | FR-091 | ZT25 |
| BR-041 | Increment approval boundary | Increments | Locked application txn; arrears for locked payroll | FR-092 | ZT25 |
| BR-042 | Team membership | My Team | Current direct manager_assignment only | FR-094 | ZT27 |
| BR-043 | Information classification | Access | DB106; unknown = CONFIDENTIAL | FR-098 | ZT29 |
| BR-044 | Confidential-role eligibility | Access | access_class + field grant + scope in one assignment | FR-098 | ZT29, 30 |
| BR-045 | Dashboard scope & reconciliation | Dashboards | Widget query = source list query | FR-097 | ZT28 |
| BR-046 | Multiple roles & changes | Access | Explicit selected assignment; live check | FR-098 | ZT05, 30 |
| BR-047 | Processed payroll immutable | Payroll | No unlock-in-place; corrections are linked adjustments | FR-099 | ZT36 |
| BR-048 | Late timesheet valuation | Payroll | Original-period snapshots; delta only; unique source revision | FR-100 | ZT37 |
| BR-049 | Missing timesheet ≠ absence | Payroll | Reminder/exception; never automatic hold or deduction | FR-100, FR-101 | ZT37 |
| BR-050 | Payment holds separate from earned salary | Payroll | Activated policy + independent approval; amount bounded | FR-101 | ZT38 |
| BR-051 | Bank safety block, not forfeiture | Payroll | Invalid bank instruction blocks payment only | FR-101 | ZT38 |
| BR-052 | Bank files carry READY allocations only | Payroll | Separate batches per currency/template; no repeated exposure | FR-102 | ZT38 |
| BR-053 | Employee OWN ESS exception | Access/ESS | Own issued outputs, permitted own private values, own submissions/documents, own loan/tax only | FR-103–FR-110 | ZT29, 39 |
| BR-054 | No direct employee mutation of protected masters | ESS | Change requests; independent approved revision application | FR-104, FR-105 | ZT40 |
| BR-055 | Every ESS action rechecks ownership and grants | ESS | Employee context for own ESS; server, search, notifications, caches, exports | FR-103, FR-109 | ZT39 |

## Other BRD items traced (6 Nov 2026)

Items the BRD names that no row above traced. Built unless noted.

| Item | BRD meaning | Where built | Tests |
|---|---|---|---|
| TN02 | Personal details change request | `modules/self-service` (profile changes, FR-059) and `modules/sensitive-change` (protected values, FR-104, BR-054); tab in `ess/service.ts` | `self-service.api.test.ts` "profile change requests (FR-059, DF04)"; `ess.api.test.ts` "My ESS index (FR-103)"; web `ess.test.tsx` |
| TN07 | Form 16 | Tab present, answering `TAX_CERTIFICATES_NOT_ENABLED` (`ess/service.ts`). Waits on the statutory template and rule pack (docs/10 D1; FR-107 Blocked) | `ess.api.test.ts`; web `ess.test.tsx` |
| TN10 | Leave | `modules/leave`; tab in `ess/service.ts` | leave suite; `leave-reasons.api.test.ts`; `ess.api.test.ts`; web `ess.test.tsx` |
| TN11 | Attendance | Own attendance and sync status through `ess/service.ts` and `modules/attendance` | `ess.api.test.ts`; web `ess.test.tsx` |
| TN12 | Regularization | `/me/attendance-corrections` in `modules/self-service` (FR-059, FR-021) | `self-service.api.test.ts` "attendance correction requests (FR-059, FR-021, DF03)"; `ess.api.test.ts`; web `ess.test.tsx` |
| TN14 | Expense | `modules/expense`; tab in `ess/service.ts` | expense suite including `expense-draft.api.test.ts` (FR-070); `ess.api.test.ts`; web `ess.test.tsx` |
| F5 | Decision completeness and handover status | `docs/03_decision_register.md`, `docs/10_owner_decisions.md` | A document, not a test |
| DB070, DB071 | Timesheet revision link to adjustments (line 5416) | Case records in `modules/payroll-adjustments` (DB111), valued from the frozen record and paid once by calculation step 7b (I-79; 0205, 0206) | `payroll-adjustments.api.test.ts`, `adjustments-payroll.api.test.ts`, `arrears-payroll.api.test.ts` |
| DB107, DB108 | Team dashboards | `0013_team_dashboards.sql`; FR-094–FR-097 | `dashboard.role-widgets.api.test.ts`; team dashboard tests |
