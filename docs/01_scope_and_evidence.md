# 01 Scope and Evidence Summary

## Observed (source evidence, Administrator session only)
- 17 screen/area records E01–E17 (login/home, employee master, shift, attendance policy, leave policy, attendance control, salary master, payroll controller, talent acquisition list, appraisal config, resource allocation, training plan, full & final, process master, user rights, report/menu inventory).
- 259 Coverage Log entries: 258 Documented, 0 Restricted, 1 Not reachable (CL-219 Talent Acquisition → New returned an application error).
- Observations are labels, filters, grid columns and explanatory text. No save/approve/upload/process/payment was executed.

## Menu-only (label seen, internals unverified)
Most of the Payroll inputs/reports/compliance menus, Hiring masters, ELC/letters, the audit-trail menus, the analytics reports, EOD utility, mobile linking, biometric upload. A menu label is **not** a confirmed workflow, form or formula.

## Proposed target (new system, not source behaviour)
- All FR detail behaviour, all 109 proposed tables / 201 FKs, the RBAC model (C1–C7), the workflow/state catalogues, and the expense module (a requested extension with no verified source screen).
- Requested additions dated 6 Oct 2026: FR-080–FR-093 (confirmation, notifications, biometric API, history/increment %, increment cycles).
- Requested additions in v7.1/8.x: FR-094–FR-098 (My Team, role dashboards, confidentiality), DB109 assignment narrowing, NFR-S01–S12 (10M concurrent users).
- Appendix F selects the business policy for each of these.

## Excluded
Changing the reference application; live payroll/payment; importing real records; sending real messages; copying vendor code or branding. Optional or not selected: asset issue/return, native mobile app, expense advances, corporate cards, travel booking, receipt OCR, mileage, foreign-currency expenses (wave 1), automatic accounting posting, direct bank transfer (wave 1).

## Blocked (external input needed; independent work continues)
| Blocker | Blocks | Does not block |
|---|---|---|
| Statutory/tax/PF/ESIC/PT/LWF/gratuity rate packs and templates | Live payroll calculation approval, statutory outputs, F&F settlement | Payroll lifecycle, proration engine, synthetic fixtures |
| Biometric provider contract (auth, pagination, schema samples) | Activating a live profile | Adapter, mapping engine, quarantine, checkpointing |
| Email/notification service config | External email channel | In-app notifications (the initial channel) |
| Contractual notice values, activation of leave/expense defaults | Activating those policies | Policy engine, DRAFT policy seeds |
| Authorised source extracts and role walkthroughs | Migration, source-parity sign-off | New-app build on synthetic data |
| Infrastructure budget/quotas | ZT31–ZT35 full-scale proof | Cell architecture, harness, staged tests at lower scale |
| Owner acceptance of OQ27 confidentiality impact | Release of workflows where ineligible roles need confidential values | Building them in the eligible-Admin context (DF02) |

## Readiness
**Design-only.** No runtime verification exists.
