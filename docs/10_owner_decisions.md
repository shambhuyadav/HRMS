# 10 Owner decisions

Status 6 Nov 2026, after Run 35. Everything that can be built from the BRD alone is built and tested: Run 35 passed 3,085 backend tests and 1,102 screen tests with none failing, and every one of the 299 permissions has an allowed test and a refused test. What remains needs you or an outside input.

Answer by number, for example "A3: option b". Where something is already built, it says so: that choice stays unless you change it. The source of each item is in `docs/03_decision_register.md` (the I- number).

**6 Nov 2026: the owner delegated the open decisions to the developers, with safeguards.** Amounts, rates and limits become dated settings HR can change; tax, PF, ESIC, PT and Form 16 packs are seeded switched off until an authorised person checks and activates them; the bank file format, the old system's data and the capacity environment cannot be decided and stay open. Items marked "Decided (I-7x)" below were decided under that delegation and can still be changed by the owner.

## A. Decisions that unblock features not yet built

These are the reasons for the 63 "Blocked" rows in the verification register (60 after Run 35; ZT16, FR-020 and FR-039 were moved to Blocked on 6 Nov, because their BRD clauses need owner-approved fixtures, test vectors or templates).

**Payroll**
1. Decided (I-79): arrears (FR-035) and late-timesheet adjustments (FR-100) are calculated from the frozen records under a dated valuation policy that one person drafts and another activates. They are paid once, in the employee's next run; closed periods never reopen; tax is applied in the month paid.
2. Decided (I-76): masters changed after calculation. Processing is refused with `MASTERS_CHANGED` and a new revision calculates afresh (I-28).
3. Decided (I-76): each day is valued with the salary arrangement in force that day; a month spanning a change is split (CI07).
4. Decided (I-80): each grade may have a dated salary structure that splits CTC into components by percentages, fixed amounts and a balancing line. One person drafts it and another activates it. A salary for that grade must match it. "CTC category" is a company list recorded on each salary.
4a. Decided (I-91): outside deduction codes (canteen, society, insurance and the like) map to payroll deduction heads from a date. One person drafts each mapping and another activates it. Payroll input files may use those codes; an unknown, unmapped or retired code rejects the row, and never falls to a default.
5. Decided (I-80): the estimated in-hand figure is earnings plus reimbursements less fixed employee deductions, before income tax and statutory deductions. It is labelled as an estimate, not a payslip.
6. Decided (I-80, I-87): payroll, salary, increments, settlements, loans and offers use the currency of an active payroll calendar, which needs a second person to activate. INR is the company currency. Other currencies (USD, EUR, GBP, AED, SGD) are listed but unused until activated. Expense lines may use another currency once Finance enables it; each line is converted once at a dated company rate and repaid in INR (OQ-17; I-72 item 1).
7. Decided (I-81): early settlement closes a loan in full. The balance splits into a repaid part, backed by evidence, and a waived part, which needs a separate waive right no role has by default. Someone other than the recorder and the borrower approves it.
8. Decided (I-80): "outstanding" held salary is what is owed until its payment is confirmed. Payments in progress stay in it and are also shown separately. It is counted once per payroll record, never above its net pay.

**Exit and settlement**

9. Decided (I-81): a settlement is paid outside the system and recorded from evidence by a separate person. The disbursement month is the month of the payment date.
10. Decided (I-81): records approved for days after the last working date are kept and listed for HR. HR may enter a resignation given outside the system, with evidence.
11. Decided (I-81): at separation the leaver's roles end, except their own self-service, so payslips and letters stay reachable. Their pending approvals are rerouted; account deactivation stays manual.
11a. **Sign-off needed (quick review):** the BRD (FR-055) makes these closure actions depend on an offboarding policy you approve. Reply "11a approved" or say what to change.
12. Decided (I-81, I-88): a component already paid in a monthly payroll for the final period blocks the settlement; it never just warns. The settlement is calculated from a frozen snapshot: earnings due, leave encashment (Basic + DA ÷ 30 by default, capped), notice shortfall (waivable by a separate approver), loans, pending arrears and gratuity. Gratuity's statutory pack stays switched off until an authorised person checks it against current law and activates it.
12a. **Sign-off needed (quick review):** the worked settlement examples A to F in I-88. For example, a mid-month leaver nets 18,369.89, and gratuity for 7 years on 36,000 is 1,45,384.62. FR-052 asks you to approve them. Reply "12a approved" or say what to change.
13. Decided (I-81): an approved withdrawal cancels a settlement before release; once released for payment, it must be paid or voided first.
14. Decided (I-81): uploaded lists match exact employee codes only; unknown and out-of-scope codes read the same.
14a. Decided (I-81): "send" means delivery to the employee's own self-service, never e-mail (FR-054, FR-018). A claim already reimbursed through payroll needs a recorded review before any direct payment (BR-024).

**Hiring and employee records**

15. Decided (I-82): HR writes the offer letter template. Its figures come only from the approved offer. HR downloads the letter, hands it over and records the delivery; the system never e-mails it.
16. Decided (I-82): fields for family, qualifications, previous employment and payroll identifiers (PAN, UAN, ESIC). All are confidential; identifiers are shown masked except to holders of a separate right; Aadhaar is not collected.
16a. **Sign-off needed (quick review):** FR-007 asks you to approve the export columns before release. The new family, qualification and previous-employment exports list the fields in item 16, never identifiers. Reply "16a approved" or say what to change.
17. Decided (I-82): Offered, Offered Rejected, Current (which includes people on notice), On Probation, On Notice and Left are views on the employee list.
18. Decided (I-82): CV text becomes searchable only after an HR Admin approves it, for a scanned file of a consenting candidate. Search returns a match flag, never the text.

**Attendance and leave**

19. Decided (I-78): the shift buffer is each shift's punch window before its start and after its end, set per shift with no default; the overnight flag is the only 24-hour indicator (FR-005/BR-008).
20. Decided (I-78): each leave policy names the month its leave year starts; a year-end run expires units above the carry cap, never below zero (FR-024/025).
21. Decided (I-78): weekly-off patterns can add days off on given weeks (for example 2nd and 4th Saturdays) and half weekly-offs (I-48 item 6).
22. Decided (I-78): overtime candidates per policy (basis, minimum, rounding down); nothing pays overtime yet (DF05).
23. Decided (I-78): organisation is the employing company; late minutes run from the shift start on a late day (E07).
23a. **Sign-off needed (quick review):** the midnight and threshold test cases and the next-day out-time rule are built and tested (I-78 item 2). FR-020, FR-005 and BR-008 ask for your approval of them; reply "23a approved" or say what to change.

**Appraisal**

24. Decided (I-77): each reviewer gives one overall score 1–5 when confirming; it is kept separately and does not change the manager's final rating (FR-043).
25. Decided (I-77): a cycle setting of 0, 1 or 2 reviewer levels; 0 means the manager's approval completes the appraisal; the default is 1 (FR-043/BR-013).
26. Decided (I-77): KRA review before goals take effect, on by default for new cycles, by someone other than the person who set the goals (FR-041).
27. Decided (I-77): a cycle setting for formula or manual rating; in manual mode the manager also enters an overall 1–5 rating, which becomes final (FR-042/BR-014).
28. Decided (I-77): rating tasks are due when the rating window closes, reviewer tasks on the cycle's review due date; overdue is counted from those dates.
28a. Decided (I-86): grade-mapped competencies with weights totalling 100. A dated goals/competencies split, 70/30 by default, that HR can change. Four unscored sections chosen per cycle; an excluded section never blocks submission.
28b. **Sign-off needed (quick review):** the worked appraisal examples A to E in I-86. For example, goal score 4.10 and competency score 3.10 give 3.80 under 70/30, and 3.245 rounds half up to 3.25. FR-042 and BR-014 ask you to approve these results. Reply "28b approved" or say what to change.

**Reports and dashboards**

29. Every report's columns need your approval with sample outputs before release (BRD section 11; I-40 item 12). The reimbursement register's columns and source are not defined at all (item 11).
30. Decided (I-83): the salary progression chart shows one employee's monthly fixed pay (or annual CTC) by financial year, over the last 5 years by default. Only roles holding both salary rights see it.
31. Decided (I-83): Treasury Approver and Expense Finance Approver may hold organisation scope, so their figures count real items. Small people-counts show as "Fewer than 5" (the threshold is a dated setting HR can change).
32. Decided (I-76): the payroll run list has a financial-year filter, using each payroll calendar's own year label (BR-012).

**Release and migration**

33. Decided (I-84): "delivered" means every row not Blocked, and each must pass. A release is blocked by `npm run release:gate`, which fails on any failing or unevidenced delivered row, any open item here that touches one, a privacy finding or a pre-go-live finding. Nobody overrides it (ZT20, BR-028).
34. Decided (I-76): a retried payroll run creation by the same preparer gets the run it already created; nothing is created twice (FR-063).
35. Data migration needs authorised extracts from the old system before anything can be validated (OQ-19: DQ-01 to DQ-15, ZT19).

## B. Who holds which rights

Each right below is built, but no baseline role holds it, or the BRD names no holder. Until you say who, nobody can use it.

1. Decided (I-84): the HR Administrator reroutes a stuck task (a default duty); the approval rule picks the new reviewer, and nobody reroutes their own request.
2. Decided (I-84): an HR Administrator granted the right may approve a System Administrator's role change. An account shared with another company is deactivated only by the last company that uses it. Reactivating a company is a platform step outside the application.
3. Decided: `access.delegate` is a default duty of managers and HR, since each delegation still needs an independent approval (I-84). `team.export` stays a right to grant, not a default, because it takes personal data off the system (I-83).
4. Decided (I-84): as built. Celebrations are visible to employees. Report exports and salary history are rights to grant per assignment, never defaults.
5. Decided (I-84): the settlement export right is granted only to the HR Administrators who prepare, review or approve settlements. A Treasury "payment preparation task" is an approved, unpaid claim awaiting preparation, or the operator's own draft batch.
6. Decided (I-84): the System Administrator approves role changes, and HR approves notification rules (their author never publishes their own).
7. Decided (I-84): neither. No custom roles at go-live; ceilings change only through the approved role-change process.

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

Under the owner's delegation (6 Nov 2026), each of these readings stands as decided. They are listed so you can change any of them later.

## D. Outside inputs needed

1. Tax rule pack: regimes, categories and limits (FR-036/108), and the Form 16 template (FR-107).
2. A bank-accepted bank file specification with sample validation (FR-102).
3. State professional tax slabs and the TDS challan format (FR-028). Draft PF, ESIC and professional tax packs (Maharashtra, Karnataka) are built and switched off (I-85). An authorised person must check each against the law in force before a second person activates it.
4. NPS, EDOC and liability-provision output specifications (FR-038).
5. The biometric device export format (OQ-23).
6. A text-extraction component for CV search (FR-013).
7. A capacity test environment (G4) for the 10-million-user tests ZT31 to ZT35.
8. A production identity provider, malware scanner and email, SMS and push delivery.

## E. Handover and go-live steps (need your go-ahead or timing)

1. Apply migrations 0144 and 0160 in a quiet window, and run `npm run db:check-go-live` on a copy of the live database first.
2. The development database (`.dev-pg`) must be rebuilt, because an applied migration's comment changed.
3. Done 6 Nov (owner: replace). No shared password remains in `README.md`, `.env.example`, `docker-compose.yml` or `db/dev-db.ts`; each developer sets `DEV_DB_PASSWORD`. An existing `.dev-pg` keeps its old password until rebuilt (E2). (I-75 item 8)
4. The code reached `github.com/shambhuyadav/HRMS` on 4 Nov under that account. Nothing has been pushed since; confirm where the code should live.
5. Decided (I-84): a file whose scan keeps failing stays unusable, and the uploader is told. A System Administrator may requeue it with a reason. Small payroll and settlement uploads are still scanned during the request, under a time and concurrency limit.
6. Database housekeeping: `NOT NULL` on `created_by` for 194 more tables, and `updated_by`/`updated_at` for 41 tables, or an approved exception (I-72 item 2).
7. Existing companies' Employee assignments cannot gain the new right to read delivered documents, because an approved grant's list is fixed (0099). Those employees need fresh assignments at go-live (I-81).
