# 10 Owner decisions

Status 6 Nov 2026, after Run 35. Everything that can be built from the BRD alone is built and tested: Run 35 passed 3,085 backend tests and 1,102 screen tests with none failing, and every one of the 299 permissions has an allowed test and a refused test. What remains needs you or an outside input.

Answer by number, for example "A3: option b". Where something is already built, it says so: that choice stays unless you change it. The source of each item is in `docs/03_decision_register.md` (the I- number).

## A. Decisions that unblock features not yet built

These are the reasons for the 60 "Blocked" rows in the verification register.

**Payroll**
1. Arrears and closed periods (FR-035), and late-timesheet adjustments (FR-100): how a difference found after a month is closed is valued and paid, and how tax differences are treated. Case records are built; nothing calculates. (I-70)
2. Masters changed after calculation (I-28): a salary change, unpaid leave or exit date approved after a run was calculated is currently frozen and can only come back as a later adjustment. Proposal: refuse processing (`MASTERS_CHANGED`) and require a new revision. Yes or no?
3. Which date decides the salary arrangement used for a month (CI07; I-75 item 4)?
4. Grade salary structures: the rules that turn CTC into components, the grade mapping and external deduction mapping (FR-028/029; I-40 items 1, 9: also define "CTC category").
5. The estimated in-hand formula (BR-011; I-40 item 10). Nothing is shown until you approve one.
6. Which currencies payroll, salary, hiring, loans, increments, settlements and training support (OQ-17; I-72 item 1). Today INR only.
7. Loan early settlement: route, waiver or write-off, evidence and approver (FR-034; I-48 item 12).
8. Held salary "outstanding" figure (H7; I-45): pending reservations count in one BRD rule and not in another. Which?

**Exit and settlement**

9. How a settlement is paid: a final-settlement payroll run, or a manual outcome with evidence (FR-053/054; I-40 item 2).
10. What an approved exit does to leave, allocations and timesheets already approved after the last working date, and whether HR may enter an exit for an employee (FR-051; I-40 item 4).
11. Offboarding: when a leaver's roles end, which self-service access survives, what happens to their pending tasks (FR-055; I-48 item 13).
12. What "already paid" means between a settlement and monthly payroll, and whether it blocks or warns (FR-052; I-48 item 14).
13. What an approved resignation withdrawal does to a settlement already under way (FR-051/053; I-48 item 15).
14. Matching rules when selecting employees from an uploaded list (FR-054; I-48 item 16).

**Hiring and employee records**

15. Offer letters while an offer is being made, before the candidate is an employee (FR-014/017; I-48 item 2).
16. Field list for family, qualifications, previous employment and payroll identifiers: fields, which are required, which are confidential (FR-007/008; I-48 item 3).
17. Should "Offered" and "Offered Rejected" be views on the employee list, and should "Current" include people on notice? Built: no such views; Current includes On Notice (BR-003; I-75 item 1).
18. What counts as approved searchable CV content (FR-013; I-40 item 7).

**Attendance and leave**

19. Shift buffer: its meaning and range, and whether a 24-hour-cycle indicator means more than the overnight flag (FR-005/BR-008; I-48 item 4).
20. Leave-year boundary, and the year-end expiry above the carry-forward cap (FR-024/025; I-48 item 5).
21. Half weekly-offs and Saturday-working patterns beyond Monday to Friday (I-48 item 6; I-53).
22. Overtime: basis, rounding, punch pairing and precedence (DF05; I-48 item 1).
23. Definitions of working organisation, entity and late minutes for attendance control (E07; I-54 item 1).

**Appraisal**

24. Reviewer scores: per goal or overall, at each level, and their effect on the final rating (FR-043; I-48 item 7).
25. Does level 1 complete at the manager's approval without an HR reviewer (FR-043/BR-013; I-48 item 8)?
26. Should KRA setting be reviewed before goals take effect (FR-041; I-48 item 9)?
27. Manual rating mode (FR-042/BR-014; I-48 item 10).
28. Due dates for appraisal reviewer tasks, so "overdue" can be counted (I-40 item 6).

**Reports and dashboards**

29. Every report's columns need your approval with sample outputs before release (BRD section 11; I-40 item 12). The reimbursement register's columns and source are not defined at all (item 11).
30. Salary progression chart: what it measures, its grouping and span (FR-038; I-48 item 11).
31. Treasury Approver and Expense Finance Approver dashboard figures can only show 0 under the BRD's access rules. Widen the rules, add tasks, or show "not available" (BR-045, FR-096/097; I-74 items 1, 2)?
32. Is a financial-year filter needed on the payroll run list (BR-012; I-75 item 2)?

**Release and migration**

33. What counts as "delivered" while some rows are blocked on your inputs, and who or what blocks a release (ZT20, BR-028; I-75 items 6, 7).
34. Should payroll run creation take a retry key, so a retried request gets its first answer back? Today a retry is refused, with no second run (FR-063; I-75 item 5).
35. Data migration needs authorised extracts from the old system before anything can be validated (OQ-19: DQ-01 to DQ-15, ZT19).

## B. Who holds which rights

Each right below is built, but no baseline role holds it, or the BRD names no holder. Until you say who, nobody can use it.

1. Who approves rerouting a stuck task (I-52 item 1)? Today nobody can.
2. Who approves a System Administrator's role change (I-71 item 2), deactivates a multi-company account, or reactivates a company (I-55 items 1, 2)?
3. Should these be default duties: `access.delegate` (I-57 item 1), `team.export` (I-62 item 1)?
4. Who holds `celebration.read` and the report export rights (I-66 item 2), and the financial history rights (I-68 item 4)?
5. Which HR roles get the settlement export right; what is a Treasury "payment preparation task" (I-56 items 2, 3)?
6. Who approves role changes and notification rules: built as `access.approve_role_grant` and `notification.approve_rules` (I-71 item 1).
7. Widen the baseline role ceilings, or add custom roles (I-71 item 3)? Built: neither.

## C. Confirm or change what was built

Where the BRD was silent, a reading was built and recorded. Each stays as built unless you change it. They are listed in full in the register; the areas are:

- Expense: payment duties, flag clearance, receipt checks, policy limits and category rules (I-49, I-61, I-74 items 4, 7, 13).
- Loans and payroll reads: loan blocking, single-approver reversal, run totals (I-51).
- Access: former managers' tasks, Treasury and Payroll Approver scope, delegation limits, re-checks when a reviewer moves (I-52, I-57, I-60, I-69, I-74 items 11, 12, 14).
- Attendance and leave controls, calendars, biometric corrections (I-53, I-54, I-58, I-63, I-74 item 10).
- Notices: who is told about increments, payments, sync runs and withdrawals (I-59, I-71 item 5).
- Confirmations, increments and employee records: reopening after withdrawal, correcting an applied increment, employment-type changes, org-history correction, timeline detail (I-50, I-64, I-65, I-67, I-68).
- Dashboards and My Team (I-62, I-74 items 3, 8, 9).
- Large company-wide jobs that stop part-way (I-34).

## D. Outside inputs needed

1. Tax rule pack: regimes, categories and limits (FR-036/108), and the Form 16 template (FR-107).
2. A bank-accepted bank file specification with sample validation (FR-102).
3. State professional tax slabs and the TDS challan format (FR-028).
4. NPS, EDOC and liability-provision output specifications (FR-038).
5. The biometric device export format (OQ-23).
6. A text-extraction component for CV search (FR-013).
7. A capacity test environment (G4) for the 10-million-user tests ZT31 to ZT35.
8. A production identity provider, malware scanner and email, SMS and push delivery.

## E. Handover and go-live steps (need your go-ahead or timing)

1. Apply migrations 0144 and 0160 in a quiet window, and run `npm run db:check-go-live` on a copy of the live database first.
2. The development database (`.dev-pg`) must be rebuilt, because an applied migration's comment changed.
3. `README.md`, `.env.example` and `docker-compose.yml` hold a local-only default password: keep, or replace before handover (I-75 item 8)?
4. The code reached `github.com/shambhuyadav/HRMS` on 4 Nov under that account. Nothing has been pushed since; confirm where the code should live.
5. A file whose malware scan keeps failing stays waiting with no notice to the uploader. Which end state, who may requeue it, and is a notice sent (I-73 item 1)? Payroll input and settlement line uploads still wait for the scanner during the request (I-73 item 2).
6. Database housekeeping: `NOT NULL` on `created_by` for 194 more tables, and `updated_by`/`updated_at` for 41 tables, or an approved exception (I-72 item 2).
