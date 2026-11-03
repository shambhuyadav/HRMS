# 04 Implementation Plan (Proposed)

Assumed team: 1 architect/lead, 5 backend, 3 frontend, 2 QA, 1–2 platform/DevOps, 1 BA/PO. Durations are estimates, not commitments.
Each module is delivered as a **vertical slice**: migrations + constraints + server authorization + service + UI + outputs + tests + register updates.

## Phase 0 – Foundation (weeks 1–4)
| Deliverable | Exit evidence |
|---|---|
| Approved ADR (doc 05), repo, CI pipeline, environments (dev/test only) | ADR signed by lead; pipeline green on empty build |
| Registers populated: traceability, decision, schema-constraint (all 109 tables), access matrix (14 roles × resources) | Review by BA + lead |
| State/transition catalogue per resource (C5, C6, DF03, DF04, DF05) | Approved document |
| Synthetic fixture generator: 2+ companies, mixed roles, expired grants, boundary dates | Fixture set v1 in repo |

## Phase 1 – Platform core (weeks 5–14)
Order matters. Everything later depends on this.
1. Tenancy + common columns (B1), composite same-company FKs, version counters, audit_event (FR-057/062, CI16).
2. Identity/session/MFA (FR-001, DF10), user_account, user_employee_link.
3. RBAC engine: role, permission, role_permission, role_assignment, role_scope_filter, DB109 role_assignment_permission, DB106 confidential_field_policy, role.access_class. C1 decision order, same-assignment rule, BR-044 (FR-002, 066–069, 098; CI09, CI22, CI24).
4. Reference masters + effective dating (company, dept, location, designation, grade, reference_value) (FR-004; CI15).
5. Employee + employment_assignment + manager_assignment with cycle/overlap checks (FR-006; CI13).
6. Typed transaction registry, workflow_definition/step, approval_instance/task/decision, delegation (FR-003, 063; CI01, CI02, CI10, CI12).
7. Outbox + notification core (DB083, 089–093) (FR-061, 085; CI18).
8. Import/export framework: import_job/row, report_execution, attachment with inherited auth, formula-injection safety (FR-056, 064, 065; CI11, CI16).

Gates exercised: ZT01–ZT12, ZT18, ZT29, ZT30 (platform-level).

## Phase 2 – Wave 1 modules (weeks 15–36, parallel streams)
| Stream | Scope (FR) | Key tables | Gates |
|---|---|---|---|
| A Employee & org | FR-004–010, 059 | employee, employee_document, import_* | ZT06–09, 19 |
| B Attendance & leave | FR-005, 019–027 | shift*, holiday, attendance_*, leave_* | ZT09, 16 |
| C Biometric API | FR-086–088 | biometric_* (DB094–100), attendance_punch | ZT24 |
| D Confirmation | FR-080–082 | DB086–088 | ZT22 |
| E Notifications | FR-083–085 | DB089–093 | ZT23 |
| F History & increments | FR-089–093 (+ salary_arrangement/component minimal) | DB101–105 | ZT25, 26 |
| G Expense & payment ledger | FR-070–079 | DB047–059 | ZT13–15, 17 |
| H My Team, dashboards, reports, audit | FR-056–058, 060, 094–098 | DB106–108 | ZT17, 27–30 |

Suggested start order inside the streams: A → B → (C, D in parallel) → E → F → G → H. H runs continuously because dashboards depend on each module.

## Phase 3 – Wave 1 hardening & UAT (weeks 37–44)
Concurrency, replay, rollback and stale-version suites; full ZT01–ZT30 run on the wave 1 scope; owner acceptance sessions; release-readiness review. **Production activation needs explicit separate authorisation.**

## Phase 4 – Wave 2 (weeks 40–68, overlaps Phase 3)
| Stream | Scope | Blocked by |
|---|---|---|
| Payroll config + inputs + calculation + lock/reopen + reports | FR-028–038 | Signed calculation examples; rate packs for statutory parts |
| Compliance outputs | FR-039 | Rate packs + templates (EXT) |
| Hiring | FR-011–014 | Child schema per F1 |
| Appraisal | FR-040–044 | Competency/rating masters per F1 |
| Timesheets | FR-045–048 | — |
| Training | FR-049–050 | — |
| Lifecycle, letters, exit, settlement | FR-015–018, 051–055 | Template catalogue; settlement rate packs |

## Phase 5 – Wave 2 hardening & UAT (weeks 69–80)
Payroll reconciliation against signed examples (ZT16/17), migration rehearsal (ZT19), full ZT01–ZT30 re-run.

## Scale track (parallel, weeks 1–96)
| Step | Timing |
|---|---|
| Cell/partition design, partition keys, cross-partition FK strategy (G3) | Phase 0–1 |
| Load harness (open-loop, distinct identities, generator health) | Phase 1–2 |
| Staged tests 10K → 100K → 1M | During wave 1 |
| 5M → 10M, burst, 24 h soak, zone/region failover (ZT31–35) | After wave 2 or earlier for wave 1 scope; needs infrastructure budget |

## Timeline summary – revised 24 Oct 2026 for Claude-driven development
Code generation is no longer the bottleneck. These are:
- your review/run cadence,
- owner decisions and acceptance,
- external inputs,
- real infrastructure for scale tests.

Estimates assume active sessions on most working days.

| Milestone | Claude work | Human-gated part | Estimate |
|---|---|---|---|
| Phase 0–1 platform core (tenancy, RBAC, workflow, audit, outbox, imports) | ~3–5 weeks of sessions | Review of RBAC/security code | Month 1–1.5 |
| Wave 1 modules coded with tests | ~8–12 weeks | Module reviews | Month 3–4 |
| Wave 1 owner acceptance | Fixes | HR/Finance/Access/QA acceptance | Month 4–5 |
| Wave 2 coded (payroll engine, hiring, appraisal, timesheet, training, exit) | ~8–12 weeks | Signed payroll examples; **rate packs** | Month 6–8 |
| Scale track: harness + IaC + 10K→1M staged runs | Ongoing from month 2 | Cloud account, budget, quotas | Month 4–8 |
| 10M certification (ZT31–35) | Tuning and fixes | Large multi-region test infra, cost approval, platform operator | Month 8–12 |

Previous figures (12-person human team: 10–11 / 18–20 / 20–24 months) are superseded.

## Progress snapshot (25 Oct 2026)
| Area | Status |
|---|---|
| Phase 0 foundation (registers, ADR, repo, test DB) | Done |
| Phase 1 platform core: tenancy, access engine (C1/DB109/BR-044), audit, outbox, workflow engine, imports schema | Done (API slices; export download re-authorization and idle sessions pending) |
| Wave 1 stream A: Employee & org | Done for create/update/list/detail/history/activation, documents (confidential grant, audited reads) and CSV bulk import (preview, commit); bulk update imports pending |
| Wave 1 stream B: Attendance & leave | Done for policies, accrual, ledger, requests, routing, decisions, punch import, daily evaluation, amendments, resubmission after return (new revision), controlled cancellation of approved leave, outdoor duty and work-on-holiday requests (FR-027; evidence files pending) |
| Wave 1 stream C: Biometric API | Done with provider-independent engine and fake provider; real adapters need provider contracts (DF13); scheduler pending |
| Wave 1 stream D: Confirmation | Done (overrides and reminders pending) |
| Wave 1 stream E: Notifications | In-app done; email, reminders and scheduler pending |
| Wave 1 stream F: History & increments | Done for salary arrangements, common-date cycles, proposals, independent approval, atomic application, history, annual growth; anniversary cycles, overrides, components pending |
| Wave 1 stream G: Expense & payment | Done for drafts, validation, 3-step route, line decisions, obligation, manual payment ledger; receipt upload and confidential receipt viewing; expense reports pending |
| Wave 1 stream H: My Team & dashboards | Done for My Team list/detail and 14 role dashboards; reports/exports (FR-056/065/093) pending |
| Reports & exports | Done: 6 reports, worker generation, re-authorised expiring downloads, formula-safe CSV |
| Sessions, reminders, scheduler | Done: idle/absolute/revoked sessions, approval reminders/escalation, confirmation reminders, scheduler ledger |
| File store | Done: content-addressed FileStore (memory/local; S3-compatible required in production) |
| Cross-cutting pending | Confirmation overrides, anniversary cycles, work-request evidence files |
| Web frontend (React) | First version: sign-in, role selection, dashboard, My Team, employees, leave, expenses, decision inbox (incl. finance line decisions), payments, notifications, reports, employee import, employee documents; confirmation/increment management and access administration screens pending |
| Developer experience | Embedded dev database, idempotent synthetic seed, README run guide |
| Scale track | Not started |

As of run 20: 19 migrations, 23 API test files with 222 tests and 7 web tests passing (≈ 95 s per full API run).

## Module completion report (used after every slice)
1 Delivered FR/BR · 2 Schema/constraints/migration results · 3 Role/field/scope restrictions + denied cases · 4 Tests run / not run with evidence · 5 Reconciliation & concurrency · 6 Defects, open decisions, deferrals · 7 Readiness (design-only / in progress / ready for owner acceptance / accepted with evidence).
