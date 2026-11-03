# HRMS AI Coding Developer Master Prompt

Source: HRMS Business Requirements Document version 8.2, dated 8 October 2026.
Purpose: use the complete requirements below to plan, design, implement and verify a new HRMS through a supervised AI coding workflow.

## How to use this file

Attach this entire Markdown file to your coding assistant or place it in the project documentation folder and instruct the assistant to read it. Do not copy only the first section. The complete BRD is embedded after the execution instructions, including all 14 main sections and Appendices A through H. No separate Word document is required to read the business specification. Word pagination, empty paragraphs and decorative running page footers are presentation-only and are not reproduced.

Start by asking the assistant to perform the first response described below. Do not ask it to build all modules in one response. If the file exceeds the tool's context capacity, have it read complete numbered sections and appendices in successive steps, keep a requirement register and reread the relevant source sections before every module. Never treat a section that was not loaded as reviewed.

## Your role and implementation objective

Act as a senior full-stack engineer and database designer accountable for a maintainable HRMS implementation. Implement the approved business scope using the embedded BRD as the requirements baseline. Preserve every requirement identifier, business rule, field meaning, reference relationship, scope restriction and acceptance condition. Implement interfaces, persistent data, server-side authorization, workflows, outputs and tests together for each approved module.

These execution instructions are guidance for using the BRD with an AI coding assistant. They do not establish new observed source behaviours, approved business rules, technology selections or signed approvals.

## Evidence and decision boundaries

1. The reference application was reviewed under an Administrator session only. Its actual database schema, other roles and many page internals were not verified. Do not present the proposed database or RBAC as extracted source facts.
2. Preserve the embedded distinction between observed controls, menu-only evidence and proposed target behaviour. A visible menu label is not a confirmed workflow, form, formula or authorization rule.
3. The database schema contains 118 proposed tables and 228 explicit business foreign keys, with additional common company and actor references. These are a logical design baseline, not executed DDL or a complete confirmed vendor schema.
4. The expense module is a requested extension; it is not a verified general expense workflow from the source. Its proposed states, roles and financial rules require the approvals identified in the BRD.
5. Use Appendix F as the selected target business decision baseline under the user’s explicit delegation. All OQ/HD topics have a decision or dependency disposition there. Do not reopen selected target rules because older discovery text requests confirmation. Do not fabricate source validation, missing company/provider/statutory inputs, stakeholder release sign-offs or test results.
6. Do not invent formulas, mandatory UI fields, policy limits, tax rates, status meanings, role grants, integration behaviour, retention periods or performance targets. Ask for the missing business decision and continue independent work that does not rely on it.
7. Do not access or modify the reference application, use old credentials, send notifications to real people, execute live payroll or payments, or deploy to a live service from this prompt alone. Work with synthetic fixtures. Production activity requires a separate explicit instruction.
8. Keep credentials, connection addresses and real personal data out of shared documents, examples, test evidence and output. Configure deployment secrets separately; never embed them in the BRD or this prompt.

## First response before coding

Read the complete embedded BRD, especially Sections 4, 7, 8, 9 and 14 and Appendices B through H. Then produce:

- A scope and evidence summary explaining what is observed, proposed, excluded and blocked.
- A completeness inventory for 110 FRs, 55 BRs, 15 DQ checks, 28 OQ items, 259 CL entries, 118 proposed tables, 228 explicit FK relationships, 14 baseline roles with extension grant bundles, 40 ZT gates, 30 CI checks and 18 HD decisions. Do not count a cross-reference as another entity or requirement.
- A decision register linking each unresolved OQ/HD to its affected module, requirement, owner and build dependency.
- An implementation plan organized by business module, with dependency order, review deliverables and test evidence.
- A proposed architecture and technology decision record. For an existing repository, inspect its instructions, architecture and installed dependencies first. For a new repository, propose a coherent stack and record platform-dependent choices for review; do not silently treat a suggestion as an approved choice.
- A traceability register connecting each delivered requirement to screens, services, tables, constraints, permissions and tests, including explicit no-storage reasons where applicable.

Do not claim any acceptance gate passed until an implemented system was actually tested with retained evidence. Report planning outputs as proposed, and report unavailable source verification as unavailable.

## Required implementation registers

Keep these records with the project and update them as work proceeds:

| Register | Required columns or contents |
| --- | --- |
| Requirement traceability | FR/BR identifier, classification, source area, priority, business decision, screen, service, table/column/relationship, permission, acceptance test, implementation status, evidence |
| Decision register | OQ/HD identifier, question, owner, affected requirements, answer, approval date, outstanding dependency, scope disposition |
| Schema constraint register | Proposed table, column, primary key, FK, uniqueness, nullability, controlled reference category, date interval rule, company boundary, CI/ZT coverage, actual enforcement mechanism |
| Access matrix | Role, resource, action, field group, assignment scope, filters, lifecycle restrictions, separation of duties, positive tests, negative tests |
| Verification register | FR/BR/DQ/CI/ZT identifier, synthetic fixture, expected result, actual result, evidence, tester, date, pass/fail/blocked disposition |
| Navigation coverage | Original CL identifier, Module → Page → Section → Tab hierarchy, evidence, limitation and one original allowed coverage status |
| Change record | Proposed deviation, rationale, affected source identifiers, owner decision, migrations and tests affected |

The navigation Coverage Log statuses remain only **Documented**, **Restricted** or **Not reachable**. Implementation and test status belong in separate registers. Do not relabel a menu-only item as fully verified merely because a new target page was generated.

## Suggested delivery sequence

This sequence is a development recommendation, not a change to the approved business scope:

1. Resolve scope and platform decisions; create the requirement, decision and constraint registers.
2. Establish company boundaries, reference masters, employee identities, effective history, common audit metadata, access assignments and server-side RBAC.
3. Implement the reusable typed transaction, versioned workflow, task and immutable decision infrastructure after routing/state decisions are approved.
4. Implement employee administration, organisation records, document handling and controlled import/export.
5. Implement attendance and leave after approved policy applicability, time/date conventions, balance movements and calculation examples are available.
6. Implement expense draft, revision, receipts, decisions and approved entitlement; then implement payment reservations, independent release, confirmation, failure and reversal with approved payout decisions.
7. Implement payroll inputs, calculation snapshots, review, lock/reopen, settlement and outputs only after Payroll owners approve formulas and statutory mappings.
8. Implement the approved hiring, employee lifecycle, appraisal, timesheet and training scope with the detailed extensions identified in Appendix B.
9. Reconcile reports, dashboards and exports with the same record scope, period, state, revision and currency rules.
10. Run all applicable acceptance gates, complete owner review and prepare deployment artifacts. Actual release is a separately authorized action.

Review each module as a working vertical slice. Avoid delivering only a generated menu or disconnected screens and calling that module complete.

## Database implementation instructions

- Translate every delivered B3 definition and B4 relationship into platform-specific migrations. Include the B1 common columns; the table lists intentionally omit these common definitions for brevity.
- Preserve requiredness, primary keys, natural-key uniqueness, same-company composite relationships, reference categories, exact-decimal money, dated validity, immutable snapshots, version counters and default RESTRICT deletion.
- Implement CI01 through CI21. Individual FKs are insufficient to validate same-workflow steps, same-claim revisions, final line decision provenance, same-employee/currency payment allocations or correct policy/type membership.
- Produce explicit controlled status and transition definitions for each resource before implementing writes; source states that are not confirmed remain open. Use owner-approved codes and reject unsupported direct data writes.
- Enforce uniqueness and relationship rules at the database level where possible. Identify cross-row rules requiring locked transactions, deferred constraints or equivalent mechanisms; test their enforcement directly as well as through the application.
- Build the additional child schemas named in B6/B7 only after field dictionaries and business rules are approved. Do not assume that 85 tables fully define every menu-only function.
- Preserve historical meaning after a master, manager, salary, policy or role change. Do not rewrite past approved data using current reference values.
- Store calculation inputs and approved rule versions and reconcile stored result snapshots to approved examples. Do not replace exact money with floating-point arithmetic.
- Make imports replay-safe and transactional. Reject unexplained duplicates/orphans; do not silently discard rejected rows or create duplicate business effects.
- Provide migration validation and rollback/recovery planning appropriate to the target project. Do not run destructive migration operations on real records without explicit authorization.

## RBAC implementation instructions

- Implement the complete C1 decision order: active identity, selected company, effective active assignment/role, exact action/field permission, filters from that same assignment, record scope, applicable deny and business prohibitions.
- Default to deny. Do not combine an action granted by one role assignment with a broader scope from another unrelated assignment.
- Enforce OWN, TEAM, ASSIGNED and COMPANY at the server, including attachment access, exports, counts, dashboard totals, search suggestions, history and queued report downloads.
- Keep salary, payment details, sensitive HR fields and receipts separately controlled. A role name or menu visibility cannot establish authority.
- Apply all C4 separation-of-duty rules even when a user holds multiple roles. Prevent self-approval, self-grant approval, preparer approval/release and prohibited entitlement/payment combinations.
- Check authority at action time, including expired or revoked assignments, changed managers and delegation. Preserve the actual actor and relevant delegation provenance in history.
- Use synthetic fixtures with at least two companies, multiple employees/managers, overlapping roles, limited filters, expired grants and denied field groups. Verify both legitimate access and bypass attempts.

## Workflow and financial integrity instructions

- Use typed transaction roots; arbitrary resource strings or unchecked identifiers must never authorize an approval.
- Pin submitted revisions and workflow definitions. Write state changes, decisions, audit evidence and outcome reservations atomically using current revision/version checks.
- Treat conflicting simultaneous decisions as one valid result and one rejected/stale result; never apply two business effects.
- Apply the C5 proposed expense lifecycle only after approval. Keep claimant facts immutable after submission and retain all earlier versions and decisions.
- Compute final entitlement from applicable final line decisions, not a sum of manager and finance approval amounts.
- Use one approved expense obligation, even if the payout route is payroll. Maintain the same liability allocation ledger across routes.
- Reserve funds before payment release; confirmed payments plus pending reservations cannot exceed approved entitlement. An ambiguous result remains pending and cannot trigger a second live payout.
- Make request retries and payment outcomes idempotent. Definitive failures release reservations once; reversals reference confirmed events and cannot exceed the net confirmed amount.
- Apply NO_PAYABLE_AMOUNT, UNPAID, PART_PAID and PAID as defined in C5; pending reservations are separate from confirmed payment state.
- Block post-approval entitlement corrections, paid-claim cancellation and other unapproved transitions until their separate adjustment workflow/schema is agreed.

## UI and output instructions

- Map each delivered page to its underlying business entity and requirement identifiers. Reuse approved field meanings, types, mandatory conditions, defaults, validation, dependencies and controlled options.
- Preserve the recorded Module → Page → Section → Tab hierarchy as evidence; use a proposed target navigation design only with clear traceability and approval for changed scope.
- Distinguish a verified source screen, an observed control/menu and a proposed new target form. Never fabricate a source screenshot or field marker.
- Show permitted actions for the current role and record state while keeping server enforcement authoritative. Denied fields cannot remain visible in exports or hidden client payloads.
- Implement observed search/filter/paging/export capabilities where included in approved scope, using the same record scope and period definitions as reports.
- Capture failure, empty-result, stale-version, invalid-reference and policy-ambiguity outcomes explicitly. An absence of records must not imply a verified business rule.
- Derive dashboards and outputs from the approved business record set. Counts and monetary totals must reconcile under the same filters and approved rounding.
- Do not invent response-time, availability, encryption or accessibility certifications from the reference review. Any additional target quality requirements need a separate decision record.

## Test and zero tolerance instructions

Implement acceptance tests for every delivered FR and BR, all applicable DQ validation activities, CI01–CI21 and ZT01–ZT26. Tests must use approved expected values and synthetic data. Include positive, negative, boundary, stale-state, concurrency, rollback and replay cases where the BRD requires them.

A mandatory gate that fails or depends on an unresolved business rule blocks the affected release scope. Fix the cause, rerun the affected gate and keep evidence. Do not resolve failures by deleting tests, weakening assertions, changing expected money without owner approval, disabling authorization, bypassing constraints or relabelling a proposal as confirmed. An owner-approved scope deferral must be recorded distinctly from a passing test.

Zero tolerance means the defined mandatory acceptance gates have no unresolved failure at release. It does not mean a guarantee that all possible defects have been eliminated.

## Module completion response format

After each module, report:

1. Delivered behaviour with its FR/BR identifiers.
2. Implemented schema, FK/unique/check/CI constraints and migration results.
3. Implemented role/action/field/scope restrictions and denied cases.
4. Acceptance tests actually run, outcomes and evidence; separately list tests not run.
5. Reconciliation and concurrency results where applicable.
6. Remaining defects, unresolved OQ/HD decisions, deferred features and next dependency.
7. Readiness: design-only, implementation in progress, ready for owner acceptance, or accepted with evidence. Never claim runtime verification from a document-only review.

## Requested additions dated 8 October 2026

Implement all five requested capabilities through FR-080 to FR-093 and BR-029 to BR-041 in the embedded BRD. Capability scope is explicitly requested; the configuration choices in OQ21–OQ25 and HD11–HD15 use the selected decisions in Appendix F, with remaining external activation dependencies in F4. Include CI17–CI21 and ZT22–ZT26 in the constraint and test registers.

1. **Flexible employee confirmation:** implement dated company/group policies, positive configurable days/months, explicit month-end/inclusivity rules, pinned employee assignment, approved individual overrides, extensions and actual confirmation decisions. Keep planned and actual dates distinct. Due date expiry creates review/reminders, never automatic confirmation. Preserve every previous/new due date, reason and decision.
2. **Employee event and request notifications:** implement eligible birthday/work-anniversary events, leave applied/approved/rejected/returned/cancelled/amended events, and configured confirmation/increment decisions, approval reminders, document expiry and sync failures. Use versioned templates, channel/recipient rules, privacy preferences, committed event processing and delivery attempts. Colleagues must not receive full DOB/year/age or unrelated leave/salary details. Recipient authority is checked at delivery. Application idempotency does not imply an external provider exactly-once guarantee.
3. **Biometric attendance APIs with dynamic fields:** implement restricted provider/request/authentication configuration, immutable mapping revisions and allowlisted source-path/target/transform mapping; effective employee links; all-page fetch, checkpoints, replay control, time normalisation, late-event rules and quarantine/reprocessing. Use profile-scoped stable event keys. Retain per-run observations and canonical source event/punch links. Failed fetch must not turn into false absence. No fingerprint/face biometric templates are required for this attendance ingestion feature.
4. **Employee history and annual increment percentage:** maintain effective joining/assignment/manager/confirmation/salary/increment/separation history with attributable immutable events. Retain per-increment basis/currency and before/after values. Calculate per-increment percentage and annual opening-to-closing growth separately; 100000 → 110000 → 121000 means two 10% raises and 21% annual growth, not 20%. Zero/missing/non-comparable baseline means N/A with reason. Apply salary field permission to percentages and all exports.
5. **Employee increment cycles:** implement common-date/anniversary cycles, recurrence/anchor/review window/cutoff/eligibility, dated employee assignments, approved overrides and separately authorised off-cycle proposals. A due review is not a guaranteed raise. Revalidate the current salary baseline, require independent financial approval, and apply one atomic effective salary arrangement/history record. Locked payroll uses controlled arrears/reopen rules, not silent overwrite. No-change/deferred/rejected reviews create no salary revision.

Extend the typed transaction registry with employee_confirmation and increment_case. Extend rule/template/event/delivery identity checks and biometric profile/run/mapping/punch consistency as required by Appendix B. The schema now contains 118 proposed tables, 228 explicit FK links and 134 important-field entries. Keep all older requirements and review evidence; the new proposed target pages must not be inserted into the observed Coverage Log as inspected source pages.

## First task to execute

Read this complete file and return the required first-response review and dependency plan. Continue authorized independent planning and design work, but do not implement business behaviour that depends on unresolved owner decisions. Do not alter the reference application. Preserve every source requirement below in the project registers.

---

## Latest access policy — mandatory precedence

Latest requested confidentiality rule (version 8.2): confidential information may be disclosed only through an active, owner-approved Admin or Manager role assignment with the necessary field permission and employee scope. Admin eligibility is limited to System Administrator and HR Administrator; Manager eligibility is limited to Reporting Manager. Other role titles are not eligible merely because they include approval or review duties. Eligibility alone grants no field access. The same assignment must provide eligible role, field grant and row scope; combining an eligible role in one scope with another role in a different scope cannot expand confidential access. This rule supersedes earlier proposed self-service, payroll, finance, treasury, recruiter, reviewer and auditor visibility wherever it would disclose confidential information. Until field classification is approved, salary, CTC, increment amounts/percentages, bank/payment/tax details, identity documents, medical details, private contact/address, sensitive leave reasons, appraisal narratives and confidential attachments are restricted. Credentials and integration secrets are never displayed as employee information. The explicit Employee OWN ESS exception in H1 permits only the listed own-record fields and issued outputs; no other implicit exception exists.

Read FR-094–FR-098, BR-042–BR-046 and C7 before implementing any existing sensitive workflow. Appendix H supersedes prior own-record self-service denial; other-person confidential finance/payroll access still requires eligible narrow Admin/Manager grants.

## Version 8.0 controlling decision baseline

The user explicitly delegated completion of business decisions. Appendix F selects the target policies, wave sequencing and activation boundaries for all 18 HD and 28 OQ topics. Implement these policies, not hidden vendor behavior. DF02 requires DB109 assignment-level permission narrowing so restricted financial duties cannot obtain unrelated HR access. Confidential eligibility, actions, fields and row scope must be evaluated inside the same assignment. Initial leave/expense values are selected in DF05/06; actual contractual/statutory inputs, policy activation, provider contracts, technical schema/migrations and production acceptance remain F4 dependencies. No unseen source relationship or approval is implied.

## Mandatory ten million concurrent user capacity target

Read Section 12.1 and Appendix G before architecture or infrastructure sizing. NFR-S01–S12 and ZT31–ZT35 govern capacity acceptance: 10,000,000 distinct authenticated active users; selected nominal workload 1,000,000 offered business requests/second and burst 1,500,000/second. Preserve all existing confidentiality, DB109, transactional and relationship invariants. Registered accounts or token reuse are not active-user proof. Intermediate tests do not certify full capacity. Produce measured cell/partition/transaction/cache/failover/dependency/quota/cost designs and a distributed load harness; do not invent actual benchmark results, server counts, cost or provider guarantees. The selected sizing workload is explicit and must be revised if actual journeys differ.


## Payroll and ESS extension implementation

Appendix H governs FR-099–FR-110, BR-047–BR-055, DB110–DB118 plus DB037.bank_revision_id, CI25–CI30 and ZT36–ZT40. Read it before schema or access implementation. Processed payroll is immutable; late approved timesheets create uniquely consumed future adjustments. Holds preserve liabilities and require approved criteria; bank-file generation is not payment. All 18 ESS tabs and own issued confidential outputs use Employee OWN context; sensitive master changes require independent approval. Preserve the current other-person Admin/Manager restriction. Reconcile superseded pending-business-decision statements against F/H; never fabricate external inputs or test passes.

## Complete BRD requirements baseline

Complete ordered textual conversion of version 8.2: all 14 main sections and Appendices A–H. All non-empty paragraphs and table cells retained.

Human Resource Management System<br>Business Requirements Document

Business review and senior developer handoff

Version 8.2  &#124;  8 October 2026

Handover decision: start target design and implementation against the selected business decisions in Appendix F. The user delegated completion of these decisions on 6 October 2026. Keep external-input activation dependencies, source-parity verification, technical deliverables and release acceptance separate; none is recorded as completed merely by this BRD.

### 1 Document control

| Control item | Value |
| --- | --- |
| Document purpose | Define reviewed business scope, requested target capabilities, proposed requirements/data model and explicit validation/owner decisions. |
| Audience | Business sponsor, HR, Payroll, Finance, application owner, senior developer and QA. |
| Version and review date | 8.2; 8 October 2026. Adds payroll locking, approved future-period adjustments, salary hold criteria, bank files and all 18 ESS tabs with sensitive-change approval. |
| Review authority | Business sponsor and module owners to be nominated; final approval pending. |
| Reference role covered | Administrator role only; no other role session was verified. |
| Review method | Read-only navigation and screen observation recorded in the existing review register. No employee data changed and no business transaction completed. |
| Evidence conventions | Observed screen: visible control/text inspected. Menu only: label observed, internals unverified. Proposed: target behaviour requested or inferred for owner review; not source behaviour. |
| Requirement conventions | FR identifiers identify functional requirements; BR identifiers identify business rules; CL identifiers identify coverage entries; DQ identifiers identify data checks; OQ identifiers identify unresolved questions. |
| Document hierarchy | 14 mandatory sections retained. Appendix A Coverage Log; B proposed schema; C RBAC; D zero tolerance gates; E final handover review and build decisions. Appendix F selected target business decisions and dependency dispositions. Appendix G scale architecture and capacity verification. |
| Approval status | Ready for target design and implementation under delegated business decisions in Appendix F. External inputs, detailed technical design, source parity, actual testing and production sign-offs remain separate. Ten-million-user capacity is a requested design target; it is not verified until Appendix G tests pass. |


Controlling target baseline: Appendix F selects business policies under the user’s instruction to complete decisions. It controls target scope/defaults/access when earlier discovery text describes them as pending. Unverified source observations remain unverified. Configurable defaults are initial values, not hard-coded limits. Appendix H controls the payroll and ESS additions and its own-record privacy exception; Appendix G continues to control scale targets.

Version 8.2 adds processed-payroll locking, later-period timesheet adjustments, controlled salary holds, bank-format files and 18 Employee Self Service tabs. Appendix H is the controlling target specification for these additions. It permits narrowly scoped employee access to own ESS private records and prohibits direct employee mutation of protected master fields.

### 2 Executive summary

The application supports employee administration and related workforce activities, including organisation records, hiring, attendance, leave, payroll, performance review, timesheets, training and separation. Its business purpose is to give authorised users a consistent employee record and controlled ways to review workforce information, requests and outputs. Intended users include HR, employees, managers, Payroll, Finance and authorised reviewers; only the Administrator interface was covered by the recorded walkthrough. General expense approval is included as a requested target extension, with employee submission, manager review, finance review and payment tracking subject to business approval.

### 3 Business objectives

| Objective | Business outcome and confirmation measure |
| --- | --- |
| Consistent employee information | Employee identity and organisation classifications remain consistent across lists and outputs for the same employee and effective date; owner-approved examples reconcile. |
| Controlled decisions | Requests are reviewed by the authorised business owner and retain decision reasons; role-specific acceptance tests demonstrate the approved access matrix. |
| Reliable workforce review | Attendance, leave and salary-related views support period-based review; totals reconcile to the same eligible records and filters. |
| Traceable employee lifecycle | Joining, transfers, reviews and separation retain the business history necessary for later review; owner-approved historical cases remain retrievable. |
| Expense accountability | Claimants can follow a claim from submission to decision and payment; approved amounts reconcile to confirmed payment and outstanding amounts without duplicated entitlement. |
| Complete documented coverage | Every navigation item in the recorded visible inventory has a Coverage Log entry and one allowed coverage status; incomplete walkthrough areas remain explicit. |


### 4 Scope

#### 4.1 Review boundaries

Reviewed evidence consists of the following 17 screen/area records and the visible navigation inventory. Review was limited to Administrator access. Lists and controls were observed without save, amendment, approval, upload, deletion, message sending, attendance processing, payroll processing, settlement or payment execution. Empty lists establish only that no records were displayed with the reviewed filters.

| Ref | Area | Observed scope and limitation |
| --- | --- | --- |
| E01 | Login and Home | Login identifier and password entry, Forgot Password, Administrator role session, last login, Employee Self Service and My Account links. Home shows Pending Approvals, My Submitted Request, Alerts and Recruitment Alerts. |
| E02 | Master and Org Set Up | Organisation and employee administration menu inventory. Employee list supports company/status/search/date filters, pagination, status views and multiple exports. |
| E03 | Employee Master | Grid columns include Name, Ecode, Work Location, Department, Designation, DOJ, DOC, Emp_Type and PT_location. Full employee entry fields were not verified. |
| E04 | Shift Master | Shift name, in/out time, break out/in time, buffer, shift hours, 24 Hrs Cycle, active and employee count columns. |
| E05 | Attendance Policy | Grace periods, LC/EG interval, leave and paid-day deductions, half weekly-off, absent, half-day, present, overtime and effective-from fields. |
| E06 | Leave Policy Config | Company, leave type and effective-from filters; policy mapping to grade and location; unmapped policies indicated in pink; mapped-policy export. |
| E07 | Attendance Control | Organisation, working organisation, employee, Ecode, department, location, status, shift, date, minute comparison and entity filters; policy and amendment-log controls. |
| E08 | Employee Salary Master | Company, status, CTC category, employee search, month/date filters; salary/annual export; grid has annual CTC, monthly gross, grade, effective date and estimated in-hand. |
| E09 | Payroll Controller | Financial year, Apr to Mar month selection, company, department, grade, working-for and location filters. Processing stages were not executed. |
| E10 | Talent Acquisition | List search, New and copy-existing controls. Opening New returned an internal system error; creation form and validation were not verified. |
| E11 | Appraisal Config | Section visibility, grade competency mapping, rating visibility, one/two approval levels, cycle month, KRA upload mode and formula/manual rating explanatory text. |
| E12 | Resource Allocation | List has New, Bulk Upload, search, Export and Export XLSX. Allocation entry and approval behaviour were not verified. |
| E13 | Training Plan | Search/date filters, export and Cancelled/Past/Current/Future views. No training records displayed in the inspected view. |
| E14 | Full and Final | Company, disbursement-month and employee search filters, uploaded-list search, bulk upload, settlement views, PDF/Excel send controls and ZIP export. No transaction executed. |
| E15 | Process Master | New and selection controls; inspected list displayed no records. |
| E16 | User Rights | Company, search-on and text filters, paging; search dimensions include role, employee, user type, active and Ecode. Permission editing was not opened. |
| E17 | Reports and other menus | Report and upload inventory listed in Appendix A. Detailed output formats and scheduling were not tested. |


#### 4.2 Included target scope and exclusions

| Scope item | Disposition |
| --- | --- |
| Observed navigation and screen capabilities | Included for requirement discovery and business validation. Appendix A states the evidence depth; menu coverage is not feature execution. |
| Role-based visibility | Included as proposed business design. Administrator observation is available; employee, manager, finance, payroll and auditor sessions were not reviewed. |
| Expense approval | Included as a requested extension. No dedicated general expense approval source screen was verified; existing reimbursement-related menu labels are recorded separately. |
| Source data and database validation | Business entities, field meanings and expected relationships are documented. Direct source data-model inspection and record reconciliation were not performed. |
| Unreachable area | Talent Acquisition New entry returned an application error; its form, mandatory markers and validation remain unconfirmed. |
| Excluded activities | Changing the reference application; live payroll/payment decisions; importing real records; sending messages; reproducing vendor code or branding. |
| Optional areas requiring scope decision | Asset issue/return, native mobile application, expense advances, corporate cards, travel booking, automated receipt extraction and mileage calculation. |
| Unobserved navigation surfaces | Additional help, profile tabs, accordions, quick actions, links or restricted menus not captured in the recorded evidence require a further read-only walkthrough; no exhaustive live-navigation claim is made. |


#### 4.3 Additional requested scope dated 6 October 2026

The user requests five new target capabilities: flexible employee confirmation periods, birthday/work anniversary and request notifications, attendance fetched from biometric APIs with configurable fields, retained employee history including annual increment percentages, and employee increment cycles. These capabilities are included as requested scope. Source implementation was not inspected for these additions; defaults, formulas beyond those explicitly proposed here, recipients, channels, timing, approval authority and provider configuration require the decisions listed in OQ21 to OQ25 and HD11 to HD15. No real event or biometric service was invoked.

#### 4.4 Requested scale dated 8 October 2026

The new system must be designed for 10,000,000 concurrent active users across the approved company partitions. Appendix G and NFR-S01–S12 govern sizing, performance, isolation and release proof. This is a new requirement and supersedes earlier small-test assumptions; it does not change the recorded source-navigation coverage or business confidentiality rules.

#### 4.5 Payroll and Employee Self Service additions

Requested target scope includes all 18 ESS tabs in H3 and payroll controls in H2. These are requested target features, not newly verified source screens. Source Coverage Log entries remain unchanged. Payroll integrations, statutory output templates and policy activation require the evidence in F4/H8.

### 5 Stakeholders and user roles

Developer detail: Appendix C defines proposed RBAC actions, row scopes, field controls and separation of duties. Source role enforcement remains unverified.

| Stakeholder | Business accountability |
| --- | --- |
| Business sponsor | Approve delivery scope and business priorities. |
| HR owner | Approve employee fields, status meanings, leave, appraisal, training and separation rules. |
| Payroll owner | Approve salary, paid-day, deduction, tax and settlement examples. |
| Finance owner | Approve expense policy, currency/accounting, payout duties and reconciliation. |
| Application and data owner | Provide read-only screen and anonymised record-definition evidence. |
| Senior developer | Map approved business requirements to design and validate record integrity without guessing hidden rules. |
| QA and delivery owner | Maintain requirement-to-test evidence and enforce approved acceptance gates. |


The following matrix is a proposed target design for owner confirmation. It states permitted business responsibilities and explicit exclusions. No effective source assignment is inferred from the role name. Roles can be combined only where the approved business restrictions still hold. “Own” means the person’s own employee records, “Team” means approved reporting scope, “Assigned” means a specific reviewed transaction, and “Organisation” means the approved company/location/department scope.

| Role | Can see and do | Restricted areas |
| --- | --- | --- |
| System Administrator | Organisation: approved user/role administration and configuration. All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. | No automatic salary, bank, medical, business approval or payment rights; no self-grant approval. Confidential fields require a separately approved field grant within this assignment’s employee scope; no organisation-wide manager bypass. |
| HR Administrator | Organisation: employee records, documents, organisation data, manager assignments and HR review. All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. | No payroll release or expense financial decision unless separately granted; no changes to paid claim facts. Confidential fields require a separately approved field grant within this assignment’s employee scope; no organisation-wide manager bypass. |
| Employee | Own operational profile, attendance/leave balances and request states, goals/tasks, timesheets, training and expense operational lines. Own issued payslips, Form 16 and approved ESS private records are available under the H1 OWN exception; other employees’ confidential information remains denied. | No another employee’s data, approval, role changes or payment action. Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Reporting Manager | Team summaries and Assigned leave, timesheet, appraisal and expense decisions. All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. | No salary/bank access without an eligible scoped field grant; no own-request approval; manager status does not imply finance authority. Confidential fields require a separately approved field grant within this assignment’s employee scope; no organisation-wide manager bypass. |
| Payroll Operator | Organisation: approved salary inputs, calculation review and permitted payroll outputs. All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. Sensitive-dependent duties execute only in the independently approved eligible Admin context with DB109 narrow allowlist, never this ordinary role context. See DF02/07. | No approval/release of own prepared results or independent expense entitlement decision. Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Payroll Approver | Organisation and Assigned: review, approve and authorised payroll lock/release. All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. Sensitive-dependent duties execute only in the independently approved eligible Admin context with DB109 narrow allowlist, never this ordinary role context. See DF02/07. | No own prepared result approval or unrestricted input changes after approval. Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Finance Reviewer | Organisation: permitted payroll, reimbursement, liability and expense reconciliation outputs. All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. Sensitive-dependent duties execute only in the independently approved eligible Admin context with DB109 narrow allowlist, never this ordinary role context. See DF02/07. | Read-only unless another explicit role/action is granted; no implied expense/payment approval. Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Expense Finance Approver | Assigned/Organisation: receipts, policy exceptions, final claim amounts and reasoned returns/rejections. All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. Sensitive-dependent duties execute only in the independently approved eligible Admin context with DB109 narrow allowlist, never this ordinary role context. See DF02/07. | No own claim approval, changing submitted claimant facts or payment release for a claim finally approved by the same person. Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Treasury Operator | Organisation: prepare approved expense payouts and review payment outcomes. All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. Sensitive-dependent duties execute only in the independently approved eligible Admin context with DB109 narrow allowlist, never this ordinary role context. See DF02/07. | No entitlement approval or release of own prepared payment; bank details limited to payment duties. Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Treasury Approver | Assigned/Organisation: independent payment release and approved reversals. All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. Sensitive-dependent duties execute only in the independently approved eligible Admin context with DB109 narrow allowlist, never this ordinary role context. See DF02/07. | No own claim payment or own prepared batch release; no entitlement rewrite. Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Recruiter | Organisation: candidates, requisitions and recruitment tracker. All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. | No employee bank/salary or general expense access. Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Appraisal Reviewer | Assigned: permitted goals, ratings and review decisions. All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. | No general employee financial information or expense authority. Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Training Coordinator | Organisation: plans, participants and feedback. All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. | No salary/bank, unrelated appraisal or expense information. Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Auditor | Approved read-only reports and decision history. All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. | No create, edit, approval, processing or payment actions; protected values remain restricted. Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |


#### 5.1 Business permission and data relations

| Relation | Business access meaning | Validation status |
| --- | --- | --- |
| User to role assignment to permission | A user acts only through an active assignment and an allowed action in the same approved organisation scope. | Target design; source assignment not inspected. |
| Role assignment to organisation scope | Company, location and department restrictions apply together; access from one role is not widened by an unrelated role. | Target design; role walkthrough needed. |
| User to employee | Own-record access resolves to one employee identity per relevant organisation; shared person identity does not expose other employments. | Target design; source linkage not inspected. |
| Employee to manager or reviewer | Reporting scope and assigned approval tasks determine review visibility; sensitive financial fields remain separate. | Manager maintenance visible by name; scope semantics unverified. |
| Approval to transaction and decision actor | An approval belongs to the reviewed transaction and authorised reviewer; self-interest and prohibited combined duties remain blocked. | Proposed target requirement; real approvals not executed. |
| Role to output and attachment | List, download, export, dashboard and receipt views obey the same approved record scope plus field-specific access. | Output controls observed; enforcement unverified. |


#### 5.2 My Team, role dashboards and confidentiality — requested target

Latest requested confidentiality rule (version 7.1): confidential information may be disclosed only through an active, owner-approved Admin or Manager role assignment with the necessary field permission and employee scope. Admin eligibility is limited to System Administrator and HR Administrator; Manager eligibility is limited to Reporting Manager. Other role titles are not eligible merely because they include approval or review duties. Eligibility alone grants no field access. The same assignment must provide eligible role, field grant and row scope; combining an eligible role in one scope with another role in a different scope cannot expand confidential access. This rule supersedes earlier proposed self-service, payroll, finance, treasury, recruiter, reviewer and auditor visibility wherever it would disclose confidential information. Until field classification is approved, salary, CTC, increment amounts/percentages, bank/payment/tax details, identity documents, medical details, private contact/address, sensitive leave reasons, appraisal narratives and confidential attachments are restricted. Credentials and integration secrets are never displayed as employee information. The explicit Employee OWN ESS exception in H1 permits only the listed own-record fields and issued outputs; no other implicit exception exists. For own ESS data only, apply the explicit Employee OWN exception in H1; this does not grant other-person or operational-role confidential access.

My Team displays current reporting members and their permitted identity, employment, reporting, attendance, leave, skills, training and history information. Confidential tabs/fields require the eligible assignment and scope above. Direct reports are the proposed default; recursive reporting and historical team access remain owner decisions. All added navigation and dashboard entries below are proposed, not evidence of another live walkthrough.

### 6 Navigation map

The navigation hierarchy is Module → Page → Section → Tab. Appendix A supplies the complete recorded leaf inventory, controls and status views. “Not exposed in reviewed evidence” identifies an unknown lower level; it is not a fabricated tab. Recorded navigation branches are part of the module path; they are not presented as verified page sections. Page controls are recorded as leaf entries without inventing separate tabs. Documented means the visible item is recorded with its known purpose and limitation; it does not mean the destination or changing action was exercised. Only Documented, Restricted and Not reachable are used as Coverage Log statuses.

| Module | Pages or areas recorded | Section and tab evidence |
| --- | --- | --- |
| Master and organisation setup | Company, Department, Designation, Entity Master, Qualification Master, State Master, City Master, Shift Master, Holiday Master, Bank Master, My Account, Employee Master, Emp Master Upload, Upload Employee Update, Emp Master Changes, User Master, User Rights, Attach new menu item, Reporting Manager, Upload Reporting Managers, Event Planner, Ticker Message, Org Structure, Alerts config, Policy Upload, Bulk Emp Docs upload, Export Docs, Upload Other Activities | See Appendix A leaf entries; unknown levels explicitly marked. |
| Hiring | Vendor, Manpower Budget, Talent Register, Search CV, TR Tracker, Talent Acquisition, Talent Acquisition Approval, HR View Talent Acquisitions | See Appendix A leaf entries; unknown levels explicitly marked. |
| ELC and Letters | Letter Printing, Process Master, Employee Process Master, Exit Notes/Remarks/Warnings, Send Mail, Letter Designer | See Appendix A leaf entries; unknown levels explicitly marked. |
| Attendance and leave | Attendance Control, Biometric Upload, Import Attendance, Import In Out Time, Shift Punch Register, Attendance Register, Shift Plan Register, Shift Deviation Register, Absconding Report, Absconding Audit Report, Attendance Dashboard, Wage Register, Attendance Policy, Leave Policy Config, Employee Leave Master, Upload Opening Leave Balance, Mobile App Linking, Shift Planning Upload, HR View Leaves &amp; Outdoor, HR View Work On Holiday, EOD Utility, Run Eod | See Appendix A leaf entries; unknown levels explicitly marked. |
| Payroll configuration | Paid Days Setting, Working days settings, Grade Master, Earning Head Master, Deduction Head Master, Grade Mapping, Grade Salary Structure, External Deduction Mapping, PT Master, Challan Master | See Appendix A leaf entries; unknown levels explicitly marked. |
| Payroll inputs | Salary Master Upload, TDS Projection, Upload Variable Payments, Compute Paid Days, Loan/Advance Entry, Upload Loan/Advance, Monthly TDS Challan Entry, Upload Investment, Upload Claims - Reimbursement/L.T.A, Past Salary TDS, Upload Perquisites, Set Salary Stop, Upload Stop Salary | See Appendix A leaf entries; unknown levels explicitly marked. |
| Payroll reports | Pay Register, Arrear Register, TDS Register, Salary Disbursement, Reimbursement Register, TDS Form27, Salary Progression Chart, TDS Form-24Q / Form 138, Salary Comparison Report, Salary JV, Liability Provisions, NPS Report, Export for EDOC | See Appendix A leaf entries; unknown levels explicitly marked. |
| Payroll compliance | PF Register, ESIC Register, PT Register, LWF Register, PF Form9, e PF Challan, ESIC Six Monthly Report, ESIC Monthly Contribution | See Appendix A leaf entries; unknown levels explicitly marked. |
| Payroll processing | Payroll Controller, Emp Salary Master, Salary Generation, TDS Calculation, Check Medical Claims, Arrear-Increment, Prepare Form 16 / Form 130 (Salary certificate), Lock Salary, Check Inv Declaration, TDS Full And Final, Upload Past Salary | See Appendix A leaf entries; unknown levels explicitly marked. |
| Performance management | Appraisal Config, PMS Schedule, Upload KRA/Goals, Competency Config, KRA Setting, KRA Setting Review, View KRASetting, Appraisal Entry, Appraisal Review, Appraisal Reviewer Review, HR View Appraisals, Appraisal Report, Bell Curve | See Appendix A leaf entries; unknown levels explicitly marked. |
| Timesheet | Project Master, Job Master, Activity Master, Resource Allocation, Time Sheet Approval, HR View Time Sheet, TMS Reports | See Appendix A leaf entries; unknown levels explicitly marked. |
| Training and Asset | Training Plan, Training Participants Entry | See Appendix A leaf entries; unknown levels explicitly marked. |
| Separation | Relieving Letter, Experience Letter, Full and Final, Upload Full And Final | See Appendix A leaf entries; unknown levels explicitly marked. |
| Analytics | Training with feedback Register, Attrition Register, Attrition Summary, Employee History, Employee Document Compliance, Emp Master Audit Trail, Download Audit Trails, Transaction Audit trail, Emp Master Field Level Audit Trail | See Appendix A leaf entries; unknown levels explicitly marked. |
| Application access | Login, Forgot Password, Home, Employee Self Service, My Account, Last login display, External footer link | See Appendix A leaf entries; unknown levels explicitly marked. |


A fresh exhaustive walkthrough is needed to identify any additional visible items omitted by the earlier evidence register. The recorded inventory has no confirmed role-restricted destination; absence of Restricted entries does not establish unrestricted access. An unavailable non-Administrator walkthrough is tracked as an access-evidence gap in Section 14 rather than an invented navigation item.

#### 6.1 Proposed target navigation for requested additions

This target navigation is a design proposal, not additional observed navigation. It is therefore not added to Appendix A or given a source coverage status.

| Module | Page | Section and tab proposal |
| --- | --- | --- |
| Employee lifecycle | Confirmation Policies; Employee Confirmation Review | Duration and applicability; due list; extension/confirmation decisions; decision history. |
| Notifications | Notification Rules; Employee Events; Notification Delivery Log | Birthday/work anniversary; request events; recipient/channel rules; preferences; delivery attempts. |
| Attendance integration | Biometric API Profiles; Field Mapping; Employee Mapping; Sync Monitor | Provider configuration; source-to-target mapping versions; safe test preview; fetch runs; quarantined events. |
| Employee history | Employee History; Increment History | Employment timeline; salary change events; yearly opening/closing basis; per-increment percentage. |
| Compensation | Increment Cycles; Employee Cycle Assignment; Increment Review | Cycle schedule and eligibility; due roster; proposals; approvals; effective application; payroll linkage. |


#### Proposed navigation additions

Role Home → role dashboard → authorised widgets → scoped business page; My Team → member list → employee detail → permitted employment / attendance / leave / skills and training / history / confidential sections. Confidential sections are absent when permission is denied. Search, filters, pagination and quick actions use the same authorization as detail requests. Existing Appendix A coverage statuses remain unchanged.

#### 6.1 Target Employee Self Service navigation

Module Employee Self Service → Page My ESS → Section Personal, Financial, Time and Requests, Development → Tabs H3 TN01–TN18. Global entry points are role dashboard, My Profile and own task links. Own request tabs contain list, detail, draft, submit, withdraw, revision and status/history sections as applicable. Own output tabs contain period filter, issued list, preview and authorized download. These target entries do not alter observed source coverage.

### 7 Functional requirements

Every requirement below has an FR identifier, priority, source area, evidence classification and objectively testable acceptance conditions. Must means required for the stated target scope; Should means a proposed capability requiring prioritisation. Proposed items are not confirmed reference functionality. Acceptance is against an owner-approved configuration and fixed sample data; an unresolved rule must be closed before its dependent requirement is tested or released.

#### FR-001 Authentication and session control

Priority: Must &#124; Source: Login and User Rights &#124; Evidence: E01/E16

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-005 to BR-007; OQ-02/14

The system shall allow users to sign in, sign out when the action is available, and initiate the visible password-recovery journey. Additional authentication and session policies require owner confirmation; no unobserved controls are prescribed here.

Acceptance: A disabled user cannot sign in; expired sessions cannot call protected operations; recovery cannot reveal whether an unrelated employee account exists.

#### FR-002 Granular authorisation

Priority: Must &#124; Source: Login and User Rights &#124; Evidence: E01/E16

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-005 to BR-007; OQ-02/14

The system shall configure view, create, amend, submit, approve, export, upload, process, lock and reopen rights separately for each module and company scope. Keep employee and approver permissions independent.

Acceptance: An employee cannot view another employee payslip by altering an identifier; a payroll operator without approval rights cannot approve their batch through a protected business action.

#### FR-003 Hierarchy and delegation

Priority: Must &#124; Source: Login and User Rights &#124; Evidence: E01/E16

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-005 to BR-007; OQ-02/14

The system shall maintain manager and reviewer assignments with start/end dates. Proposed delegation must be time-limited, auditable and limited to assigned request types; prevent self-approval and hierarchy cycles.

Acceptance: Requests resolve to the valid manager for the configured routing date; an expired delegate cannot act.

#### FR-004 Organisation masters

Priority: Must &#124; Source: Organisation masters and Shift Master &#124; Evidence: E02/E04

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-001/004/008; OQ-03/05

The system shall maintain codes, names, relationships, active status and effective dates for companies, departments, designations, locations and configurable entities. Proposed additions include cost centres and organisational levels where business owners require them. Block deletion of referenced masters; allow controlled deactivation.

Acceptance: A referenced department remains available in historical reports after deactivation but cannot be assigned to a new joiner outside its valid period.

#### FR-005 Shifts holidays and calendars

Priority: Must &#124; Source: Organisation masters and Shift Master &#124; Evidence: E02/E04

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-001/004/008; OQ-03/05

The system shall maintain shift in/out and break times, buffer, calculated hours, 24-hour-cycle indicator and active state. Maintain location-specific holidays and weekly-off patterns. The overnight interpretation and treatment of breaks must be approved.

Acceptance: A test overnight shift crossing midnight produces the owner-approved duration and attendance date; a location holiday applies only to employees assigned to that calendar.

#### FR-006 Employee record and status

Priority: Must &#124; Source: Employee Master and employee administration menus &#124; Evidence: E02/E03/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-001 to BR-004; OQ-03/18

The system shall create a unique employee record linked to company, department, designation, work location and employee type. Maintain joining/confirmation/leaving dates and status history. Reference status views are Current, Offered[Rej], Offered, On Probation, On Notice and Left. Define allowed transitions during design.

Acceptance: A duplicate employee code is rejected in its approved uniqueness scope; joining and status changes retain effective-dated history.

#### FR-007 Search and exports

Priority: Must &#124; Source: Employee Master and employee administration menus &#124; Evidence: E02/E03/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-001 to BR-004; OQ-03/18

The system shall reproduce company/status/search/date filtering, sortable list columns, paging and counts. Provide authorised exports for employee, family, qualification, past employer, branch and grade details, matching observed export purposes.

Acceptance: List and export use identical filters and authorised scope; date ranges are validated; export column definitions are approved before release.

#### FR-008 Employee profile detail

Priority: Must &#124; Source: Employee Master and employee administration menus &#124; Evidence: E02/E03/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-001 to BR-004; OQ-03/18

The system shall support employee profile detail. Target sections include personal/contact data, employment, family/dependants, qualifications, prior employment, bank/payment data, applicable payroll identifiers and supporting documents. These detailed entry fields are proposed because the full reference form was not inspected. Use field-level permissions and masked display for sensitive identifiers.

Acceptance: Only authorised users can reveal protected identity or bank fields; invalid dates and unknown master references fail validation before save.

#### FR-009 Bulk onboarding and update

Priority: Must &#124; Source: Employee Master and employee administration menus &#124; Evidence: E02/E03/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-001 to BR-004; OQ-03/18

The system shall provide separate employee creation and employee update imports. Stage the file, validate each row, show proposed changes and commit only after authorised confirmation. Preserve a batch ID, source, validation report and outcome.

Acceptance: A file with repeated employee codes or an unknown department is rejected or partially processed only under the approved atomicity policy; reuploading the same batch does not create duplicates.

#### FR-010 Documents policies and communication

Priority: Must &#124; Source: Employee Master and employee administration menus &#124; Evidence: E02/E03/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-001 to BR-004; OQ-03/18

The system shall maintain employee documents and policies with version, classification, employee/company scope, expiry and access controls. Support bulk document mapping, authorised document export, event planner, ticker and alert configuration. Proposed notifications must track delivery without disclosing protected data to unrelated recipients.

Acceptance: A policy visible to one company cannot be downloaded by another company user; unrecognised employee codes in a bulk document file are reported and not silently assigned.

#### FR-011 Manpower budget and requisition

Priority: Must &#124; Source: Talent Acquisition and hiring menus &#124; Evidence: E10/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: OQ-04; detailed hiring rules pending

The system shall maintain approved staffing budgets by company, department, location, designation and period. A requisition records position, number of vacancies, new/replacement reason, skills, employment type, target date, hiring manager and budget reference. Copying a requisition must assign a new reference and reset its approval history.

Acceptance: Copy retains permitted job details but does not inherit approval or candidate decisions; a requisition exceeding budget requires the owner-approved exception route.

#### FR-012 Requisition approval

Priority: Must &#124; Source: Talent Acquisition and hiring menus &#124; Evidence: E10/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: OQ-04; detailed hiring rules pending

The system shall support requisition approval. Proposed states are Draft, Submitted, Pending Approval, Approved, Rejected, On Hold, Closed and Cancelled. Route by company and budget criteria. HR View supports cross-team oversight within scope.

Acceptance: Only an approved requisition accepts final placement; a rejection records approver, timestamp and reason; return-for-edit behaviour is explicit.

#### FR-013 Candidate and CV register

Priority: Must &#124; Source: Talent Acquisition and hiring menus &#124; Evidence: E10/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: OQ-04; detailed hiring rules pending

The system shall maintain candidates, CV attachments, skills, source/vendor, consent/retention status and linked applications. Search CV metadata and approved searchable content. Proposed recruitment stages include screening, interview, offer and hired/rejected. Avoid duplicate identity records while permitting applications to multiple requisitions.

Acceptance: Duplicate detection flags a likely match for review; a rejected application does not automatically reject the candidate from unrelated requisitions.

#### FR-014 Tracker and employee handover

Priority: Must &#124; Source: Talent Acquisition and hiring menus &#124; Evidence: E10/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: OQ-04; detailed hiring rules pending

The system shall show vacancies, candidates, stage, owner, pending action and ageing in the tracker. On hiring, transfer only validated employee fields and approved documents to onboarding; keep recruitment history linked.

Acceptance: The same accepted offer cannot create two employees; the onboarding record is traceable to its requisition and application.

#### FR-015 Lifecycle process definition

Priority: Must &#124; Source: Process Master and letter menus &#124; Evidence: E15/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-027; OQ-12/13

The system shall configure target processes such as onboarding, probation confirmation, transfer, promotion and exit, with ordered tasks, owners, due dates and required evidence. Actual reference process types were not visible in the empty list.

Acceptance: A process cannot close while a mandatory task remains incomplete; changes to a process template do not silently rewrite a completed instance.

#### FR-016 Employee process tracking

Priority: Must &#124; Source: Process Master and letter menus &#124; Evidence: E15/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-027; OQ-12/13

The system shall support employee process tracking. Assign a process to an employee; track task completion, documents, remarks, overdue tasks and manager/HR review. Proposed reopen actions require reason and permission.

Acceptance: Each task completion identifies actor and date; reassignment retains prior owner and action history.

#### FR-017 Letter templates and printing

Priority: Must &#124; Source: Process Master and letter menus &#124; Evidence: E15/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-027; OQ-12/13

The system shall create versioned letter templates with permitted employee/company placeholders and preview. Target examples include offer, appointment, confirmation, transfer, warning, relieving and experience letters; the full reference template catalogue is unverified.

Acceptance: Generation substitutes correct employee data; missing mandatory placeholders block final output; the rendered letter stores template version and generator identity.

#### FR-018 Controlled correspondence

Priority: Must &#124; Source: Process Master and letter menus &#124; Evidence: E15/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-027; OQ-12/13

The system shall separate preview/download from sending mail. Require recipient review and delivery status for application-generated letters. Restrict notes and warnings to authorised HR roles.

Acceptance: Previewing a letter never sends an email; sending records recipients, template version and outcome; unauthorised users cannot view restricted remarks.

#### FR-019 Attendance ingestion

Priority: Must &#124; Source: Attendance Control and Attendance Policy &#124; Evidence: E05/E07

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-008/009; OQ-05

The system shall support biometric upload, attendance import and in/out-time import, reflecting observed capture menus. Map confirmed device records to the correct employee, event time and source submission; retain original evidence and identify invalid or repeated punches.

Acceptance: Reimporting an identical punch file does not double count time; an unknown employee or invalid timestamp appears in the error report.

#### FR-020 Daily policy evaluation

Priority: Must &#124; Source: Attendance Control and Attendance Policy &#124; Evidence: E05/E07

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-008/009; OQ-05

The system shall apply scheduled shift, breaks, holiday/weekly-off calendar and the assigned policy to derive worked minutes, lateness, early departure, absence, half day and overtime candidates. The policy screen exposes thresholds; the exact rounding, punch pairing and precedence rules require approval.

Acceptance: Approved test vectors at one minute below, equal to and above each threshold produce the owner-approved result, including midnight crossings and missing punches.

#### FR-021 Attendance controller

Priority: Must &#124; Source: Attendance Control and Attendance Policy &#124; Evidence: E05/E07

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-008/009; OQ-05

The system shall provide the observed organisational, employee, department, location, status, shift, date, minute and entity filters. Show raw/derived results, policy version and authorised amendment history. Proposed amendments require reason and preserve original data.

Acceptance: A correction does not erase the source punch; policy and amendment-log views identify why the daily status changed.

#### FR-022 EOD and processing control

Priority: Must &#124; Source: Attendance Control and Attendance Policy &#124; Evidence: E05/E07

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-008/009; OQ-05

The system shall provide EOD Utility and Run Eod capabilities behind explicit processing permissions. The target design must define selection scope, execution mode, retry, concurrency and payroll-lock dependencies; scheduling behaviour is unverified.

Acceptance: A rerun with unchanged inputs produces the same daily result; processing failures list affected employees and cannot silently mark the batch complete.

#### FR-023 Shift planning and mobile linking

Priority: Must &#124; Source: Attendance Control and Attendance Policy &#124; Evidence: E05/E07

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-008/009; OQ-05

The system shall import employee shift plans and maintain employee-to-mobile-app links. Geolocation, device binding, offline attendance and native mobile app support are decisions, not verified behaviours.

Acceptance: An assignment outside employee employment dates is rejected; the link operation cannot associate one employee with another account without authorised review.

#### FR-024 Leave policy and mapping

Priority: Must &#124; Source: Leave Policy Config and leave menus &#124; Evidence: E06/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-010; OQ-06

The system shall maintain company, leave type, policy and effective period, mapped to grade and location. Expose unmapped-policy warnings with text as well as colour. Target rules include accrual, eligibility, carry-forward, expiry, encashment, negative balance and holiday/weekly-off treatment; values need approval.

Acceptance: An employee has a deterministic policy selection; overlapping mappings are rejected or resolved by a documented priority; unmapped employees are listed before accrual.

#### FR-025 Opening balances and ledger

Priority: Must &#124; Source: Leave Policy Config and leave menus &#124; Evidence: E06/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-010; OQ-06

The system shall maintain Employee Leave Master and opening leave-balance upload. Proposed leave ledger records opening, accrual, approved usage, reversals, expiry, adjustments and closing balance rather than an untraceable editable total.

Acceptance: Opening plus credits minus debits equals closing balance; duplicate opening-balance batches are blocked; an adjustment preserves actor and reason.

#### FR-026 Leave request and approval

Priority: Must &#124; Source: Leave Policy Config and leave menus &#124; Evidence: E06/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-010; OQ-06

The system shall support leave request and approval. Proposed employee service allows leave type, dates, day fraction, reason and attachment, with manager review. Validate overlap, employment dates, available balance and policy constraints. Define reservation and deduction timing explicitly.

Acceptance: Concurrent requests cannot spend the same balance twice; rejection releases any reserved balance; cancellation after approval uses the owner-approved reversal route.

#### FR-027 Outdoor and work on holiday

Priority: Must &#124; Source: Leave Policy Config and leave menus &#124; Evidence: E06/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-010; OQ-06

The system shall provide HR views for leave/outdoor and work-on-holiday, as observed in menus. Proposed requests include duty dates, times, purpose and supporting evidence; approval determines attendance or compensatory treatment under configured rules.

Acceptance: An approved outdoor request changes the permitted daily outcome once; approved holiday work does not automatically create leave unless the policy specifies it.

#### FR-028 Payroll master configuration

Priority: Must &#124; Source: Employee Salary Master and Payroll Controller &#124; Evidence: E08/E09/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-011/012; OQ-07 to OQ-09

The system shall maintain paid-day and working-day settings, grades, earning/deduction heads, grade mapping, grade salary structures, external deduction mapping, PT Master and Challan Master. Target head definitions include type, calculation basis, rounding, tax treatment and effective dates.

Acceptance: An effective salary structure can be reproduced for a past month even after a new structure is introduced; missing or cyclic formulas block activation.

#### FR-029 Employee salary master

Priority: Must &#124; Source: Employee Salary Master and Payroll Controller &#124; Evidence: E08/E09/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-011/012; OQ-07 to OQ-09

The system shall maintain annual CTC, monthly gross, grade, effective date and permitted components. Provide observed salary-master upload, filters and salary/annual exports. Proposed salary history must retain increment and revision categories.

Acceptance: A revision takes effect in the approved period; CTC and monthly components reconcile according to approved structure rules; export reflects the selected effective month.

#### FR-030 Period controller

Priority: Must &#124; Source: Employee Salary Master and Payroll Controller &#124; Evidence: E08/E09/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-011/012; OQ-07 to OQ-09

The system shall provide financial year and month selection with company, department, grade, working organisation and location scope. Proposed statuses are Open, Inputs Validated, Calculated, Reviewed, Approved and Locked; reference processing states were not inspected.

Acceptance: Changing filters cannot cause an operation to include employees outside its confirmed scope; a period cannot be locked before required approvals and checks.

#### FR-031 Monthly inputs and salary stop

Priority: Must &#124; Source: Employee Salary Master and Payroll Controller &#124; Evidence: E08/E09/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-011/012; OQ-07 to OQ-09

The system shall capture variable payments, approved attendance/paid days, claims, investments, perquisites, past salary/TDS and salary stop instructions. Every input must carry period, employee, source and approval state. Proposed stop modes distinguish withholding disbursement from excluding calculation.

Acceptance: Only approved inputs feed the calculation; salary-stop interpretation is explicit in the result and disbursement report; repeated uploads do not duplicate a payment.

#### FR-032 Paid days and proration

Priority: Must &#124; Source: Employee Salary Master and Payroll Controller &#124; Evidence: E08/E09/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-011/012; OQ-07 to OQ-09

The system shall compute paid days from the configured calendar and approved attendance/leave outcomes, including joiners, leavers and loss of pay. The calendar denominator, rounding and paid weekly-off/holiday rules need payroll approval.

Acceptance: Worked examples for mid-month joining, leaving, unpaid leave and a leap-year month agree with approved expected totals; deductions are not applied twice.

#### FR-033 Payroll calculation and review

Priority: Must &#124; Source: Employee Salary Master and Payroll Controller &#124; Evidence: E08/E09/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-011/012; OQ-07 to OQ-09

The system shall calculate earnings, deductions, employer contributions, reimbursements, net pay and tax using versioned approved rules. Produce employee-level exceptions, component totals and comparison with the prior period.

Acceptance: A rerun on the same snapshot gives identical results; unconfigured heads and calculation failures block approval for affected scope; totals reconcile to registers and JV.

#### FR-034 Loans advances and recovery

Priority: Must &#124; Source: Employee Salary Master and Payroll Controller &#124; Evidence: E08/E09/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-011/012; OQ-07 to OQ-09

The system shall support loan/advance entry and upload with amount, approval, disbursement date, recovery schedule and balance. Define interest and early-settlement rules if required.

Acceptance: Recovery does not exceed outstanding balance; a rejected or reversed payroll run does not permanently advance recovery; settlement shows remaining balance.

#### FR-035 Arrears and increments

Priority: Must &#124; Source: Employee Salary Master and Payroll Controller &#124; Evidence: E08/E09/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-011/012; OQ-07 to OQ-09

The system shall maintain effective-dated revisions and calculate approved arrears for prior eligible periods, with component and month detail. Decide treatment of closed periods and tax differences.

Acceptance: The arrear register identifies source revision and period; rerunning the same revision does not pay the same arrears twice.

#### FR-036 Tax and declarations

Priority: Must &#124; Source: Employee Salary Master and Payroll Controller &#124; Evidence: E08/E09/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-011/012; OQ-07 to OQ-09

The system shall support TDS projection/calculation, investment declaration checking, medical claim review, monthly TDS challan entry and full-and-final tax. Policy and period-specific statutory calculation content requires approved reference data and payroll validation.

Acceptance: An unapproved declaration is excluded under the owner-approved rule; annual totals reconcile to monthly payroll and past salary; a tax adjustment has a reason and audit trail.

#### FR-037 Lock and controlled reopen

Priority: Must &#124; Source: Employee Salary Master and Payroll Controller &#124; Evidence: E08/E09/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-011/012; OQ-07 to OQ-09

The system shall provide Lock Salary with explicit scope and confirmation. Proposed reopen is a separately authorised action with reason, approval and revision identifier; preserve earlier approved output and regenerate affected reports.

Acceptance: Locked results cannot be amended through the UI or business action; an authorised reopen produces a new auditable revision rather than overwriting the approved snapshot.

#### FR-038 Reports disbursement and accounting

Priority: Must &#124; Source: Employee Salary Master and Payroll Controller &#124; Evidence: E08/E09/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-011/012; OQ-07 to OQ-09

The system shall provide observed payroll register, salary disbursement, arrears, tax, reimbursement, comparison, progression, JV, liability provisions, NPS and EDOC export functions. Bank files and accounting interfaces require separately approved formats; creating a file must not itself transfer funds.

Acceptance: The disbursement file sum matches approved payable totals after withholding rules; JV balances and reconciles to payroll; file generation records the approved run version.

#### FR-039 Compliance and salary certificates

Priority: Must &#124; Source: Employee Salary Master and Payroll Controller &#124; Evidence: E08/E09/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-011/012; OQ-07 to OQ-09

The system shall provide configurable PF, ESIC, PT and LWF registers and observed statutory/export forms. Preserve source labels including Form 16 / Form 130 and Form 24Q / Form 138 until the payroll owner confirms naming and applicability.

Acceptance: Approved sample files and certificates match owner-supplied period templates; applicable rates and formats are traceable to an approved configuration version.

#### FR-040 Cycle and schedule

Priority: Must &#124; Source: Appraisal Config and appraisal menus &#124; Evidence: E11/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-013/014; OQ-10

The system shall configure appraisal periods, opening/closing windows and schedule. The inspected cycle start month was 4, described as Apr to Mar; supported first-quarter-month values are explained as 1, 4, 7 and 10. Target date rules must align KRA and appraisal windows.

Acceptance: Entries outside an open window are prevented unless an authorised exception is recorded; cycle definitions cannot overlap ambiguously for the same employee.

#### FR-041 KRA and competencies

Priority: Must &#124; Source: Appraisal Config and appraisal menus &#124; Evidence: E11/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-013/014; OQ-10

The system shall maintain employee goals/KRAs, weights, targets and grade-mapped competencies. Provide KRA Setting, KRA Review, View KRASetting and upload. Target validations include valid period, required weights and approved total-weight rule.

Acceptance: A KRA upload in mode 0 awaits employee submission, mode 1 awaits manager review, and mode 2 is treated as reviewed, matching the displayed configuration explanation.

#### FR-042 Appraisal entry and scoring

Priority: Must &#124; Source: Appraisal Config and appraisal menus &#124; Evidence: E11/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-013/014; OQ-10

The system shall support self-appraisal against goals/competencies and configurable improvement, training, activity-performance and stretched-KPI sections. Manual or formula-based target rating is configured; formula text and weighting need confirmation from the actual appraisal screen.

Acceptance: When manual mode is enabled users enter permitted ratings; formula mode produces the approved test score; sections excluded by the approved configuration do not block submission.

#### FR-043 Manager and reviewer decision

Priority: Must &#124; Source: Appraisal Config and appraisal menus &#124; Evidence: E11/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-013/014; OQ-10

The system shall route appraisal to manager and optional second-level reviewer according to configuration. Preserve self, manager and reviewer ratings separately, with remarks and decision history. Proposed return-for-revision rules must be approved.

Acceptance: Level 1 completes at manager approval; level 2 remains pending until reviewer decision; an employee cannot replace a manager rating.

#### FR-044 Visibility and reports

Priority: Must &#124; Source: Appraisal Config and appraisal menus &#124; Evidence: E11/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-013/014; OQ-10

The system shall support visibility and reports. Respect configured employee visibility of ratings, HR oversight, appraisal report and bell curve. The page explains values 1 and 2 but displayed value 3 without explaining it; meaning of 3 must be confirmed. Proposed distribution charts must report selected population and period.

Acceptance: A rating hidden by policy is absent from employee business action responses and exports, not merely hidden in the screen; score counts reconcile to the selected population.

#### FR-045 Projects jobs and activities

Priority: Must &#124; Source: Resource Allocation and timesheet menus &#124; Evidence: E12/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: OQ-11; detailed time/capacity rules pending

The system shall maintain active projects, jobs and activities with code/name, owner, effective dates and hierarchy. Confirm whether a job belongs to exactly one project and whether activities can be shared.

Acceptance: An allocation or time entry cannot reference an inactive or out-of-period master; historical entries retain the original classification.

#### FR-046 Resource allocation

Priority: Must &#124; Source: Resource Allocation and timesheet menus &#124; Evidence: E12/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: OQ-11; detailed time/capacity rules pending

The system shall support resource allocation. Assign employees to projects/jobs for a date interval and permitted activities. Provide observed bulk upload, search, Export and Export XLSX. Proposed allocation percentage and planned hours require business agreement.

Acceptance: Overlapping allocations are flagged according to the approved capacity rule; imports report unknown employees and invalid project dates.

#### FR-047 Entry approval and locking

Priority: Must &#124; Source: Resource Allocation and timesheet menus &#124; Evidence: E12/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: OQ-11; detailed time/capacity rules pending

The system shall support entry approval and locking. Proposed employee entry records date, project, job, activity, hours and work note. Validate assignment, duplicate lines and total hours. Manager approval, rejection and HR view must maintain period and line-level history.

Acceptance: An approved entry cannot be changed without the owner-approved reopen route; rejected entries retain reason; daily total limits apply equally to manual and imported entries.

#### FR-048 Reporting and payroll linkage

Priority: Must &#124; Source: Resource Allocation and timesheet menus &#124; Evidence: E12/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: OQ-11; detailed time/capacity rules pending

The system shall provide TMS reports by employee, project, job, activity and period. Billing rates, utilisation formulas and payroll linkage are optional decisions and must not be assumed from the menu.

Acceptance: Hours reconcile from detailed lines to employee and project totals; payroll is unaffected unless an approved interface explicitly selects eligible hours.

#### FR-049 Training plan

Priority: Must &#124; Source: Training Plan and participant menus &#124; Evidence: E13/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-015; OQ-12

The system shall maintain proposed course title, dates, venue/mode, trainer, capacity, cost and owner. Provide observed search/date filters and past/current/future/cancelled views. Confirm whether current/past/future are derived from dates or maintained statuses.

Acceptance: A plan with end before start is rejected; filtering shows the owner-approved date classification; cancelling a plan records actor and reason.

#### FR-050 Participants and feedback

Priority: Must &#124; Source: Training Plan and participant menus &#124; Evidence: E13/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-015; OQ-12

The system shall record participant nomination, confirmation, attendance/completion and feedback linked to training and employee. Actual participant fields and feedback scales need owner confirmation.

Acceptance: The same employee cannot be duplicated in a training session; feedback reports reconcile to participants and show missing responses distinctly.

#### FR-051 Employee exit record

Priority: Must &#124; Source: Full and Final and separation menus &#124; Evidence: E14/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-016; OQ-12

The system shall support employee exit record. Target fields include reason, resignation/notice dates, proposed and approved last working date, manager, clearance tasks and status. Confirm the initiation path and whether resignation is employee-submitted or HR-entered.

Acceptance: Approved leaving dates flow consistently into attendance and payroll eligibility; a withdrawal preserves the prior request and decision trail.

#### FR-052 Settlement calculation

Priority: Must &#124; Source: Full and Final and separation menus &#124; Evidence: E14/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-016; OQ-12

The system shall calculate approved earnings due, arrears, leave encashment, loan/recovery, notice adjustment, deductions and tax from a versioned snapshot. Eligibility, gratuity/other benefits and notice calculations need explicit payroll policy.

Acceptance: Approved joiner/leaver examples reconcile to salary and leave records; no component already paid in monthly payroll is paid again in settlement.

#### FR-053 Settlement review and release

Priority: Must &#124; Source: Full and Final and separation menus &#124; Evidence: E14/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-016; OQ-12

The system shall support settlement review and release. Target workflow separates calculation, review, settlement approval and permission to disburse. Map the reference views to approved target statuses only after confirmation. Keep release and actual payment tracking separate.

Acceptance: Only a reviewed and approved settlement reaches release eligibility; merely viewing OK To Disburse never triggers a payment.

#### FR-054 Settlement upload and outputs

Priority: Must &#124; Source: Full and Final and separation menus &#124; Evidence: E14/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-016; OQ-12

The system shall provide bulk settlement upload, company/disbursement-month filters, employee search and optional uploaded-list selection. Generate PDF, Excel and ZIP output; email sending requires a separate explicit action and recipient validation.

Acceptance: Uploaded settlement lines pass employee/date/component validation; exported totals equal approved settlement; preview/export does not send mail.

#### FR-055 Letters and access closure

Priority: Must &#124; Source: Full and Final and separation menus &#124; Evidence: E14/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-016; OQ-12

The system shall generate relieving and experience letters from approved exit data and applicable templates. Proposed account deactivation and asset/document clearance depend on an owner-approved offboarding policy.

Acceptance: The letter shows the approved employment period; closure actions are auditable and do not destroy employee/payroll history.

#### FR-056 Report usability and consistency

Priority: Must &#124; Source: Report and analytics menus &#124; Evidence: E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-026; OQ-13

The system shall support validated date/period filters, pagination, total counts, sortable columns where appropriate, export with a recorded filter snapshot and human-readable no-data/error states. Target CSV/XLSX/PDF support is report-specific and needs approval.

Acceptance: An authorised export matches the report scope and totals; no-data is distinguished from a failed query; large exports run with visible progress and recoverable download links.

#### FR-057 Attributable history

Priority: Must &#124; Source: Audit menus &#124; Evidence: E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-007/026; OQ-02/13/18

The system shall capture actor, role, company, action, record ID, time, outcome and permitted before/after details for employee, salary, policy, approval, processing and rights changes. Mask secrets and protected fields in logs.

Acceptance: Auditors can trace who changed an employee grade and which payroll run used it; audit access cannot mutate the underlying transaction.

#### FR-058 Audit export and retention

Priority: Must &#124; Source: Audit menus &#124; Evidence: E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-007/026; OQ-02/13/18

The system shall restrict audit exports separately from ordinary reports. Define retention and purge rules with business/security owners. Proposed exports record requester, scope and timestamp.

Acceptance: An employee cannot retrieve audit logs; retention removes only eligible records and preserves items under an approved hold.

#### FR-059 Employee portal

Priority: Must &#124; Source: Employee Self Service entry and home areas &#124; Evidence: E01

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-005 to BR-007; OQ-02

The system shall provide proposed own-profile view/change requests, leave/outdoor/holiday-work requests, attendance view/corrections, payslips, investment/claim declarations, KRA/appraisal, timesheets and training participation. Approve the exact services per role and company.

Acceptance: An employee sees only their own records; change requests do not directly alter protected master/payroll fields without authorised review.

#### FR-060 Manager work queue

Priority: Must &#124; Source: Employee Self Service entry and home areas &#124; Evidence: E01

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-005 to BR-007; OQ-02

The system shall provide one proposed queue for assigned leave, attendance, requisition, goal, appraisal and timesheet tasks. Display request details, source, age and permitted actions; counts must share the same filters as the detail list.

Acceptance: Opening a pending task does not approve it; a manager cannot decide a request outside the current scope; dashboard counts reconcile to the queue.

#### FR-061 Alerts and delivery

Priority: Should &#124; Source: Home alerts and alert configuration menus &#124; Evidence: E01/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-027; OQ-13

The system shall configure alerts by event, role, company and channel. Use templates with minimal personal data, deduplication and delivery outcome; escalation times and recipients require owner approval.

Acceptance: A repeated processing event does not send repeated identical alerts; delivery failure is visible and does not reverse an already committed business approval.

#### FR-062 Integrity and effective dates

Priority: Should &#124; Source: Employee organisation records and business processes &#124; Evidence: E03/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-001/002/028; OQ-18/19

The system shall preserve valid business record relationships, unique business identifiers, dated validity, exact monetary amounts and controlled states. Keep immutable processing snapshots and record versions. Preserve transaction dates and timestamps with an explicit timezone policy.

Acceptance: A salary line cannot reference an employee in another company scope; competing updates fail clearly instead of silently overwriting history.

#### FR-063 Service responsibilities

Priority: Should &#124; Source: Employee organisation records and business processes &#124; Evidence: E03/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-001/002/028; OQ-18/19

The system shall keep master maintenance, requests, approvals, processing, reports and imports separately authorised. Record actionable validation outcomes and prevent repeated submission or processing from duplicating a business result.

Acceptance: Retried payroll or import requests return the original job or the same previously recorded result without a second business effect; unauthorised scope fails on the service even if the client omits a filter.

#### FR-064 Import lifecycle

Priority: Must &#124; Source: Bulk upload and export menus &#124; Evidence: E12/E14/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-027; OQ-13

The system shall support import lifecycle. Every upload passes file validation, parse, row validation, preview, authorised commit and outcome reconciliation. Retain a business upload reference and row-level validation outcome. Confirm whether valid rows may commit when other rows fail; default to no silent partial processing.

Acceptance: User can identify accepted/rejected row counts and reasons; cancelling before commit creates no business records; repeated commit cannot double apply.

#### FR-065 Export protection

Priority: Must &#124; Source: Visible export controls &#124; Evidence: E03/E08/E12/E14/E17

Classification: Observed control or menu as cited; detailed target behaviour proposed

Rule and decision dependency: BR-007/026; OQ-02/13

The system shall export only authorised fields and scope, use safe spreadsheet cell handling, record the filter/run version and expire download access. Asynchronous exports must be access-controlled when retrieved.

Acceptance: A user whose export permission is revoked cannot retrieve a previously queued export; formula-like employee text is written safely as data.

#### FR-066 Company scoped role permissions

Priority: Must &#124; Source: User Rights; requested target access design &#124; Evidence: E16

Classification: Proposed target; owner approval pending

Rule and decision dependency: BR-006/007; OQ-02

The system shall allow authorised owners to assign view, edit, submit, approve and export actions separately within an approved organisation scope.

Acceptance: An employee-own role cannot open another employee’s record or export it; a payroll read role cannot approve a result; location and department restrictions apply together.

#### FR-067 Independent permission change review

Priority: Must &#124; Source: Requested target access design &#124; Evidence: Business request

Classification: Proposed target; owner approval pending

Rule and decision dependency: BR-006/007; OQ-02

The system shall retain the proposed change, requesting actor, independent decision actor, reason, decision time and resulting access for a sensitive permission change.

Acceptance: A recipient cannot approve their own increased access; a rejected proposal does not activate access; prior approved assignments remain traceable.

#### FR-068 Access expiry and delegation

Priority: Must &#124; Source: Reporting manager and User Rights menus; requested access design &#124; Evidence: E16/E17

Classification: Proposed target; owner approval pending

Rule and decision dependency: BR-006/007; OQ-02

The system shall limit delegated decisions to the approved period, request category and equivalent reviewer authority.

Acceptance: A decision after delegation expiry is denied; a delegate cannot decide the claimant’s own request or widen the original reviewer’s scope.

#### FR-069 Output and field visibility

Priority: Must &#124; Source: Visible exports; requested target access design &#124; Evidence: E03/E08/E12/E14

Classification: Proposed target; owner approval pending

Rule and decision dependency: BR-006/007; OQ-02

The system shall apply approved record and sensitive-field visibility consistently to lists, details, reports, exports and attachments.

Acceptance: The same restricted field remains absent or masked in each output format; a receipt cannot be opened without access to its parent claim.

#### FR-070 Expense draft and lines

Priority: Must &#124; Source: Requested expense extension; no dedicated source screen verified &#124; Evidence: Business request

Classification: Proposed target; owner approval pending

Rule and decision dependency: BR-017 to BR-025; OQ-16/17

The system shall allow an employee to create and edit their own expense draft with business purpose, currency, dated category lines and receipt links.

Acceptance: A two-line draft retains both line amounts; another employee cannot edit it; a missing unconfirmed exchange rate does not prevent draft saving but blocks submission.

#### FR-071 Expense submission validation

Priority: Must &#124; Source: Requested expense extension &#124; Evidence: Business request

Classification: Proposed target; owner approval pending

Rule and decision dependency: BR-017 to BR-025; OQ-16/17

The system shall validate a claim against the approved eligibility, required receipts, expense policy and currency rules before submission.

Acceptance: A missing required receipt, unsupported currency, ambiguous policy or unresolved duplicate exception blocks submission with a field or rule reason and creates no approval entitlement.

#### FR-072 Manager expense review

Priority: Must &#124; Source: Requested expense extension &#124; Evidence: Business request

Classification: Proposed target; owner approval pending

Rule and decision dependency: BR-017 to BR-025; OQ-16/17

The system shall allow the assigned eligible manager to approve business purpose, return the claim for correction or reject it with a reason.

Acceptance: Unassigned reviewers are denied; a returned claim retains its submitted evidence; manager approval alone does not make the claim payable.

#### FR-073 Finance expense review

Priority: Must &#124; Source: Requested expense extension &#124; Evidence: Business request

Classification: Proposed target; owner approval pending

Rule and decision dependency: BR-017 to BR-025; OQ-16/17

The system shall allow the assigned eligible finance reviewer to decide reimbursable line amounts and final entitlement under approved policy.

Acceptance: Approved amount for each line is between zero and requested amount; reduction/rejection requires a reason; all lines are decided before final approval; zero total produces no payout.

#### FR-074 Claim correction and withdrawal

Priority: Must &#124; Source: Requested expense extension &#124; Evidence: Business request

Classification: Proposed target; owner approval pending

Rule and decision dependency: BR-017 to BR-025; OQ-16/17

The system shall retain earlier submitted revisions when an owner corrects a returned claim, and permit withdrawal only before committed final approval or payment.

Acceptance: Resubmission retains the earlier revision and decisions; simultaneous withdrawal/final approval yields one valid result without two entitlements.

#### FR-075 Duplicate expense review

Priority: Must &#124; Source: Requested expense extension and reimbursement menus &#124; Evidence: Business request/E17

Classification: Proposed target; owner approval pending

Rule and decision dependency: BR-017 to BR-025; OQ-16/17

The system shall identify potential duplicate claims or receipt reuse and require an authorised documented review before accepting a blocking match.

Acceptance: Repeating the same receipt or invoice creates a review exception; clearance retains its reason; legitimate reuse does not automatically create a second entitlement.

#### FR-076 Single expense payment route

Priority: Must &#124; Source: Requested expense extension and reimbursement menus &#124; Evidence: Business request/E17

Classification: Proposed target; owner approval pending

Rule and decision dependency: BR-017 to BR-025; OQ-16/17

The system shall track one approved entitlement through either payroll reimbursement or direct payout, with approved route changes limited to an unpaid unprocessed obligation.

Acceptance: Repeating queue/release actions does not create a second payment; an unknown payment outcome blocks route changes; linked legacy reimbursement does not create a separate payable claim.

#### FR-077 Payment confirmation and reversal

Priority: Must &#124; Source: Requested expense extension &#124; Evidence: Business request

Classification: Proposed target; owner approval pending

Rule and decision dependency: BR-017 to BR-025; OQ-16/17

The system shall distinguish approved, outstanding, partially paid, failed, unknown, paid and reversed expense payment outcomes using confirmed payment evidence.

Acceptance: Calculation or export alone does not mark Paid; approved amount equals net confirmed paid plus outstanding; a reversal retains original evidence and cannot exceed its payment.

#### FR-078 Expense policy and eligibility

Priority: Must &#124; Source: Requested expense extension &#124; Evidence: Business request

Classification: Proposed target; owner approval pending

Rule and decision dependency: BR-017 to BR-025; OQ-16/17

The system shall use approved dated category policies, eligible employee classifications and decision routes, and retain the rules used for submitted claims.

Acceptance: No matching or multiple equally applicable policies blocks submission; later policy changes leave previously approved claim decisions unchanged.

#### FR-079 Expense reports and notices

Priority: Must &#124; Source: Requested expense extension &#124; Evidence: Business request

Classification: Proposed target; owner approval pending

Rule and decision dependency: BR-017 to BR-025; OQ-16/17

The system shall provide scoped claim, approval ageing, payable and reconciliation outputs and outcome notices under confirmed business rules.

Acceptance: A report uses the same period/currency/scope as its underlying claims; repeated event handling does not repeat the same notice or payment.

#### 7.1 Additional requested functional requirements

##### FR-080 Flexible employee confirmation period

Priority: Must &#124; Source: User request dated 6 October 2026; target screen Confirmation Policies and Employee Confirmation Review &#124; Classification: requested target capability; detailed configuration and business parameters pending owner confirmation.

Rule and decision dependency: BR-029 BR-030 BR-031; OQ21 HD11

The system shall allow authorised HR users to configure dated confirmation policies with duration in calendar days or months, applicability and start-date basis, assign a policy to an employee, and propose a reasoned employee-specific duration or due-date override.

Acceptance: Given two synthetic employees assigned different approved durations, their planned due dates differ according to the configured rule. Missing/zero/negative duration, end-before-start, equally applicable policies and unapproved overrides are rejected. Joining-date or policy changes do not silently alter the assigned historical policy or due date.

##### FR-081 Confirmation extension and decision history

Priority: Must &#124; Source: User request dated 6 October 2026; target screen Employee Confirmation Review &#124; Classification: requested target capability; detailed configuration and business parameters pending owner confirmation.

Rule and decision dependency: BR-030 BR-031; OQ21 HD11

The system shall support independent authorised confirmation decisions and reasoned extensions, retain each prior and new due date, record actual confirmation date and actor, and update the employee confirmation status only through an approved decision.

Acceptance: An approved extension records previous due date, new due date and reason without erasing the prior event. Reaching the planned date never auto-confirms an employee. An unauthorised or self decision and a second decision against a stale version fail. Approved confirmation sets actual date and closes the due review; payroll eligibility does not change unless separately configured and approved.

##### FR-082 Confirmation due reminders and lists

Priority: Must &#124; Source: User request dated 6 October 2026; target screen Confirmation Due List and Notification Rules &#124; Classification: requested target capability; detailed configuration and business parameters pending owner confirmation.

Rule and decision dependency: BR-031 BR-034; OQ21 OQ22

The system shall provide permission-scoped upcoming, due, overdue, extended and confirmed views and configurable reminders for confirmation review.

Acceptance: A fixture crossing the company business date moves from upcoming to due and then overdue without changing employment status. Each configured reminder occurrence reaches only eligible recipients once; confirming or cancelling the review suppresses future open-review reminders. Missing policy or reviewer is reported for HR review, not auto-resolved.

##### FR-083 Birthday and work anniversary events

Priority: Must &#124; Source: User request dated 6 October 2026; target screen Employee Events and Notification Rules &#124; Classification: requested target capability; detailed configuration and business parameters pending owner confirmation.

Rule and decision dependency: BR-032 BR-033 BR-034; OQ22 HD12

The system shall generate configurable birthday and work anniversary notifications for eligible active employees using approved event dates, company business timezone, recipient scope and celebration privacy preferences.

Acceptance: Birthday and anniversary fixtures produce one event occurrence per employee/type/year and eligible recipient/channel. Opted-out celebration publication is omitted; notification does not reveal age or full date of birth to colleagues. Inactive/exited employees are excluded. A leap-day fixture follows the explicit configured non-leap-year rule; no event is sent when that rule is missing.

##### FR-084 Request and HR status notifications

Priority: Must &#124; Source: User request dated 6 October 2026; target screen Leave Review and Notification Rules &#124; Classification: requested target capability; detailed configuration and business parameters pending owner confirmation.

Rule and decision dependency: BR-033 BR-034; OQ22 HD12

The system shall notify configured authorised recipients after committed leave submission, approval, rejection, return for correction, withdrawal/cancellation and amendment events, and support configured events for confirmation decisions, increment decisions, assigned approval reminders, document expiry and biometric sync failure.

Acceptance: Submission alerts the eligible assigned reviewer; committed approval/rejection/return/cancellation alerts the claimant according to configured routing. Rollback creates no success event. A rejected request cannot generate an accepted message. Sensitive leave reasons and salary/increment amounts are not broadcast to unrelated employees. Unsupported/unconfigured optional event rules remain disabled.

##### FR-085 Notification configuration and delivery tracking

Priority: Must &#124; Source: User request dated 6 October 2026; target screen Notification Rules and Delivery Log &#124; Classification: requested target capability; detailed configuration and business parameters pending owner confirmation.

Rule and decision dependency: BR-032 BR-033 BR-034; OQ22 HD12

The system shall provide versioned message templates, explicit recipient selectors, configurable supported channels and reminder timing, optional-event preferences, delivery attempts, retry limits and visible failed-delivery outcomes.

Acceptance: An authorised rule change takes effect only from its configured date and is audited. Duplicate event processing or delivery callbacks create no duplicate application notification. Failed external delivery follows the configured retry ceiling and remains visible without marking delivered. Business approval succeeds even when notification delivery fails. Mandatory transaction alerts cannot be opted out unless the owner approves that policy; supported channels and limits are explicitly configured, with no assumed default.

##### FR-086 Configurable biometric API and field mapping

Priority: Must &#124; Source: User request dated 6 October 2026; target screen Biometric API Profiles and Field Mapping &#124; Classification: requested target capability; detailed configuration and business parameters pending owner confirmation.

Rule and decision dependency: BR-035 BR-036; OQ23 HD13

The system shall allow explicitly authorised integration administrators to configure a company-scoped biometric attendance API profile, request settings, authentication reference, supported pagination/cursor method, fetch schedule, timezone, bounded lookback and versioned source-to-target field mappings without changing source code for field-name differences.

Acceptance: Two synthetic provider schemas with different employee/time/direction field paths map into the same validated attendance event fields. Activation fails when required mappings, employee-link method, timezone, unique-event strategy or request settings are missing. Targets and transforms are allowlisted; arbitrary executable mapping expressions are rejected. Configuration values and credentials are not included in shared BRD/report output.

##### FR-087 Biometric fetch validation and replay control

Priority: Must &#124; Source: User request dated 6 October 2026; target screen Biometric Sync Monitor &#124; Classification: requested target capability; detailed configuration and business parameters pending owner confirmation.

Rule and decision dependency: BR-035 BR-036 BR-037; OQ23 HD13

The system shall fetch all configured API pages, normalise punches using the run-pinned mapping revision, validate employee/company/time/direction identifiers, quarantine unmatched or invalid events, preserve source evidence and prevent duplicate accepted punches when fetching overlapping windows or retrying a run.

Acceptance: A paginated fixture fetches every page. Replaying overlapping data creates one accepted punch per stable source event key. Same key with altered content is quarantined as a conflict, not silently overwritten. Unknown employee and invalid timestamp/direction produce explicit rejected/quarantined records and no attendance entry. Counts reconcile to accepted, duplicate, rejected and quarantined outcomes; correction and reprocessing retain provenance.

##### FR-088 Biometric sync recovery and authorisation

Priority: Must &#124; Source: User request dated 6 October 2026; target screen Biometric Sync Monitor and Employee Mapping &#124; Classification: requested target capability; detailed configuration and business parameters pending owner confirmation.

Rule and decision dependency: BR-035 BR-036 BR-037; OQ23 HD13

The system shall support scheduled and permission-controlled manual fetch, run status/counts, versioned effective employee links, bounded retries and safe recovery from partial fetch or source failure, with notifications to configured support recipients.

Acceptance: A failure on a later page leaves the completion cursor unadvanced beyond the last fully committed checkpoint; retry retrieves missing data without duplicating accepted punches. Fetch never marks an employee absent solely because the source was unavailable. Employee from another company cannot be mapped; mappings cannot overlap for the same provider identity. Disabling a profile stops new runs, not deletes prior punches. Concurrent identical fetch runs cannot advance the same checkpoint twice.

##### FR-089 Employee history with salary changes

Priority: Must &#124; Source: User request dated 6 October 2026; target screen Employee History and Increment History &#124; Classification: requested target capability; detailed configuration and business parameters pending owner confirmation.

Rule and decision dependency: BR-038 BR-039; OQ24 HD14

The system shall maintain an effective-dated employee timeline covering joining, confirmation/extensions, department/designation/location/manager changes, salary changes, increments and separation, with actor, reason and links to approved source decisions.

Acceptance: Changing an employee master creates a dated attributable history event and does not rewrite prior values. An authorised historical view reconstructs the approved assignment and salary at a chosen date. Users without salary/history field grants cannot view salary amounts or increment percentages even through exports. Reversal/correction is a new linked event rather than history deletion.

##### FR-090 Per increment and annual percentage reporting

Priority: Must &#124; Source: User request dated 6 October 2026; target screen Increment History and Annual Increment Report &#124; Classification: requested target capability; detailed configuration and business parameters pending owner confirmation.

Rule and decision dependency: BR-038 BR-039; OQ24 HD14

The system shall retain before/after values for each approved increment on a declared comparable compensation basis and currency, calculate its change amount and percentage, and report opening-to-closing annual growth separately from individual increment percentages.

Acceptance: For synthetic same-currency/basis amounts 100000 to 110000, change is 10000 and increment is 10 percent. A subsequent 10 percent change to 121000 gives annual opening-to-closing growth 21 percent, not summed 20 percent. Zero/missing opening baseline or a change of currency/basis produces N/A with reason instead of divide-by-zero or guessed conversion. Annual records include year/basis/currency and approved effective changes; rounding follows owner-approved precision.

##### FR-091 Configurable employee increment cycles

Priority: Must &#124; Source: User request dated 6 October 2026; target screen Increment Cycles and Employee Cycle Assignment &#124; Classification: requested target capability; detailed configuration and business parameters pending owner confirmation.

Rule and decision dependency: BR-040 BR-041; OQ25 HD15

The system shall allow authorised HR/Payroll users to configure effective increment cycles, recurrence, eligibility/cutoff, review windows and planned effective dates, assign employees by approved company/group rules and permit reasoned employee-specific next-review-date overrides.

Acceptance: Company common-date and employee-anniversary cycle fixtures generate the expected due roster under approved schedule rules. An employee has at most one applicable primary plan per effective instant unless an explicit exception design is approved. Missing cycle configuration blocks scheduling. Expired/ineligible assignments are excluded with reason; reaching the due date creates a review item, not a guaranteed salary increase.

##### FR-092 Increment proposal approval and effective application

Priority: Must &#124; Source: User request dated 6 October 2026; target screen Increment Review and Payroll Inputs &#124; Classification: requested target capability; detailed configuration and business parameters pending owner confirmation.

Rule and decision dependency: BR-038 BR-040 BR-041; OQ25 HD15

The system shall record cycle-linked or separately authorised off-cycle increment proposals, baseline salary and component changes, retain independent review decisions, and apply an approved revision as one dated salary arrangement linked to the increment history and eligible payroll processing.

Acceptance: Preparer cannot approve own proposal. Changing a baseline salary while a proposal is pending requires revalidation/resubmission and blocks stale application. Replaying approval/application creates one new salary arrangement and one increment-history record. Approved effective dates close/open salary intervals without overlap. No-increment/deferred/rejected decisions do not create a salary revision. Retroactive application into locked payroll follows controlled reopen/arrears workflow, not silent overwrite.

##### FR-093 Confirmation notification sync and increment reports

Priority: Must &#124; Source: User request dated 6 October 2026; target screen New Target Reports &#124; Classification: requested target capability; detailed configuration and business parameters pending owner confirmation.

Rule and decision dependency: BR-034 BR-037 BR-039 BR-041; OQ21 to OQ25

The system shall provide scoped confirmation due/history, upcoming celebration events, notification delivery, biometric sync/exceptions, increment due/decision and employee annual increment reports with permitted filters and exports.

Acceptance: For identical company/employee/period/state/basis/currency filters, exported record counts equal visible eligible records and monetary/increment values match underlying approved history at the same rounding. Restricted personal/financial fields remain omitted. Proposed reports do not enter observed navigation coverage until actually reviewed.

#### 7.4 My Team and role-specific dashboards — requested target

##### FR-094 My Team reporting-member list

Priority: Must. Evidence: user-requested target; source-screen behaviour unverified. Source screen: Proposed My Team → Member list

The system shall list and search only employees linked to the acting manager by a current, effective-dated reporting relationship within the authorised company and organisational scope.

Acceptance: A fixture with two managers, expired links and an unrelated employee returns only current authorised members; changing an employee identifier or filter cannot disclose another team. Pagination and totals match the same permitted set.

##### FR-095 My Team complete authorised employee information

Priority: Must. Evidence: user-requested target; source-screen behaviour unverified. Source screen: Proposed My Team → Employee detail

The system shall provide a member detail view containing every owner-approved information category, with field and document authorization applied independently to each category.

Acceptance: Permitted categories show their approved fields and empty-state messages. Restricted fields, tabs and attachments are absent from responses and outputs. A manager with team access but no salary grant cannot obtain salary; granting salary access exposes it only for that manager’s authorised members.

##### FR-096 Distinct role dashboards

Priority: Must. Evidence: user-requested target; source-screen behaviour unverified. Source screen: Proposed Role Home → Dashboard

The system shall provide a clearly labelled dashboard for each of the 14 baseline roles, containing only the role’s authorised metrics, pending tasks and shortcuts, and displaying the selected role and scope.

Acceptance: Each role fixture receives its corresponding dashboard in C7; zero-data and permission-denied states are distinguishable without revealing restricted counts. A role with no eligible dashboard receives a neutral no-access state. No widget defaults to whole-company scope.

##### FR-097 Dashboard metrics and action consistency

Priority: Must. Evidence: user-requested target; source-screen behaviour unverified. Source screen: Proposed Role Home → Widgets and quick actions

The system shall apply current role, row, field and workflow permissions to dashboard queries, aggregated values, drilldowns and quick actions.

Acceptance: For identical filters, each widget reconciles to its authorised source records. An inaccessible detail cannot be inferred through totals, averages, tooltips or exports. A shortcut cannot perform an action denied on its destination; role expiry invalidates subsequent dashboard and download requests.

##### FR-098 Confidentiality across every delivery surface

Priority: Must. Evidence: user-requested target; source-screen behaviour unverified. Source screen: User-requested target confidentiality policy → all affected screens

The system shall enforce BR-044 on pages, APIs, search suggestions, dashboards, history, exports, print, downloads, attachments, audit views and notification content.

Acceptance: An anonymous caller and each non-eligible operational role are denied confidential fields. Employee OWN context may receive only H1-authorized own ESS fields/issued outputs and is denied all other-person records and reviewer-private fields. An eligible Admin or Manager without a field grant is also denied. An eligible scoped assignment returns only authorised fields and rows. Cached or queued outputs recheck access; denied attempts retain redacted audit evidence without confidential payloads.

Requirement precedence: all earlier FRs remain in the baseline, but viewing and output rights are constrained by FR-098/BR-044. Existing payroll/finance duties grant no confidential access by themselves; own issued payslip access is explicitly permitted only under H1 Employee OWN. A workflow needing restricted values must be reassigned to a properly scoped eligible role or redesigned with approved redaction; until decided, the affected confidential operation is blocked.

#### FR-099 Freeze processed payroll

The system shall atomically freeze an independently approved payroll run when salary calculation processing completes, preserving its inputs, rules, result lines, bank snapshot and audit evidence.

Priority: Must &#124; Source: requested target screen Payroll → Run → Process; user additions dated 8 October 2026; source behavior not verified.

Acceptance criteria: Processing produces PROCESSED_LOCKED only after validation and independent approval; later edit, delete, rerun-in-place and backdated master changes cannot alter the frozen results. Failed processing leaves no partially locked run.

Rules and traceability: Appendix H; BR-047 to BR-055; CI25–CI30; ZT36–ZT40 as applicable.

#### FR-100 Carry late timesheets forward

The system shall create an auditable correction for an approved late or amended timesheet affecting a processed payroll and apply it to an eligible upcoming payroll after independent approval.

Priority: Must &#124; Source: requested target screen Payroll → Adjustments; ESS → Timesheet; user additions dated 8 October 2026; source behavior not verified.

Acceptance criteria: A locked-period timesheet does not alter its original payroll; repeated approval/replay creates one effective adjustment; an approved amount appears once in the first eligible open target run and retains original period linkage.

Rules and traceability: Appendix H; BR-047 to BR-055; CI25–CI30; ZT36–ZT40 as applicable.

#### FR-101 Control salary hold criteria

The system shall evaluate configured salary hold criteria and require a reasoned, independent decision before withholding a payroll payment.

Priority: Must &#124; Source: requested target screen Payroll → Salary Holds; user additions dated 8 October 2026; source behavior not verified.

Acceptance criteria: Missing timesheet alone creates a follow-up exception and never an automatic salary hold or deduction; bank-validation failure prevents payment instruction; authorized policy hold, release and rejection have actor, dates, reason, amount/scope and evidence.

Rules and traceability: Appendix H; BR-047 to BR-055; CI25–CI30; ZT36–ZT40 as applicable.

#### FR-102 Generate bank format files

The system shall generate versioned bank-format files from frozen payroll payment allocations using an activated, validated template and approved bank-detail snapshots.

Priority: Must &#124; Source: requested target screen Payroll → Bank Files; user additions dated 8 October 2026; source behavior not verified.

Acceptance criteria: Draft preview is labeled non-payable; final manifest uses PROCESSED_LOCKED records only, excludes held/already reserved/confirmed amounts, validates every included row and reconciles count/currency/total; generating or downloading does not mark payment successful.

Rules and traceability: Appendix H; BR-047 to BR-055; CI25–CI30; ZT36–ZT40 as applicable.

#### FR-103 Provide complete ESS tabs

The system shall provide the 18 tabs listed in H3 with own-record data, explicit empty or unavailable states, and authorized links to each enabled workflow.

Priority: Must &#124; Source: requested target screen Employee Self Service → My ESS; user additions dated 8 October 2026; source behavior not verified.

Acceptance criteria: Every TN01–TN18 entry is present for an enabled employee account; inactive modules show a named unavailable state with no unrestricted alternative; direct navigation and altered identifiers cannot expose another employee’s records.

Rules and traceability: Appendix H; BR-047 to BR-055; CI25–CI30; ZT36–ZT40 as applicable.

#### FR-104 Approve private profile changes

The system shall accept versioned personal and address change requests without modifying active master data until an independent eligible HR Administrator approves them.

Priority: Must &#124; Source: requested target screen ESS → Personal details change request; Address change; user additions dated 8 October 2026; source behavior not verified.

Acceptance criteria: Submission retains before/proposed values and supporting evidence; return/reject leaves master unchanged; approval checks current master version and future effective date, then applies one authorized revision and history entry.

Rules and traceability: Appendix H; BR-047 to BR-055; CI25–CI30; ZT36–ZT40 as applicable.

#### FR-105 Approve bank detail changes

The system shall route bank changes to an independently authorized HR Administrator for evidence review and apply approved changes according to their effective date and payroll cutoff.

Priority: Must &#124; Source: requested target screen ESS → Bank change request; user additions dated 8 October 2026; source behavior not verified.

Acceptance criteria: Employee cannot directly edit bank master; approval stores a new revision; locked payroll and issued files retain their original bank snapshots; later changes apply to future eligible payments or a separately approved replacement instruction.

Rules and traceability: Appendix H; BR-047 to BR-055; CI25–CI30; ZT36–ZT40 as applicable.

#### FR-106 Control employee documents

The system shall accept category-controlled uploads into quarantined, own-record storage and release them for authorized review only after validation and scanning.

Priority: Must &#124; Source: requested target screen ESS → Document upload; Investment proof; user additions dated 8 October 2026; source behavior not verified.

Acceptance criteria: Unapproved, unscanned or rejected files cannot become verified master evidence; synthetic invalid type, oversize file and failed scan are rejected/quarantined; owner and assigned eligible reviewers only can access a released file.

Rules and traceability: Appendix H; BR-047 to BR-055; CI25–CI30; ZT36–ZT40 as applicable.

#### FR-107 Issue own payroll and tax documents

The system shall allow an employee to view and download only their own issued payslip and tax certificate versions after authorized publication.

Priority: Must &#124; Source: requested target screen ESS → Payslip; Form 16; user additions dated 8 October 2026; source behavior not verified.

Acceptance criteria: Draft/calculation previews are unavailable to Employee; company/employee/period ownership is checked on every preview/download; held salary is identified distinctly from paid salary; publication does not imply payment or statutory filing.

Rules and traceability: Appendix H; BR-047 to BR-055; CI25–CI30; ZT36–ZT40 as applicable.

#### FR-108 Submit tax declarations and proofs

The system shall capture period-specific employee declarations and evidence, retain review decisions and include only accepted inputs in eligible payroll valuations.

Priority: Must &#124; Source: requested target screen ESS → Tax declaration; Investment proof; user additions dated 8 October 2026; source behavior not verified.

Acceptance criteria: Return/reject does not silently create a deduction allowance; cutoff and active tax-rule pack are checked; post-lock acceptance cannot rewrite processed payroll and follows approved later-period adjustment rules where applicable.

Rules and traceability: Appendix H; BR-047 to BR-055; CI25–CI30; ZT36–ZT40 as applicable.

#### FR-109 Expose own business requests

The system shall expose authorized own operational records and request workflows with statuses, balances, attachments and approval history allowed by field classification.

Priority: Must &#124; Source: requested target screen ESS → Leave; Attendance; Regularization; Timesheet; Expense; Loan/advance; user additions dated 8 October 2026; source behavior not verified.

Acceptance criteria: Employee sees own records only, cannot approve own request, cannot alter approved financial entitlement, cannot edit imported punches, and cannot bypass existing leave/expense/loan controls through ESS.

Rules and traceability: Appendix H; BR-047 to BR-055; CI25–CI30; ZT36–ZT40 as applicable.

#### FR-110 Expose own assets and development

The system shall show own assigned assets and acknowledgments, training participation and permitted appraisal self-submissions while preserving reviewer-only information.

Priority: Must &#124; Source: requested target screen ESS → Assets; Training; Appraisal; user additions dated 8 October 2026; source behavior not verified.

Acceptance criteria: Employee cannot transfer/write off assets, mark attendance/completion without evidence, approve loans, or edit manager ratings/private reviewer notes; appraisal goal/self-entry access does not disclose another employee or reviewer-confidential data.

Rules and traceability: Appendix H; BR-047 to BR-055; CI25–CI30; ZT36–ZT40 as applicable.

### 8 Business rules

The following business rules are separated from functional capabilities. Proposed rules require owner approval; observed statements describe visible labels or explanatory text only. Unconfirmed financial formulas and thresholds are intentionally left in Section 14. Business restrictions below reflect the requested target access and expense design, not tested source enforcement.

#### BR-001 Employee identity

Employee code uniqueness scope, mandatory fields and permitted employee types must be confirmed; the proposed target rejects duplicate codes within the approved scope.

Evidence and decision dependency: Proposed; E03; OQ-03

#### BR-002 Employment dates and history

Proposed joining/confirmation/leaving changes retain their effective dates and prior history. Invalid chronological order is rejected unless an approved exceptional process applies.

Evidence and decision dependency: Proposed; E03/E08; OQ-03

#### BR-003 Employee status facets

Current, Offered Rejected, Offered, On Probation, On Notice and Left are visible views. Their eligibility, overlap and transitions are unconfirmed; they are not assumed to be one exclusive stored status.

Evidence and decision dependency: Observed labels; E03; OQ-03

#### BR-004 Master deactivation

Proposed deactivation blocks new use when ineligible while preserving referenced historical classifications. Actual delete/archive behaviour is unconfirmed.

Evidence and decision dependency: Proposed; organisation menus; OQ-18

#### BR-005 Manager authority

Proposed review routing uses approved dated manager/reviewer relationships and prohibits self-approval or reporting cycles.

Evidence and decision dependency: Proposed; manager menus; OQ-02

#### BR-006 Role data scope

Proposed location and department restrictions intersect within one role assignment; unrelated role grants cannot lend each other a broader scope.

Evidence and decision dependency: Requested target design; FR-066

#### BR-007 Sensitive decision changes

Proposed sensitive grant changes require independent recorded approval; role names alone do not permit salary, bank or medical access.

Evidence and decision dependency: Requested target design; FR-067/069

#### BR-008 Shift duration

Shift start/end, breaks, buffer and 24-hour-cycle indicator are visible. Overnight date, break deduction and duration calculation must use signed business examples.

Evidence and decision dependency: Observed fields; E04; OQ-05

#### BR-009 Attendance classifications

Grace, late/early intervals, absence, half-day, present and overtime settings are visible; boundary inclusivity, ordering and reset rules remain unconfirmed.

Evidence and decision dependency: Observed fields; E05; OQ-05

#### BR-010 Leave mapping

Grade/location policy mapping and unmapped-policy colour indication are visible. Accrual, carry, expiry, fractions and cancellation rules require confirmation.

Evidence and decision dependency: Observed text/controls; E06; OQ-06

#### BR-011 Payroll values

Annual cost, monthly gross and estimated in-hand are visible values; their calculation, inclusion and tax treatment are not inferred.

Evidence and decision dependency: Observed labels; E08; OQ-07/08

#### BR-012 Payroll period and release

Financial year and monthly period filters are visible. Calculation, approval, lock, reopen and actual payment are distinct proposed decisions; source states unconfirmed.

Evidence and decision dependency: Observed filters; E09; OQ-09

#### BR-013 Appraisal review levels

Configuration explanatory text describes one-level manager review or two-level manager and manager’s-manager review. Actual routing and decision execution were not tested.

Evidence and decision dependency: Observed text; E11; OQ-10

#### BR-014 Appraisal rating and upload

Rating visibility, competency mapping and KRA upload modes are visible. Value interpretation, weights and formula/manual results require owner confirmation.

Evidence and decision dependency: Observed text; E11; OQ-10

#### BR-015 Training date views

Cancelled, Past, Current and Future views are visible; exact date/time boundaries and participant eligibility are unconfirmed.

Evidence and decision dependency: Observed labels; E13; OQ-12

#### BR-016 Settlement states

Visible settlement views and send/export controls do not prove approval, eligibility or actual payment. Notice, clearances and entitlement rules require confirmation.

Evidence and decision dependency: Observed controls; E14; OQ-12

#### BR-017 Expense ownership and evidence

Only the claimant edits their Draft or Returned work; submission preserves dated line facts and receipt evidence. Final approval prevents in-place changes.

Evidence and decision dependency: Requested target; FR-070/074

#### BR-018 Expense route

Proposed default route is claimant submission, assigned manager review and independent finance final review, with extra threshold reviewer only where approved policy specifies one.

Evidence and decision dependency: Requested target; FR-071/072/073; OQ-16

#### BR-019 Expense policy eligibility

Eligibility uses the approved policy date, category, employee classification and submission conditions. Missing or ambiguous policy blocks submission, rather than using a guessed default.

Evidence and decision dependency: Requested target; FR-078; OQ-16

#### BR-020 Expense amounts

Requested line amount is positive and cannot exceed invoice gross; approved line amount is between zero and requested. Final approved total is the sum of final line decisions only.

Evidence and decision dependency: Requested target; FR-073; OQ-16

#### BR-021 Expense partial approval

Default partial-approval behaviour is not assumed. If enabled by approved policy, every reduction or rejected line needs a reason; zero total creates no payment entitlement.

Evidence and decision dependency: Requested target; FR-073; OQ-16

#### BR-022 Expense currency

A claim uses one currency. Currency support, conversion source/date and rounding require Finance approval; submitted conversion basis remains traceable.

Evidence and decision dependency: Requested target; FR-071/077; OQ-17

#### BR-023 Expense duplicate control

Proposed exact invoice/receipt reuse requires a recorded review; similarity alone cannot determine an automatic rejection.

Evidence and decision dependency: Requested target; FR-075

#### BR-024 Expense payment uniqueness

Proposed approved claim has one live payment obligation and one route. Retry, legacy reimbursement link or changed route cannot create another entitlement.

Evidence and decision dependency: Requested target; FR-076

#### BR-025 Expense unknown and reversal outcomes

Unknown payment outcome blocks a replacement route until reconciled. Successful payment reversals preserve original evidence and do not exceed the original amount.

Evidence and decision dependency: Requested target; FR-077

#### BR-026 Reports and filters

Proposed list and export outputs use identical approved scope, period and filters; report totals reconcile to eligible underlying business records.

Evidence and decision dependency: Observed export controls; target reconciliation

#### BR-027 Import and message actions

Visible upload/send controls were not executed. Mandatory template, row rejection, partial acceptance and recipient rules must be confirmed before changing actions are enabled.

Evidence and decision dependency: Menu/controls; OQ-13

#### BR-028 Zero tolerance business gates

For approved target tests, any failed cross-organisation isolation, self-approval restriction, duplicate entitlement or financial reconciliation blocks release of the affected scope. Required tests are specified, not reported as passed.

Evidence and decision dependency: Requested target assurance; all access/expense requirements

#### 8.1 Additional requested business rules

##### BR-029 Confirmation duration and applicability

Use approved positive day/month duration and explicit joining or other authorised start-date basis. Policy versions are dated; select exactly one applicable policy. Calendar-month end handling and inclusivity require an explicit owner-approved rule. Employee override requires reason and approval, with original policy retained.

Classification: requested target design; detailed parameter approvals pending under OQ21 to OQ25. Applies to FR-080 to FR-093 as mapped above.

##### BR-030 Confirmation decisions and extensions

Planned due date and actual confirmation date are separate. Date expiry never confirms automatically. Every extension and confirmation is an attributable immutable action with previous/new values. Actual confirmation cannot precede joining date; early confirmation and post-confirmation correction require approved rules. Self-decision and stale decisions are blocked.

Classification: requested target design; detailed parameter approvals pending under OQ21 to OQ25. Applies to FR-080 to FR-093 as mapped above.

##### BR-031 Confirmation reminders

Due/overdue review uses the company business date. Reminders follow configured lead time and recipient authority. Closed reviews do not generate open-review reminders. An extension updates future reminders and retains prior occurrences without sending duplicates.

Classification: requested target design; detailed parameter approvals pending under OQ21 to OQ25. Applies to FR-080 to FR-093 as mapped above.

##### BR-032 Celebration privacy and event dates

Use validated protected date of birth and approved service anniversary base date; colleague messages omit full birth date/year and age. Only approved eligible active employment receives celebration events. Respect optional publication preferences and configured leap-day/year rules; do not guess February handling or rejoin/service rules.

Classification: requested target design; detailed parameter approvals pending under OQ21 to OQ25. Applies to FR-080 to FR-093 as mapped above.

##### BR-033 Business notification routing

Generate request status events only after the matching state transition commits. Notify assigned reviewer for pending decision and claimant for outcome; other recipients require explicit scoped rule. An approval rollback or rejected request cannot emit an acceptance message. Amounts and sensitive reasons require matching field permissions.

Classification: requested target design; detailed parameter approvals pending under OQ21 to OQ25. Applies to FR-080 to FR-093 as mapped above.

##### BR-034 Notification deduplication and delivery

Occurrence key includes company, event type, subject, transaction revision or event year/time occurrence as relevant. One logical notification per event/recipient/channel/rule revision; reminders have distinct scheduled occurrence keys. Application retry is idempotent; external provider delivery cannot be guaranteed exactly once without provider support. Keep attempts, states and bounded retries; notification failure never rolls back an already committed business decision.

Classification: requested target design; detailed parameter approvals pending under OQ21 to OQ25. Applies to FR-080 to FR-093 as mapped above.

##### BR-035 Biometric dynamic configuration

Profiles and mapping versions belong to one company. Configure request method/options, authentication reference, pagination/cursor, timezone/schedule, required field paths and approved normalisation transforms. Store live provider addresses and secrets only in restricted configuration, not shared documentation. Required employee identifier, timestamp and unique-event strategy must validate before activation; direction may use a provider-approved explicit default only if absent and owner-approved.

Classification: requested target design; detailed parameter approvals pending under OQ21 to OQ25. Applies to FR-080 to FR-093 as mapped above.

##### BR-036 Biometric identity and event integrity

Resolve each effective external employee identity to exactly one employee in the same company. Normalise provider time to one unambiguous instant using approved timezone and DST ambiguity policy. Deduplicate by profile plus provider event key, or configured deterministic composite where no event key exists. Missing/conflicting keys, altered duplicate content and ambiguous timestamps are quarantined, not guessed.

Classification: requested target design; detailed parameter approvals pending under OQ21 to OQ25. Applies to FR-080 to FR-093 as mapped above.

##### BR-037 Biometric fetch state and counts

Pin mapping version per run; process all pages/checkpoints atomically and advance only committed checkpoints. Count source observations and deduplicated outcomes separately. Late punches enter approved open-period amendment processing; locked historical results are not silently rewritten. A failed sync is not proof of employee absence.

Classification: requested target design; detailed parameter approvals pending under OQ21 to OQ25. Applies to FR-080 to FR-093 as mapped above.

##### BR-038 Increment basis and immutable history

Approved salary change history retains employee, case/decision, effective date, comparable before/after basis values, currency, actor and reason. Keep gross/CTC/basic/component bases distinct. Apply approved change once to salary history; later corrections use controlled attributable superseding events.

Classification: requested target design; detailed parameter approvals pending under OQ21 to OQ25. Applies to FR-080 to FR-093 as mapped above.

##### BR-039 Increment percentages and annual reporting

Per-change percent = ((after - before) / before) * 100 for positive comparable before amount. Annual growth = ((closing - opening) / opening) * 100 on the same approved compensation basis/currency. Do not sum percentages. Before/opening zero, missing or non-comparable produces N/A reason. Annual period and opening/closing as-of conventions, sign treatment and precision require owner approval; show no-change 0 only when comparable values are known.

Classification: requested target design; detailed parameter approvals pending under OQ21 to OQ25. Applies to FR-080 to FR-093 as mapped above.

##### BR-040 Increment cycle eligibility

A cycle is a review schedule, not guaranteed entitlement. Configure common-date or employee-anniversary basis, recurrence, cutoff, eligibility, windows and effective date. Snapshot eligibility when review is opened. Off-cycle cases require explicit authority and distinct case key; primary plan overlaps are rejected. Confirmation/appraisal linkage applies only if configured and approved.

Classification: requested target design; detailed parameter approvals pending under OQ21 to OQ25. Applies to FR-080 to FR-093 as mapped above.

##### BR-041 Increment approval and payroll boundary

Baseline compensation must still be valid at application. Preparer and final approver differ; approver needs assigned financial authority. Proposed/returned/rejected/deferred/no-change cases do not alter salary. Approved effective application is atomic with new salary arrangement, increment history and state/audit. Locked payroll requires controlled reopen/arrears rules; scheduling or reminder does not release payroll or a salary revision.

Classification: requested target design; detailed parameter approvals pending under OQ21 to OQ25. Applies to FR-080 to FR-093 as mapped above.

##### BR-042 Team membership

Use current effective reporting relationships, not department membership alone. Direct reports are the proposed default; team hierarchy depth, inactive members, delegation and historical access require an owner decision. Reassignment changes current team access without erasing employee history.

##### BR-043 Information classification

Maintain an approved catalogue of information categories, field groups, document categories and aggregate sensitivity. Unknown classification defaults to confidential. Non-confidential operational data remains subject to row/action permissions; credentials are never employee-view fields.

##### BR-044 Confidential-role eligibility H1/BR-053 controls the explicit own-record ESS exception introduced in version 8.2.

Latest requested confidentiality rule (version 7.1): confidential information may be disclosed only through an active, owner-approved Admin or Manager role assignment with the necessary field permission and employee scope. Admin eligibility is limited to System Administrator and HR Administrator; Manager eligibility is limited to Reporting Manager. Other role titles are not eligible merely because they include approval or review duties. Eligibility alone grants no field access. The same assignment must provide eligible role, field grant and row scope; combining an eligible role in one scope with another role in a different scope cannot expand confidential access. This rule supersedes earlier proposed self-service, payroll, finance, treasury, recruiter, reviewer and auditor visibility wherever it would disclose confidential information. Until field classification is approved, salary, CTC, increment amounts/percentages, bank/payment/tax details, identity documents, medical details, private contact/address, sensitive leave reasons, appraisal narratives and confidential attachments are restricted. Credentials and integration secrets are never displayed as employee information. The explicit Employee OWN ESS exception in H1 permits only the listed own-record fields and issued outputs; no other implicit exception exists. For own ESS data only, apply the explicit Employee OWN exception in H1; this does not grant other-person or operational-role confidential access.

##### BR-045 Dashboard scope and reconciliation

Widgets inherit the acting assignment scope and required resource/action/field grants. Counts reconcile to permitted source records for identical dates and filters. Confidential derived totals and values require the same eligibility as their inputs; redaction must prevent inference.

##### BR-046 Multiple roles and permission changes H1/BR-053 controls the explicit own-record ESS exception introduced in version 8.2.

Use explicit selected assignment context. Do not combine role eligibility, row scope and sensitive field grants from incompatible assignments. Role/scope/delegation changes invalidate future reads and output downloads; previously generated content must not bypass current access.

BR-047 Processed payroll is immutable. Processing is an approved calculation commit, not a payment confirmation. Corrections create linked adjustments; after PROCESSED_LOCKED there is no unlock-in-place. Earlier reopen proposals apply only before processing.

BR-048 Late timesheets use original service-period rate/rule/calendar snapshots and the current applicable adjustment valuation policy. Compute corrected entitlement minus previously recognized entitlement, not full salary again. Every source revision is uniquely linked; cancellation/reversal is attributable and net correction cannot duplicate previously consumed adjustments.

BR-049 A missing timesheet is not evidence of absence or permission to withhold pay. Create a reminder/exception; use approved attendance/leave and configured valuation inputs. No silent zero salary or automatic deduction; unresolved required calculation inputs block approval and require a documented resolution.

BR-050 Separate payment holds from earned salary calculation. Full or partial holds require an activated hold policy and independent approval, same-currency positive amount within unpaid unreserved payable balance, review date and release criterion. Holds preserve employee liability and never erase payable amounts.

BR-051 Unknown or invalid bank instructions place a payment safety block, not a disciplinary salary forfeiture. Deactivation before the service period excludes future eligibility; separation within the period prorates under approved rules and never automatically forfeits earned/final-settlement amounts. Legal/disciplinary holds require privately validated applicable policy; disabled by default.

BR-052 Final bank files contain payable READY allocations only. Different currencies/bank templates use separate batches. Pending instructions reserve capacity and unknown outcomes remain pending; replacement manifests cannot repeat pending or confirmed allocations without definitive cancellation/failure evidence and independent approval.

BR-053 Employee OWN ESS access is a narrow exception to the prior Admin/Manager-only confidential-read policy. It covers own issued payslip/Form 16, permitted own private profile values, own change submissions/documents and own loan/tax records. It grants no other-person access, confidential reviewer notes, direct master editing, approval, bulk export or admin rights.

BR-054 Protected personal, bank, address, identity, salary, tax identifiers and employment master values cannot be directly mutated by Employee. Employees submit allowable change types; compensation, manager, role, employment and reviewer decisions are not employee-maintainable. Independent approved revision application rechecks row scope, base version, evidence and effective date.

BR-055 Every ESS action and downloaded output uses current company, employee ownership, active assignment, action and field grants. Non-Employee roles must select Employee context for own ESS data. Requests retain revisions and decision history; attachments do not supply authority. UI restrictions must also be enforced on server operations, search, notifications, caches and exports.

### 9 Data requirements

Developer detail: Appendix B defines proposed tables, columns, requiredness, keys, relationships and calculation/history boundaries. These are target design definitions, not inspected source schema.

#### 9.1 Business entities mapped to screens

Mappings below identify expected business records; they do not assert physical source tables or actual persistence. A direct data review is unavailable. Observed fields are labelled separately from proposed required-record expectations. No real employee, customer or financial records are reproduced.

| Business entity | Screen or source area | Business meaning |
| --- | --- | --- |
| Company and organisation | Organisation masters; Employee Master | Employee classifications and permitted organisation scope. |
| Employee and employment history | Employee Master; salary list | Identity, employee code, dates, type and dated classifications. |
| Department designation location grade | Organisation masters; employee and payroll filters | Controlled employee classifications; historical meaning retained. |
| Shift and working calendar | Shift Master; holiday menus | Start/end, breaks and employee applicability. |
| Attendance record and amendment | Attendance Control; attendance reports | Employee/date classification, duration and review history. |
| Attendance policy | Attendance Policy | Dated thresholds, grace and deduction settings; formulas pending. |
| Leave type policy and employee balance | Leave Policy Config; Employee Leave Master | Type and grade/location mapping; balance and movements proposed. |
| Leave or work request | Leave/outdoor/holiday-work menus | Employee, dates, type, reviewed transaction and decision. |
| Salary arrangement and payroll record | Employee Salary Master; Payroll Controller | Effective salary values, period and proposed calculation/review record. |
| Pay component tax and deduction | Payroll configuration/input/compliance menus | Controlled component classification and applicable period rules. |
| Reimbursement and investment declaration | Claim/investment menus | Employee financial input and supporting evidence; no action tested. |
| Payroll loan arrear and salary stop | Loan/arrear/stop menus | Employee obligation or adjustment history; calculation unknown. |
| User role permission and scope assignment | User Master; User Rights | Business actor, allowed actions and organisation restrictions. |
| Manager reviewer and delegation | Reporting Manager; manager upload | Dated business responsibility and proposed temporary substitute. |
| Approval transaction and decision | Home Pending Approvals; approval menus | Target request, stage, reviewer, decision, time and reason. |
| Candidate requisition offer and staffing budget | Hiring menus; Talent Acquisition list | Candidate applications and approved hiring opportunity. |
| Lifecycle process letter and employee note | Process Master; employee process and letters | Process steps, document output and restricted employee notes. |
| Appraisal goals competency and ratings | Appraisal Config and appraisal menus | Cycle, employee goals, reviewer stages and visible rating rules. |
| Project job activity and resource allocation | Timesheet menus; Resource Allocation | Assignment links and proposed work entries. |
| Training plan participant and feedback | Training Plan; participant/feedback menus | Course/date view and expected participation information. |
| Exit clearance and settlement | Full and Final; separation menus | Employee leaving record and proposed reviewed settlement. |
| Report output and decision history | Report/analytics/audit menus | Approved filter context, business totals and attributable changes. |
| Expense claim revision line and receipt | Requested extension; no source page verified | Claimant, retained submission versions, dated amounts and attachments. |
| Expense category policy eligibility and decision | Requested extension | Controlled category, dated eligible classification and line decisions. |
| Expense payout and payment evidence | Requested extension; reimbursement outputs by menu | One approved obligation and confirmed payment/reversal evidence. |


#### 9.2 Important field dictionary

R means proposed required, O means proposed optional, and U means the source mandatory/optional marking was not verified. Every source default below is Unknown unless specifically observed. Proposed expectations cannot be treated as source nullability. Field format and checks are business expectations for validation; exact source limits and accepted values remain pending. For observed list fields, presence in a grid is not evidence of a mandatory entry field.

| Screen and field | Type requirement default | Format and validation | Dependencies and evidence |
| --- | --- | --- | --- |
| Employee Master<br>Company | Controlled selection; R target; U source<br>Default: Unknown | Approved company<br>Select one authorised company | Sets employee and output scope<br>Observed label; source mandatory/default U |
| Employee Master<br>Employee code | Identifier text; R target; U source<br>Default: Unknown | Owner-approved code format<br>Reject duplicate in approved uniqueness scope | Company uniqueness decision<br>Observed label; source mandatory/default U |
| Employee Master<br>Employee name | Text; R target; U source<br>Default: Unknown | Approved display name<br>Required target; permitted length pending | Employee identity<br>Observed label; source mandatory/default U |
| Employee Master<br>Work location | Controlled selection; R target; U source<br>Default: Unknown | Approved location<br>Eligible dated classification | Company and employee assignment<br>Observed label; source mandatory/default U |
| Employee Master<br>Department | Controlled selection; R target; U source<br>Default: Unknown | Approved department<br>Eligible dated classification | Company and employee assignment<br>Observed label; source mandatory/default U |
| Employee Master<br>Designation | Controlled selection; R target; U source<br>Default: Unknown | Approved designation<br>Eligible dated classification | Company and employee assignment<br>Observed label; source mandatory/default U |
| Employee Master<br>Joining date | Date; R target; U source<br>Default: Unknown | Displayed format unconfirmed; business date<br>Chronology per approved employment rule | Employment period<br>Observed label; source mandatory/default U |
| Employee Master<br>Confirmation date | Date; O target; U source<br>Default: Unknown | Business date<br>Cannot predate join without approved exception | Applicable confirmation process<br>Observed label; source mandatory/default U |
| Employee Master<br>Employee type | Coded selection; U source; target pending<br>Default: Unknown | Approved employee-type list<br>No uncontrolled synonyms | Applicable field and policy rules<br>Observed label; source mandatory/default U |
| Employee Master<br>PT location | Coded selection; U source; target pending<br>Default: Unknown | Approved payroll location<br>Eligibility/classification pending | Payroll jurisdiction<br>Observed label; source mandatory/default U |
| Employee Master<br>Status filter | Coded view; U source<br>Default: Unknown | Current/Offered/Probation/Notice/Left views<br>Do not assume exclusive stored status | Confirmed status facet definitions<br>Observed label; source mandatory/default U |
| Shift Master<br>Shift name | Text; U source<br>Default: Unknown | Business label<br>Uniqueness/mandatory marker pending | Approved shift and calendar rules<br>Observed label; source mandatory/default U |
| Shift Master<br>In time | Time; U source<br>Default: Unknown | Clock time<br>Overnight interpretation pending | Approved shift and calendar rules<br>Observed label; source mandatory/default U |
| Shift Master<br>Out time | Time; U source<br>Default: Unknown | Clock time<br>Duration rule pending | Approved shift and calendar rules<br>Observed label; source mandatory/default U |
| Shift Master<br>Break out time | Time; U source<br>Default: Unknown | Clock time<br>Pairing and deduction pending | Approved shift and calendar rules<br>Observed label; source mandatory/default U |
| Shift Master<br>Break in time | Time; U source<br>Default: Unknown | Clock time<br>Pairing and deduction pending | Approved shift and calendar rules<br>Observed label; source mandatory/default U |
| Shift Master<br>Buffer | Duration number; U source<br>Default: Unknown | Displayed minute unit where labelled<br>Nonnegative/range rule pending | Approved shift and calendar rules<br>Observed label; source mandatory/default U |
| Shift Master<br>Shift hours | Duration number; U source<br>Default: Unknown | Hours<br>Stored versus derived unknown | Approved shift and calendar rules<br>Observed label; source mandatory/default U |
| Shift Master<br>24 hour cycle | Flag; U source<br>Default: Unknown | Yes/no representation<br>Date attribution pending | Approved shift and calendar rules<br>Observed label; source mandatory/default U |
| Shift Master<br>Active | Flag; U source<br>Default: Unknown | Yes/no representation<br>Deactivation effect unknown | Approved shift and calendar rules<br>Observed label; source mandatory/default U |
| Shift Master<br>Employee count | Whole number; U source<br>Default: Unknown | Count<br>Assignment/date/filter basis unknown | Approved shift and calendar rules<br>Observed label; source mandatory/default U |
| Attendance Policy<br>Grace period | Duration number; U source<br>Default: Unknown | Minutes where labelled<br>Boundary/reset rules pending | Employee shift and applicable policy<br>Observed label; source mandatory/default U |
| Attendance Policy<br>Late or early interval | Duration number; U source<br>Default: Unknown | Displayed interval unit<br>Applicability and counting pending | Employee shift and applicable policy<br>Observed label; source mandatory/default U |
| Attendance Policy<br>Leave deduction | Amount of leave; U source<br>Default: Unknown | Leave units<br>Fraction/rounding/precedence pending | Employee shift and applicable policy<br>Observed label; source mandatory/default U |
| Attendance Policy<br>Paid day deduction | Day units; U source<br>Default: Unknown | Day fraction<br>Payroll linkage pending | Employee shift and applicable policy<br>Observed label; source mandatory/default U |
| Attendance Policy<br>Absent threshold | Duration number; U source<br>Default: Unknown | Displayed unit<br>Inclusive boundary pending | Employee shift and applicable policy<br>Observed label; source mandatory/default U |
| Attendance Policy<br>Half day threshold | Duration number; U source<br>Default: Unknown | Displayed unit<br>Inclusive boundary pending | Employee shift and applicable policy<br>Observed label; source mandatory/default U |
| Attendance Policy<br>Present threshold | Duration number; U source<br>Default: Unknown | Displayed unit<br>Precedence pending | Employee shift and applicable policy<br>Observed label; source mandatory/default U |
| Attendance Policy<br>Overtime | Duration or setting; U source<br>Default: Unknown | Displayed unit<br>Eligibility/approval/calculation pending | Employee shift and applicable policy<br>Observed label; source mandatory/default U |
| Attendance Policy<br>Effective from | Date; U source<br>Default: Unknown | Business date<br>Policy overlap resolution pending | Employee shift and applicable policy<br>Observed label; source mandatory/default U |
| Leave Policy Config<br>Leave type | Controlled selection; U source<br>Default: Unknown | Approved leave category<br>Code meanings and eligibility pending | Company, employee classification and dated policy<br>Observed label; source mandatory/default U |
| Leave Policy Config<br>Effective from | Date; U source<br>Default: Unknown | Business date<br>Policy interval pending | Company, employee classification and dated policy<br>Observed label; source mandatory/default U |
| Leave Policy Config<br>Grade mapping | Controlled classification; U source<br>Default: Unknown | One or more eligible grades<br>Unmapped status explicitly visible | Company, employee classification and dated policy<br>Observed label; source mandatory/default U |
| Leave Policy Config<br>Location mapping | Controlled classification; U source<br>Default: Unknown | One or more eligible locations<br>Mapping precedence pending | Company, employee classification and dated policy<br>Observed label; source mandatory/default U |
| Salary and payroll views<br>Annual CTC | Amount; U source<br>Default: Unknown | Displayed currency and amount<br>Stored/derived and inclusions unknown | Company, employee and period filters<br>Observed label; source mandatory/default U |
| Salary and payroll views<br>Monthly gross | Amount; U source<br>Default: Unknown | Displayed currency and amount<br>Head reconciliation pending | Company, employee and period filters<br>Observed label; source mandatory/default U |
| Salary and payroll views<br>Grade | Controlled selection; U source<br>Default: Unknown | Approved grade<br>Salary applicability pending | Company, employee and period filters<br>Observed label; source mandatory/default U |
| Salary and payroll views<br>Effective date | Date; U source<br>Default: Unknown | Business date<br>Historical salary boundaries pending | Company, employee and period filters<br>Observed label; source mandatory/default U |
| Salary and payroll views<br>Estimated in hand | Amount; U source<br>Default: Unknown | Estimated net value<br>Estimate formula and exclusions unconfirmed | Company, employee and period filters<br>Observed label; source mandatory/default U |
| Salary and payroll views<br>Financial year | Coded period; U source<br>Default: Unknown | Approved fiscal year<br>Year boundaries pending | Company, employee and period filters<br>Observed label; source mandatory/default U |
| Salary and payroll views<br>Payroll month | Coded period; U source<br>Default: Unknown | April to March options observed<br>Selected period must match displayed results | Company, employee and period filters<br>Observed label; source mandatory/default U |
| Appraisal Config<br>Section visibility | Flags; U source<br>Default: Unknown | Displayed configuration choices<br>Visible-section meanings pending | Employee grade, cycle and reviewer settings<br>Observed label; source mandatory/default U |
| Appraisal Config<br>Competency mapping | Coded selection; U source<br>Default: Unknown | Grade basis<br>Eligibility weights pending | Employee grade, cycle and reviewer settings<br>Observed label; source mandatory/default U |
| Appraisal Config<br>Rating visibility | Coded setting; U source<br>Default: Unknown | Visible setting values<br>Value 3 interpretation pending | Employee grade, cycle and reviewer settings<br>Observed label; source mandatory/default U |
| Appraisal Config<br>Approval level | Whole number setting; U source<br>Default: Unknown | One/two level explanatory text<br>Routing execution not tested | Employee grade, cycle and reviewer settings<br>Observed label; source mandatory/default U |
| Appraisal Config<br>Cycle month | Coded month; U source<br>Default: Unknown | Month selection<br>Cycle boundary pending | Employee grade, cycle and reviewer settings<br>Observed label; source mandatory/default U |
| Appraisal Config<br>KRA upload mode | Coded setting; U source<br>Default: Unknown | Modes explained on screen<br>Accepted modes/meaning require confirmation | Employee grade, cycle and reviewer settings<br>Observed label; source mandatory/default U |
| Appraisal Config<br>Rating method | Coded choice; U source<br>Default: Unknown | Formula/manual explanatory text<br>Formula and decimal precision pending | Employee grade, cycle and reviewer settings<br>Observed label; source mandatory/default U |
| User Rights<br>Company | Controlled selection; U source<br>Default: Unknown | Authorised company<br>Scope consistency | Approved role and company scope<br>Observed label; source mandatory/default U |
| User Rights<br>Search on | Controlled selection; U source<br>Default: Unknown | Role/employee/user type/active/code/login identifier<br>Selected meaning controls text search | Approved role and company scope<br>Observed label; source mandatory/default U |
| User Rights<br>Search text | Text; U source<br>Default: Unknown | Based on chosen search criterion<br>Empty/partial/exact match rules pending | Approved role and company scope<br>Observed label; source mandatory/default U |
| User Rights<br>Active | Flag/filter; U source<br>Default: Unknown | Displayed active value<br>Inactive user access unverified | Approved role and company scope<br>Observed label; source mandatory/default U |
| Full and Final<br>Disbursement month | Coded period; U source<br>Default: Unknown | Business month<br>Payment versus settlement period pending | Company, claimant employee and settlement period<br>Observed label; source mandatory/default U |
| Full and Final<br>Employee search | Text/selection; U source<br>Default: Unknown | Approved employee search<br>Search criteria pending | Company, claimant employee and settlement period<br>Observed label; source mandatory/default U |
| Full and Final<br>Settlement view | Coded view; U source<br>Default: Unknown | Visible settlement status choices<br>Status meanings and lifecycle pending | Company, claimant employee and settlement period<br>Observed label; source mandatory/default U |
| Full and Final<br>Uploaded list search | Text/selection; U source<br>Default: Unknown | Displayed uploaded-list search<br>Import matching rules pending | Company, claimant employee and settlement period<br>Observed label; source mandatory/default U |
| Expense extension<br>Claim reference | Identifier; R target<br>Default: Unknown | Generated unique business reference<br>No duplicate claim reference | Created claim<br>Proposed field; no source screen verified |
| Expense extension<br>Claimant | Employee reference; R target<br>Default: Unknown | Own employee identity<br>No alternate claimant without authorised support rule | Own access mapping<br>Proposed field; no source screen verified |
| Expense extension<br>Business purpose | Text; R target<br>Default: Unknown | Meaningful business explanation<br>Nonblank; approved length pending | Claim<br>Proposed field; no source screen verified |
| Expense extension<br>Currency | Controlled code; R target<br>Default: Unknown | Approved currency<br>Unsupported currency blocks submit | Approved category/payment support<br>Proposed field; no source screen verified |
| Expense extension<br>Category | Controlled reference; R target<br>Default: Unknown | Approved expense category<br>Valid dated policy | Line and eligibility<br>Proposed field; no source screen verified |
| Expense extension<br>Incurred date | Date; R target<br>Default: Unknown | Business date<br>Age/eligibility limits owner-confirmed | Line policy date<br>Proposed field; no source screen verified |
| Expense extension<br>Merchant | Text; R target<br>Default: Unknown | Receipt merchant label<br>Nonblank; duplicate review basis | Invoice/receipt<br>Proposed field; no source screen verified |
| Expense extension<br>Invoice reference | Text; O target<br>Default: Unknown | Document reference<br>Repeated value triggers configured review | Merchant and claimant context<br>Proposed field; no source screen verified |
| Expense extension<br>Gross amount | Amount; R target<br>Default: Unknown | Decimal in claim currency<br>Positive; requested amount cannot exceed gross | Currency precision<br>Proposed field; no source screen verified |
| Expense extension<br>Tax amount | Amount; O target<br>Default: Unknown | Decimal in claim currency<br>Between zero and gross if supplied | Finance tax coding decision<br>Proposed field; no source screen verified |
| Expense extension<br>Requested amount | Amount; R target<br>Default: Unknown | Decimal in claim currency<br>Positive; approved precision | Gross amount<br>Proposed field; no source screen verified |
| Expense extension<br>Receipt | Attachment reference; Conditional target<br>Default: Unknown | Approved document type<br>Required per approved threshold/exception | Category/date/claim owner<br>Proposed field; no source screen verified |
| Expense extension<br>Exception reason | Text; Conditional target<br>Default: Unknown | Business justification<br>Required when policy exception is requested | Exception routing<br>Proposed field; no source screen verified |
| Expense extension<br>Final approved amount | Amount; Derived target<br>Default: Unknown | Final line decision total<br>Each line zero to requested; no duplicate sum | Independent final review<br>Proposed field; no source screen verified |
| Expense extension<br>Claim state | Controlled status; R target<br>Default: Unknown | Draft/In Approval/Returned/Rejected/Approved/Cancelled<br>Allowed transition only | Decision and revision history<br>Proposed field; no source screen verified |
| Expense extension<br>Payment route | Controlled choice; Conditional target<br>Default: Unknown | Payroll or Direct<br>One live route; unknown outcome blocks switch | Approved claim and eligible processing<br>Proposed field; no source screen verified |
| Expense extension<br>Payment outcome | Controlled status; Derived target<br>Default: Unknown | Outstanding/Partial/Unknown/Failed/Paid/Reversed<br>Confirmed evidence required | Approved entitlement and payment history<br>Proposed field; no source screen verified |
| Common accountable records<br>Created time | Date and time; R target; U source<br>Default: Unknown | Unambiguous business event time<br>Retained for record creation | Business record<br>Proposed required-record expectation; source audit fields not inspected |
| Common accountable records<br>Created by | Business actor reference; R target; U source<br>Default: Unknown | Authorised actor<br>Actor identity retained without personal account values | Business record and approved action<br>Proposed required-record expectation; source audit fields not inspected |
| Common accountable records<br>Last changed time | Date and time; Conditional target; U source<br>Default: Unknown | Unambiguous change time<br>Later changes retain history as approved | Mutable business record<br>Proposed required-record expectation; source audit fields not inspected |
| Common accountable records<br>Last changed by | Business actor reference; Conditional target; U source<br>Default: Unknown | Authorised actor<br>Reviewable attribution | Change history<br>Proposed required-record expectation; source audit fields not inspected |
| Common accountable records<br>Decision time | Date and time; Conditional target; U source<br>Default: Unknown | Decision event time<br>Required for completed decision | Approval or rejection<br>Proposed required-record expectation; source audit fields not inspected |
| Common accountable records<br>Decision reason | Text; Conditional target; U source<br>Default: Unknown | Business reason<br>Required for reject, return, reduction and exceptional action | Decision type<br>Proposed required-record expectation; source audit fields not inspected |
| Common accountable records<br>Effective start and end | Business dates; Conditional target; U source<br>Default: Unknown | Dated validity interval<br>Approved non-overlap and chronology rules | Employment, assignment, policy or role validity<br>Proposed required-record expectation; source audit fields not inspected |
| Role and approval design<br>Role | Controlled reference; R target; U source<br>Default: Unknown | Approved role catalogue<br>Name alone grants no business action | User assignment<br>Proposed target; role-specific source data unverified |
| Role and approval design<br>Permission action | Controlled reference; R target; U source<br>Default: Unknown | View/edit/submit/approve/export/process<br>Separate allowed action | Role and resource<br>Proposed target; role-specific source data unverified |
| Role and approval design<br>Organisation scope | Controlled references; R target; U source<br>Default: Unknown | Company/location/department<br>Intersect applicable restrictions | Same role assignment<br>Proposed target; role-specific source data unverified |
| Role and approval design<br>Assignment start and end | Business dates; R start/O end target; U source<br>Default: Unknown | Approved validity interval<br>Inactive/expired assignment does not grant action | Role scope<br>Proposed target; role-specific source data unverified |
| Role and approval design<br>Own employee link | Employee reference; Conditional target; U source<br>Default: Unknown | One relevant employee identity<br>Unambiguous own-record mapping | Employee self access<br>Proposed target; role-specific source data unverified |
| Role and approval design<br>Manager or reviewer link | Employee/actor reference; Conditional target; U source<br>Default: Unknown | Eligible assigned authority<br>No self approval or hierarchy cycle | Dated reporting and transaction<br>Proposed target; role-specific source data unverified |
| Role and approval design<br>Delegation start and end | Business dates; R target; U source<br>Default: Unknown | Bounded authorised interval<br>Expired delegation cannot act | Request category and equivalent authority<br>Proposed target; role-specific source data unverified |
| Role and approval design<br>Active assignment | Controlled state; R target; U source<br>Default: Unknown | Pending/Active/Revoked target choices<br>Expansion requires independent approval | Reviewed authority change<br>Proposed target; role-specific source data unverified |
| Expense policy and history<br>Policy reference and version | Controlled reference; R on submit target<br>Default: Unknown | Approved dated category policy<br>No ambiguous/missing published match | Eligibility and incurred/submitted date<br>Proposed extension; no source data inspected |
| Expense policy and history<br>Eligible classifications | Controlled references; R target<br>Default: Unknown | Approved grade/location/department sets<br>Intersections apply; empty restriction is not unrestricted | Expense policy<br>Proposed extension; no source data inspected |
| Expense policy and history<br>Receipt threshold | Amount; Conditional target<br>Default: Unknown | Approved category/currency threshold<br>Boundary and missing-receipt route owner-confirmed | Category and exception policy<br>Proposed extension; no source data inspected |
| Expense policy and history<br>Conversion basis | Rate/date/source description; Conditional target<br>Default: Unknown | Finance-approved conversion<br>Missing conversion blocks foreign-currency submit | Claim currency and accounting currency<br>Proposed extension; no source data inspected |
| Expense policy and history<br>Submission revision | Whole-number version; R submitted target<br>Default: Unknown | Retained version sequence<br>Earlier submitted facts not overwritten | Claim and decisions<br>Proposed extension; no source data inspected |
| Expense policy and history<br>Project and cost classification | Controlled references; O target<br>Default: Unknown | Approved project/cost classification<br>Only eligible reference selections | Expense line and Finance coding<br>Proposed extension; no source data inspected |
| Confirmation Policies<br>Duration | positive integer; Target R; default: none unless explicitly approved. | Positive amount; unit separately chosen; invalid/zero/negative rejected. | Duration unit, policy applicability; target-only field, source marker not observed. |
| Confirmation Policies<br>Duration unit | controlled code; Target R; default: none unless explicitly approved. | CALENDAR_DAYS or CALENDAR_MONTHS. | Approved calendar/inclusive end rule; target-only field, source marker not observed. |
| Confirmation Policies<br>Start-date basis | controlled code; Target R; default: none unless explicitly approved. | JOINING_DATE or approved alternate date. | Joining date; owner-approved alternatives; target-only field, source marker not observed. |
| Confirmation Policies<br>Effective dates and applicability | date and controlled references; Target R; default: none unless explicitly approved. | Half-open dates; match approved grade/location or company policy. | Policy revision and unambiguous matching; target-only field, source marker not observed. |
| Employee Confirmation<br>Policy revision | business reference; Target R; default: none unless explicitly approved. | Pinned dated policy for assigned employee. | Company, employee classification and date; target-only field, source marker not observed. |
| Employee Confirmation<br>Override duration or due date | integer or date; Target C; default: none unless explicitly approved. | Exactly one approved override method; positive duration or due date not before start. | Reason, proposer and approval; target-only field, source marker not observed. |
| Employee Confirmation<br>Planned start and due dates | date; Target R; default: none unless explicitly approved. | Explicit calendar date under approved date rule. | Policy/start basis/override; target-only field, source marker not observed. |
| Employee Confirmation<br>Actual confirmation date | date; Target C; default: none unless explicitly approved. | Required for confirmed state; not before joining. | Approved decision; target-only field, source marker not observed. |
| Employee Confirmation<br>Extension reason and new due date | text and date; Target C; default: none unless explicitly approved. | Required for extension; new due after prior due unless approved correction. | Prior due, decision authority, version; target-only field, source marker not observed. |
| Employee Confirmation<br>Review state | controlled code; Target R; default: none unless explicitly approved. | Defined confirmation state catalogue. | Decision lifecycle, due view is derived; target-only field, source marker not observed. |
| Employee Events<br>Date of birth | protected date; Target C; default: none unless explicitly approved. | Required only for enabled birthday processing; future date rejected. | Privacy permissions and publication preference; target-only field, source marker not observed. |
| Employee Events<br>Service anniversary base date | date; Target C; default: none unless explicitly approved. | Required for enabled anniversary; joining date or approved service base. | Rejoin/service rule, business timezone; target-only field, source marker not observed. |
| Notification Rules<br>Event type and effective rule revision | controlled code and reference; Target R; default: none unless explicitly approved. | Known supported event, dated version. | Event catalogue and subject domain; target-only field, source marker not observed. |
| Notification Rules<br>Recipient selector | controlled code; Target R; default: none unless explicitly approved. | Claimant, assigned reviewer or explicitly approved scoped recipients. | RBAC plus field group; target-only field, source marker not observed. |
| Notification Rules<br>Channel and message template revision | controlled code and reference; Target R; default: none unless explicitly approved. | Supported channel only; approved template placeholders. | Notification service category and field scope; target-only field, source marker not observed. |
| Notification Rules<br>Schedule timezone lead time retry ceiling | timezone and nonnegative integers; Target C; default: none unless explicitly approved. | Explicit if scheduled/retried; valid timezone, bounded nonnegative values. | Approved delivery timing and provider capability; target-only field, source marker not observed. |
| Notification Preferences<br>Optional celebration publication preference | boolean; Target C; default: none unless explicitly approved. | Explicit for publication; no assumed consent. | Employee event eligibility and preference policy; target-only field, source marker not observed. |
| Notification Delivery<br>Event key delivery state and attempts | identifier code integer; Target R; default: none unless explicitly approved. | Idempotent occurrence key; attempts counted; delivered only with evidence. | Committed event, recipient, channel; target-only field, source marker not observed. |
| Biometric API Profiles<br>Provider profile and company | business references; Target R; default: none unless explicitly approved. | One controlled profile in selected company. | Integration administrator scope; target-only field, source marker not observed. |
| Biometric API Profiles<br>Restricted request settings authentication reference | protected configuration/reference; Target R; default: none unless explicitly approved. | Configured method/parameters/secret reference; no shared connection values. | Approved provider and restricted integration permission; target-only field, source marker not observed. |
| Biometric API Profiles<br>Pagination cursor and lookback settings | controlled config and positive range; Target R; default: none unless explicitly approved. | Explicit provider strategy; bounded date window and continuation handling. | Profile version, fetch recovery; target-only field, source marker not observed. |
| Biometric API Profiles<br>Timezone schedule and active flag | controlled timezone schedule boolean; Target R; default: none unless explicitly approved. | Approved business/provider time interpretation; disabled means no new runs. | Profile activation checks; target-only field, source marker not observed. |
| Biometric Field Mapping<br>Source field path | text; Target R; default: none unless explicitly approved. | Supported field path for JSON/provider structure, not executable code. | Pinned mapping revision; target-only field, source marker not observed. |
| Biometric Field Mapping<br>Target attendance field | allowlisted code; Target R; default: none unless explicitly approved. | Employee identifier/time/direction/event key/device identifier as supported. | Required mapping set; target-only field, source marker not observed. |
| Biometric Field Mapping<br>Transform format or enum mapping | controlled configuration; Target C; default: none unless explicitly approved. | Approved date parsing, enum mapping and whitelisted transforms only. | Provider schema and timezone; target-only field, source marker not observed. |
| Biometric Employee Mapping<br>External employee identity | identifier text; Target R; default: none unless explicitly approved. | Stable provider identity; no overlap for same profile/date. | Profile, same-company employee, effective dates; target-only field, source marker not observed. |
| Biometric Sync Monitor<br>Run range mapping revision cursor counts state | dates references integers codes; Target R; default: none unless explicitly approved. | Committed checkpoints; reconciled accepted/duplicate/rejected/quarantined counts. | Pinned mappings and sync failure controls; target-only field, source marker not observed. |
| Increment Cycles<br>Cycle code revision and active period | code integer dates; Target R; default: none unless explicitly approved. | Unique code/revision; positive revision, non-overlapping applicability. | Company and cycle selection; target-only field, source marker not observed. |
| Increment Cycles<br>Recurrence basis unit and interval | controlled codes positive integer; Target R; default: none unless explicitly approved. | Common-date or service-anniversary schedule; explicit recurrence. | Owner-approved annual/other cadence; target-only field, source marker not observed. |
| Increment Cycles<br>Eligibility cutoff review window effective-date rule | controlled rule and dates; Target R; default: none unless explicitly approved. | Explicit rule; no guaranteed increment. | Confirmation/appraisal link only if configured; target-only field, source marker not observed. |
| Employee Increment Plan<br>Employee and cycle assignment dates | references and dates; Target R; default: none unless explicitly approved. | Same company; no simultaneous primary plan. | Effective eligibility; target-only field, source marker not observed. |
| Employee Increment Plan<br>Next-review override and reason | date and text; Target C; default: none unless explicitly approved. | Required reason and approval for override. | Cycle schedule and prior next-review date; target-only field, source marker not observed. |
| Increment Review<br>Baseline and proposed salary arrangement | reference and exact amounts; Target R; default: none unless explicitly approved. | Old arrangement belongs to employee and matches approved basis/currency. | Current applicable salary and baseline version; target-only field, source marker not observed. |
| Increment Review<br>Compensation basis and currency | controlled codes; Target R; default: none unless explicitly approved. | ANNUAL_CTC/MONTHLY_GROSS/BASIC or approved component basis; comparable currencies. | Approved basis definition and rounding; target-only field, source marker not observed. |
| Increment Review<br>Proposed percentage or amount | exact decimal; Target C; default: none unless explicitly approved. | Declare input mode; validate computed counterpart after rounding. | Positive comparable baseline; decrease/zero rules owner-approved; target-only field, source marker not observed. |
| Increment Review<br>Approved amount percentage effective date | exact decimals and date; Target C; default: none unless explicitly approved. | Required only for approved application; separate from proposed values. | Independent approval and valid baseline; target-only field, source marker not observed. |
| Increment Review<br>Cycle/off-cycle key reason and state | identifier text controlled code; Target R; default: none unless explicitly approved. | Distinct off-cycle authority; attributable decision. | Cycle eligibility and workflow revision; target-only field, source marker not observed. |
| Increment History<br>Before after change and percentage | exact monetary/percentage decimals; Target R/C; default: none unless explicitly approved. | Values required; percent nullable with N/A reason for non-comparability. | Immutable approved event, same basis and currency; target-only field, source marker not observed. |
| Annual Increment Report<br>Year period opening closing growth | period dates exact decimals; Target R/C; default: none unless explicitly approved. | Known comparable opening/closing amounts; growth separate from change list. | Year boundary/date rule and permission scope; target-only field, source marker not observed. |
| Employee History<br>Event date actor source record and before/after | dates actor reference protected values; Target R; default: none unless explicitly approved. | Attributable linked business event; immutable corrections. | Source domain event and history field permission; target-only field, source marker not observed. |
| Access policy: role classification | CODE required; default OTHER | ADMIN / MANAGER / OTHER; approved eligible roles only | Owner-approved role definition; proposed target |
| Access policy: resource | CODE required; no default | Controlled resource catalogue; unique active resource/group revision | Classification editor; proposed target |
| Access policy: field group | CODE required; no default | Controlled field/document/aggregate category | Resource and permissions; proposed target |
| Access policy: classification | CODE required; default CONFIDENTIAL | CONFIDENTIAL / OPERATIONAL; unknown denied | Approved classification catalogue; proposed target |
| Access policy: effective dates | DATE start required/end optional; no default | End after start; active periods do not overlap | Policy revision; proposed target |
| Access policy: approval | Actor/time required on activation; no default | Recorded authorized actor and timestamp | Approved workflow; proposed target |
| Dashboard definition: role | Reference required; no default | Existing role in company scope | Role selection; proposed target |
| Dashboard definition: code/revision | CODE/positive INTEGER required; no default | Unique role/code/revision | Versioned definition; proposed target |
| Dashboard definition: title | TEXT required; no default | Nonempty approved visible label | Role dashboard; proposed target |
| Dashboard definition: state | CODE required; default DRAFT | DRAFT / ACTIVE / RETIRED; one active per role/code | Activation validation; proposed target |
| Dashboard widget: parent | Reference required; no default | Same-company dashboard definition | Widget editor; proposed target |
| Dashboard widget: permission | Reference required; no default | Controlled permission; never bypass field/row checks | Permission catalogue; proposed target |
| Dashboard widget: code/position | CODE/nonnegative INTEGER required; no default | Unique widget code; deterministic display order | Parent dashboard; proposed target |
| Dashboard widget: metric/field group | CODE required; no default | Approved metric formula and classified inputs/output | Controlled catalogue; proposed target |
| Dashboard widget: scope | CODE required; no default | Assignment-relative; cannot broaden parent assignment | Current role assignment; proposed target |
| Dashboard widget: display kind | CODE required; no default | Controlled count/list/chart/shortcut; permitted drilldown | Metric and action permissions; proposed target |
| Assignment grant: parent | Reference required; no default | Existing same-company independently approved assignment | DF02; DB109; target selected |
| Assignment grant: permission | Reference required; no default | Allowed resource/action/field group in parent role; no DENY override | DF02; DB109; target selected |
| Assignment grant: active | Boolean required; default false | True only after independent parent approval | DF02; DB109; target selected |
| Assignment grant: effective start | Timestamp required; no default | At/after assignment start; actual request check | DF02; DB109; target selected |
| Assignment grant: effective end | Timestamp optional; default null | End &gt;start, no later than finite parent end; exclusive | DF02; DB109; target selected |


#### 9.3 Expected business relationships

| Relationship | Expected business meaning | Evidence limit |
| --- | --- | --- |
| Employee → Company | Each employment belongs to one company; a company has many employees. | Expected target; source relationship unverified. |
| Employee → Department/Designation/Location/Grade | An employee has dated primary classifications; each classification can apply to many employees. | Grid/filter evidence only; history/cardinality unverified. |
| Employee → Manager | A dated reporting relationship connects an employee to an eligible manager; no self relation or reporting cycle in proposed target. | Manager maintenance menus; actual mapping unverified. |
| Employee → Attendance | An employee has date-based attendance results and traceable amendments; revision handling requires owner confirmation. | Attendance screen observed; storage unverified. |
| Employee → Leave Request/Balance | Requests belong to one employee and leave type; balances relate to a defined cycle and accountable movements. | Menu/policy evidence; request and ledger unverified. |
| Employee → Salary/Payroll | Salary arrangements have effective dates; period payroll record belongs to one employee and reviewed period. | Salary list/controller evidence; persistence/calculation unverified. |
| User ↔ Role ↔ Permission | Users may have several scoped role assignments; a role permits several business actions; assignment scope controls data visibility. | Proposed target; source permission data unverified. |
| User → Employee | Own access refers to an unambiguous employee employment; separate organisation employments remain separately scoped. | Proposed target; source linkage unverified. |
| Approval → Transaction → Decision | One reviewed transaction has a defined approval journey; each stage has assigned authority and retained decisions. | Approval menus; execution/linkage unverified. |
| Requisition → Candidate Application → Offer → Employee | Hiring target preserves the application and accepted-offer origin of an employee; no repeated conversion. | Hiring menus; New form unreachable. |
| Employee → Appraisal → Goals/Ratings | A cycle appraisal belongs to the employee; distinct reviewer stages retain ratings and decisions. | Config explanatory text; live data unverified. |
| Project → Job → Activity → Resource/Timesheet | Work entries use approved job/project/activity assignment for employee and date. | Allocation list/menu evidence; entry links unverified. |
| Training Plan → Participant → Feedback | Plan has expected participants; feedback relates to that participation. | Plan screen/menu evidence; actual records absent. |
| Employee → Exit → Settlement | A leaving employment has reviewed exit information and traceable settlement, distinct from confirmed payment. | Settlement filters/control evidence; records unverified. |
| Expense Claim → Revision → Lines | Claim belongs to one employee; submitted corrections retain versions, and each version has one or more lines. | Requested target extension. |
| Expense Line → Category/Policy/Receipts | Each submitted line uses controlled category and dated policy; receipt links inherit claim access. | Requested target extension. |
| Expense Policy → Eligible Grade/Location/Department | Eligible classifications are controlled business references; intersect applicable restrictions and prevent ambiguous policy matches. | Requested target extension. |
| Expense Revision → Approval → Line Decisions | Submitted version owns its approval journey; final decisions concern only its own lines and authorised reviewers. | Requested target extension. |
| Approved Expense → Payment Obligation → Payment Evidence | One approved entitlement has one live route; history includes confirmations and reversals without duplicate entitlement. | Requested target extension. |
| Specialist Reimbursement ↔ Expense | If a compatibility view links the same expense, it does not create a separate approval, input or payment obligation. Standalone specialist claims remain separately identifiable. | Requested target; source coexistence rules pending. |
| Report → Eligible Business Records | Output is based on defined period, scope and record states; totals and dashboard counts reconcile to those records. | Visible outputs by menu/control; underlying data unverified. |


#### 9.4 Data assurance checks and evidence status

| Check | Validation activity | Current evidence status |
| --- | --- | --- |
| DQ-01 Entity to screen | Match each important screen to its expected business record and record owner. | Business mapping documented; underlying entity mapping unverified. |
| DQ-02 Field meaning | Match employee code, dates, amounts, classifications and status labels to the correct stored or calculated business element. | Visible labels documented; underlying mapping unverified. |
| DQ-03 Mandatory consistency | Compare visible required markers and entry rules to required stored-value versus optional-value expectations; actual source nullability must be confirmed. | Entry required markers incomplete; underlying required-data rules unverified. |
| DQ-04 Type and format | Validate business dates, durations, whole-number counts, currency decimals, flags and coded states. | Expected formats documented; actual storage and precision unverified. |
| DQ-05 Reference data | Confirm controlled selections have approved code lists and valid company/date applicability. | Dropdown/filter presence observed; reference records and constraints unverified. |
| DQ-06 Relationships | Confirm employee-company-manager, leave-employee, approval-transaction and expense-payment ownership links. | Expected relations documented; source relational integrity unverified. |
| DQ-07 Status lifecycle | Map every visible view label to eligibility and allowed transitions; distinguish view facets from stored state. | Labels partially observed; source state mappings unverified. |
| DQ-08 Auditability | Confirm required actor/time/reason and earlier values remain available for important changes/decisions. | Last login/amendment/audit entry points visible; actual change records unverified. |
| DQ-09 Active archive deletion | Determine whether disappearance follows filter, active state, archive or deletion; preserve history as required. | Active/status labels observed; actual deletion/archive behaviour unverified. |
| DQ-10 Duplicate prevention | Confirm employee-code scope, copied requisition identity and claim/payment duplicate handling with approved examples. | Proposed expectations documented; source uniqueness unverified. |
| DQ-11 Calculation source | Classify balances/totals as captured, derived or aggregated with approved business definitions. | Visible values documented; formulas/source mode unverified except labels. |
| DQ-12 Reporting reconciliation | For same date/period/scope/filter, compare report totals and dashboard counts with eligible business records. | No output-to-record reconciliation executed. |
| DQ-13 Historical preservation | Validate employment, salary, policy and submitted expense revisions at historical effective dates. | Proposed history requirements; actual source preservation unverified. |
| DQ-14 Role data visibility | Use separate role walkthroughs to compare visible records, fields and outputs with approved role scope. | Administrator only; other-role data visibility unverified. |
| DQ-15 Integration categories | Confirm only the business data category exchanged, its owner and successful/failed outcome handling. | Generic function/menu evidence; exchange execution unverified. |


Data validation requires approved examples or a suitably anonymised source record-definition and relationship review. The checklist is not a claim that a source constraint exists or that a test has passed. Record the reviewer, evidence, result and unresolved decision for each check before asserting source parity. Business entities and relations above intentionally avoid physical database names and internal technical schemas.

#### 9.5 Additional requested entity and data checks

| Business entity | Target screens and parent relation | Required data assurance |
| --- | --- | --- |
| Confirmation policy and employee review | Confirmation Policies -&gt; employee_confirmation -&gt; confirmation_action | Pinned policy, same employee/company, required decision fields, due/actual distinction and non-overlapping assignment. |
| Notification rule event and delivery | Notification Rules/Templates -&gt; notification_event -&gt; notification -&gt; notification_delivery_attempt | Committed source event, allowed recipients/placeholders, idempotency, preference and scope across all channels. |
| Biometric profile mapping and runs | API Profile -&gt; mapping_revision/field_mapping/employee_link -&gt; sync_run -&gt; ingest_event -&gt; attendance_punch | Version consistency, company identity, event-key replay checks, cursor atomicity, quarantine counts and time normalisation. |
| Increment cycle plan case and history | Increment Cycles -&gt; employee_increment_plan -&gt; increment_case/components -&gt; increment_history -&gt; salary_arrangement | Company/employee/basis/currency identity, independent decision, unique application, effective dates and yearly reconciliation. |


Apply DQ01 to DQ15 to all new entities and screens. Source storage, role access and provider contracts remain unverified. New target fields above are requested design definitions, not assertions about source nullability.

#### 9.1 Payroll and ESS data extension

Appendix H5 adds DB110–DB118 and 27 explicit business references, in addition to the 109-table/201-reference baseline. Combined proposed inventory is 118 tables and 228 explicit business references, plus shared company and actor references. CI25–CI30 govern extension integrity.

### 10 User and process flows

Observed journeys below contain only read-only steps supported by the evidence register. Proposed business journeys are separately labelled. No approval, save, send, upload, deletion, calculation or payment journey was executed.

#### Observed login and home

Start: login screen → enter authorised sign-in details → successful Administrator role home observed → inspect home areas. Decision: recovery entry is visible but not tested. End: home area observed; sign-out/session expiry behaviour unverified.

Evidence: E01

#### Observed employee review

Start: Employee Master → inspect company/status/search/date controls → inspect available status views and displayed columns → review paging/export controls. Decision: no matching record is a list result, not proof of absence. End: employee list view; export contents not validated.

Evidence: E02/E03

#### Observed attendance review

Start: Attendance Control → inspect organisation/employee/date and other filters → inspect policy and amendment-log entry points. Decision: selected filter criteria determine intended review scope; actions not executed. End: read-only attendance review screen.

Evidence: E07

#### Observed salary-related review

Start: Employee Salary Master or Payroll Controller → inspect company/period/classification filters → inspect salary values and output controls. Decision: processing requires separate unreviewed authority. End: read-only salary/payroll view; no calculation or payment.

Evidence: E08/E09

#### Observed report entry review

Start: report/menu or export control → identify report label and business purpose → record intended output and missing layout evidence. Decision: changing/sending action not completed. End: documented output entry point, not validated downloaded report.

Evidence: E17 and visible export controls

#### Observed hiring entry limitation

Start: Talent Acquisition list → inspect search/New/copy → open New → application error. Decision: entry form unavailable. End: Not reachable form in Appendix A; no requisition created.

Evidence: E10

#### Proposed leave review

Start: employee submits eligible dated request → validate policy/balance → assigned reviewer decides. Decision: return retains request history; reject creates no approved consumption; approval applies owner-confirmed balance rule. End: approved/rejected/returned request. Cancellation and balance effects pending owner confirmation.

Evidence: Menu only; target design

#### Proposed expense journey

Start: employee draft with lines/receipts → submit validations → assigned manager review → independent finance review. Decision: return creates correction journey; reject yields no payment; permitted line reductions need reasons. End: approved entitlement or rejected/cancelled claim.

Evidence: Requested extension

#### Proposed expense payment journey

Start: approved claim → one eligible route queued → independent payment review → confirmed outcome. Decision: failed/unknown retains traceable obligation and blocks duplicate route; partial/reversal updates outstanding amount. End: paid, outstanding, unknown or reversed payment outcome, separate from claim decision.

Evidence: Requested extension

#### 10.1 Requested target user journeys

| Journey | Start steps and decisions | End state |
| --- | --- | --- |
| Employee confirmation | Assign approved policy -&gt; compute planned due date -&gt; remind eligible reviewer -&gt; confirm or extend with reason -&gt; independent decision. Missing/ambiguous policy or reviewer blocks action. | Confirmed with actual date/history, or extended with new due date; no date-only auto-confirmation. |
| Event/request notification | Committed event or eligible yearly occurrence -&gt; select approved versioned rule -&gt; privacy/scope filters -&gt; create logical notification -&gt; deliver -&gt; bounded retry/failure. | Delivered evidence or visible failure; no duplicate logical alert and no wrong-state message. |
| Biometric fetch | Configure restricted profile -&gt; validate mapping and employee links -&gt; activate -&gt; scheduled/manual range -&gt; fetch all pages -&gt; validate/quarantine/deduplicate -&gt; commit checkpoint -&gt; attendance processing. | Reconciled run with accepted punches and visible exceptions; failed run recoverable without duplicate or false absence. |
| Increment cycle | Configure approved cycle -&gt; assign eligible employees -&gt; due roster -&gt; snapshot salary basis -&gt; proposal -&gt; independent review -&gt; approve/no-change/defer/reject -&gt; apply effective salary/history -&gt; eligible payroll. | Applied revision and next due date, or non-financial terminal decision with no salary change. |
| Annual history review | Select employee/year/basis/currency -&gt; reconstruct opening/closing approved salary -&gt; show events/percentages -&gt; reconcile -&gt; permitted export. | Comparable annual growth and individual changes, or N/A reason; protected values not exposed. |


#### Proposed team and dashboard journeys

Manager opens My Team → current reporting links are evaluated → searches/filters permitted members → selects a member → authorization resolves each tab and field → views permitted information → permitted export repeats checks. If the employee is reassigned, later requests lose former-team access; history is preserved.

User signs in → selects an active role assignment → sees labelled dashboard and scope → reads authorised metrics/tasks → follows a permitted drilldown or action → source screen repeats authorization and workflow validation. A denied or expired role ends in a neutral no-access state, not fallback to a broader role.

#### 10.1 Payroll and ESS journeys

H2 defines processed payroll, hold, bank output, payment outcome and later-period timesheet correction journeys. H4 defines own-record sensitive-change and document journeys, including conflicts, returns, quarantine and approved application.

### 11 Reports and outputs

Report/menu and control names are recorded as business outputs. A visible Export, Send or Print control does not establish the generated layout, delivered recipient or successful output. Each output needs confirmed columns, eligible record states, period/filter semantics and owner-approved samples before implementation parity can be accepted.

| Output family | Visible or proposed output | Business purpose | Evidence |
| --- | --- | --- | --- |
| Home areas and notifications | Pending Approvals, My Submitted Request, Alerts, Recruitment Alerts; ticker/event/alert menu functions. | Identify tasks and communicate relevant workforce events. | Home labels observed; notice generation/delivery untested. |
| Employee lists and exports | Employee, family, qualification, prior employer, branch, grade and employee-history outputs. | Review employee classifications and supporting information. | List/export controls observed; output fields/layout pending. |
| Attendance and leave outputs | Shift punch, attendance register, shift plan/deviation, absconding/audit, attendance dashboard, wage register and mapped leave-policy export. | Review attendance classifications, scheduling exceptions and policy coverage. | Menus/controls observed; values and formulas unverified. |
| Salary and payroll outputs | Salary/annual export, pay/arrear/TDS registers, salary disbursement, reimbursement register, salary progression/comparison and salary journal. | Review employee entitlements, deductions, payment preparation and financial totals. | Menu/control evidence; reconciliation and exact format pending. |
| Tax and compliance outputs | Named tax forms/certificates, provident-fund/social-insurance/professional-tax/labour-welfare registers and remittance outputs. | Support applicable statutory review and submissions. | Labels only where noted; jurisdiction, form naming and period rules pending. |
| Appraisal outputs | Appraisal report, review views and bell curve. | Review ratings and assessment distribution within authorised population. | Config/menu evidence; score/bin definitions and visibility pending. |
| Timesheet and training outputs | TMS reports; training plan export; training feedback register. | Review work allocation/time and training participation/feedback. | Allocation/plan controls and menus observed; totals pending. |
| Separation letters and settlement outputs | Relieving/experience letters; settlement PDF/Excel send and ZIP export; uploaded settlement list. | Support leaving-employee communication and settlement review. | Controls observed; send/print/download content not executed. |
| Analytics and audit | Attrition register/summary, employee history, document compliance, employee/transaction/field-level audit outputs. | Review workforce changes, document completeness and attributable activity. | Menus observed; formulas/change record fields unverified. |
| Expense extension outputs | Claim/line register, approval ageing, category spend, payable ageing, payment reconciliation and claim-outcome notices. | Track employee spend, reviewer workload and approved amounts through payment. | Requested target; no dedicated source output verified. |


#### 11.1 Totals and KPI validation

| Displayed or proposed value | Business source question | Required comparison |
| --- | --- | --- |
| Employee and shift counts | Which active/effective employees and assignments are included? | Count equals eligible records with the same company/date/status filters. |
| Attendance days and duration summaries | Which daily classifications, shifts, breaks and amendments contribute? | Summary reconciles approved daily records; threshold examples must be signed. |
| Leave balance and available units | Captured opening amount, movements and pending reservations? | Same cycle/date/type comparison; cancellation and pending effect explicitly approved. |
| Annual cost gross estimated in-hand | Captured versus calculated values; earning/deduction inclusions? | Owner-approved salary and period examples; estimates distinguished from confirmed payment. |
| Appraisal scores and bell-curve distribution | Weights, eligible reviewers and eligible population? | Score fixture and count distribution reconcile; no invented formula. |
| Attrition and document compliance | Eligible exits/headcount and required-doc population? | Owner-approved numerator/denominator and zero-denominator result. |
| Expense payable and paid totals | Approved line decisions, confirmed payments and approved reversals. | Proposed approved amount equals net confirmed paid plus outstanding for same currency and period. |


#### 11.2 Requested reports and notifications

| Output | Business purpose and reconciliation | Access |
| --- | --- | --- |
| Confirmation due and history | Upcoming/due/overdue/extended/confirmed filtered list; planned versus actual dates and decisions. | Scoped HR/reviewer; employee own approved view. |
| Birthdays and work anniversaries | Eligible dates/celebration messages with privacy preferences; no public DOB/year/age. | Owner-approved scoped audience only. |
| Request and decision notifications | Leave applied/approved/rejected/returned/cancelled/amended; confirmation/increment decisions; approval reminders and document expiry. | Claimant/assigned authorised recipients and allowed field groups. |
| Notification delivery log | Event, recipient/channel, attempt count, outcome and failure; no secrets or unneeded private message payload. | Restricted notification/support authority. |
| Biometric sync and exception report | Source observation count, unique/duplicate/accepted/quarantined/rejected outcomes, range, mapping revision and failure. | Restricted integration administrator; attendance reviewer sees permitted business results. |
| Increment cycle and history reports | Due/eligible/excluded/no-change/approved/applied list; before/after amount, per-change percent and annual growth on same basis/currency. | Salary history grant plus row scope; manager status alone insufficient. |


#### Proposed role outputs

My Team lists and role dashboards support workforce review and prioritisation of authorised tasks. Output catalogue includes scoped team lists, operational counts, pending task lists and permitted employee history. Sensitive amounts, percentages and derived confidential metrics require eligible Admin/Manager access. Exports, scheduled outputs and notifications preserve the same filters and permissions. These are target requirements, not new observed outputs.

#### 11.1 Payroll and ESS outputs

H7 defines bank files, held salary liability, adjustment reconciliation, ESS issued documents and approval notifications. Outputs retain source period, processing revision, scope, publication state and authorized recipients.

### 12 Non functional requirements

Only visible or recorded non-functional observations are included here. No response-time target, availability commitment, encryption control, recovery target, session timeout, accessibility conformance or authentication policy is asserted. Those require confirmation and are listed in Section 14.

| Observation | Evidence | Limit |
| --- | --- | --- |
| List navigation | Employee and User Rights lists expose filters and paging. | Keyboard behaviour, screen-reader operation and usability completion times were not tested. |
| Search and output controls | Search/export controls are visible on several reviewed lists. | No measured response-time or large-volume behaviour evidence. |
| Colour indicator | Leave policy mapping uses pink to indicate unmapped policies. | A equivalent text indicator or colour-independent accessibility behaviour was not verified. |
| Empty views | Training Plan and Process Master displayed no records in reviewed views. | No conclusion about record population or data availability outside selected filters. |
| Application error | Talent Acquisition New returned an internal error. | Cause, frequency and recovery behaviour unverified. |
| Attribution entry points | Last login display, amendment-log control and audit menu labels were visible. | Actor/time fields and retained history were not inspected. |
| Session behaviour | A later revisit reached the login screen. | This does not prove a timeout duration or cause; session-expiry rules unconfirmed. |


#### 12.1 Requested capacity and resilience targets

The user requests support for 10 million users at the same time. The target is 10,000,000 distinct users concurrently authenticated and actively issuing HRMS requests, not merely stored accounts. Ten million is confirmed as the requested user-count target; request rate, role mix, data distribution and latency assumptions below are selected initial sizing baselines and must be checked against actual journeys. This section describes new-system requirements, not observed reference performance. Appendix G defines architecture deliverables and objective proof. Merely storing sessions or extrapolating a small test does not satisfy the target.

| Requirement | Priority | Target behavior | Testable acceptance |
| --- | --- | --- | --- |
| NFR-S01 Concurrent capacity | Must | Maintain 10,000,000 distinct active user contexts at 1,000,000 offered business requests/second for 2 hours; keep all 14 roles and scope checks active. | Count unique authenticated identities, offered/received/completed requests and successful business responses. Meet S03 latency and &lt;=0.05% unexpected errors; legitimate scripted actions cannot be silently omitted. |
| NFR-S02 Peak activity | Must | At the same 10,000,000 users, serve 1,500,000 offered requests/second for 15 minutes after nominal load, without corrupting requests or broadening permissions. | Same latency/error thresholds as S03, no lost acknowledged writes and no growing unbounded queues. After burst, queues return to nominal levels within 15 minutes. |
| NFR-S03 Latency and error measurement | Must | For valid foreground work, measure edge-to-response read p95 &lt;=1 second/p99 &lt;=3 seconds and mutation p95 &lt;=2 seconds/p99 &lt;=5 seconds; dashboard browser p95 &lt;=5 seconds in separately measured regional browser cohorts. | Thresholds hold by operation and serving region, not only aggregate average. Include authorization, cache misses, database and queue-admission time; report network assumptions. Unexpected timeout/5xx/throttle/non-response &lt;=0.05% of offered valid requests; dropped requests count as failures. |
| NFR-S04 Authentication scale | Must | Authenticate 10,000,000 distinct users over 10 minutes, provision 20,000 completed login flows/second capacity including required MFA dependencies, and preserve correct expiry/revocation. | Use distinct identities and real protected authorization checks in test. No accepted expired/revoked/cross-company grant; external identity/MFA quota and latency are measured. Do not substitute token reuse for authentication-storm proof. |
| NFR-S05 Independent scaling and bounded resources | Must | Scale request handlers, authorization/session services, data partitions and background workers independently with explicit admission limits and sufficient tested headroom. | No one-connection-per-user design; report measured per-unit limits, pool bounds, connection counts, queue ages, throttles and scaling times. Critical workflows retain integrity under overload; autoscaling alarms alone do not constitute capacity. |
| NFR-S06 Data growth and distribution | Must | Test with 50,000,000 registered synthetic accounts, 10,000,000 concurrent user contexts, 10,000 companies and representative employee, historical and transaction data. | Declared G2 history/tenant skew fixtures are present; indexes, retention, paging and partitioning are exercised. Reconcile scoped list/report values and parent-child relationships at full dataset size. |
| NFR-S07 Resilience and recovery | Must | Target 99.95% monthly availability for critical login, scoped viewing and request/decision services; validate one-zone failure at nominal traffic and regional recovery within 15 minutes. | RPO is zero for acknowledged financial/approval/audit writes through supported failover; other reconstructible data RPO &lt;=5 minutes. Test restore/failover and immutable outcome reconciliation. 99.95% is a selected objective, not an existing SLA or guarantee. |
| NFR-S08 Confidentiality under caches and failure | Must | Retain Admin/Manager field eligibility, DB109 assignment narrowing, company/team scope and actor separation during cache use, partition movement, failover and load shedding. | Pass ZT01–ZT05/29/30 while nominal/peak load runs. Authorization uncertainty denies protected work; replica lag cannot permit stale grants or stale approval decisions. |
| NFR-S09 Background work isolation | Must | Run payroll, reports, exports, notification fan-out, biometric ingestion and file scans on bounded asynchronous workers separated from foreground request capacity. | Concurrent scheduled jobs do not break S03; enqueue/execute state is explicit, retries bounded and idempotent, downloads reauthorize. No synchronous all-user loop, unbounded thread or fan-out on an interactive request. |
| NFR-S10 Scope-safe refresh and quotas | Must | Use jitter/coalescing, hidden-tab suspension and bounded updates for dashboards, with fair company/user admission controls. | A ten-million-view synchronized refresh scenario is tested. At nominal target, legitimate selected journeys meet S03 without hidden quota rejection; above declared safe capacity, explicit retryable throttles preserve correctness and isolation. |
| NFR-S11 Evidence and monitoring | Must | Collect offered traffic, latency histograms, outcome counts, saturation, locks, replica lag, session/auth state, worker queue age and isolation-test results per region/cell/role/operation. | Observe every serving unit; metrics/logs contain no credentials or confidential payload. Measure generator health and coordinated-omission risk; retain versions, configuration, dataset and test scripts alongside results. |
| NFR-S12 Capacity economics and rollout | Must | Provide measured topology, dependency quotas, capacity model, contingency capacity, running cost and load-test cost estimates, plus staged migration/rollback plan. | Senior developer, platform lead and QA review the evidence; sponsor reviews the concrete resource/cost plan before infrastructure procurement. No invented server count, price or passed 10-million-user claim. |


### 13 Integrations

Integration descriptions are business-function categories only. Menu names may suggest an exchange but do not prove that a connection exists, which party provides it or how it works. No technical destination, connection detail or endpoint is included.

| Business function | Data category and purpose | Evidence and question |
| --- | --- | --- |
| External attendance device | Employee-linked punch times for attendance review. | Biometric/import labels observed; provider, matching, frequency and error handling unconfirmed. |
| File import and export | Employee, salary, leave, investment, claim, training or settlement data in controlled business files. | Upload/export labels observed; templates, required fields and processing limits pending. |
| Notification or correspondence service | Task/status notices and generated employee letters to approved recipients. | Send Mail and PDF/Excel send controls visible; delivery mechanism and recipient rules unconfirmed. |
| Mobile attendance service | Employee device association and attendance-related categories. | Mobile linking label observed; full mobile journey and captured information unverified. |
| Payment provider or financial file exchange | Approved employee/payroll/settlement/expense payment instructions and outcome evidence. | Disbursement/remittance outputs visible by name; direct exchange unverified; expense integration proposed. |
| Accounting output | Approved payroll or expense financial classifications and journal totals. | Salary journal label observed; automated posting unconfirmed. |
| Statutory reporting exchange | Applicable payroll deduction and remittance categories. | Named registers/challan outputs visible; direct submission integration unconfirmed. |


#### 13.1 Requested biometric and notification integration capabilities

Biometric attendance API ingestion is now requested target scope, with configurable restricted provider/request/authentication settings and versioned field paths. Business data categories: device employee identity, punch instant, direction, stable event key and optional device identifier; no biometric fingerprint/face templates are required or stored by this feature. Notification service categories include in-application and owner-approved external channels; actual supported channels/provider contract and request limits are pending. No provider addresses, endpoints, credentials or deployed database names are included here.

#### 13.2 Selected target activation boundary

DF09/12/13 define target attendance and notification exchange behavior. Actual provider contracts stay in restricted configuration. Direct payment, statutory submission and automated accounting posting require real interface/rate inputs and successful tests before activation; this document contains no connection details.

#### 13.1 Bank format integration boundary

Bank template business mapping, accepted file specification and independently validated sample are required before activating bank output. File generation does not transfer money. Actual bank/payment responses and acknowledgment semantics remain restricted integration inputs, with no connection values in this BRD.

### 14 Open questions assumptions and risks

Additional build decisions: business owners must approve Appendix B schema extensions, Appendix C grants and states, and Appendix D release gates. Unknown source behaviour stays unknown; no proposed relationship is a verified source FK.

Questions below are retained as discovery traceability. Appendix F resolves target behavior, configuration requirements and phasing for every OQ item. Actual source parity and external inputs remain unverified. Earlier references to pending target decisions do not reopen decisions explicitly selected in Appendix F.

| Question | Owner | Historical question and current target disposition |
| --- | --- | --- |
| OQ-01 Scope completeness | Business sponsor/HR | Which recorded menus are in the first delivery, and which extra help/profile/header/footer/quick-action items remain undiscovered? Complete a further read-only walkthrough to resolve coverage gaps. Target disposition: selected business behavior/configuration boundary in DF01. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-02 Role catalogue and access | HR/application owner | Provide role-specific walkthroughs and an approved view/action/field/export scope matrix. Confirm delegation, reviewer mapping and prohibited combined duties. Target disposition: selected business behavior/configuration boundary in DF02, DF03. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-03 Employee data and status | HR | Confirm mandatory fields, formats/defaults, employee-code uniqueness scope, employee types and status-facet definitions/transitions. Target disposition: selected business behavior/configuration boundary in DF04. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-04 Hiring entry | Hiring owner | Provide an accessible Talent Acquisition New form; confirm budget, candidate stages, entry rules and approval route. Target disposition: selected business behavior/configuration boundary in DF04, DF01. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-05 Attendance and shift rules | HR/Payroll | Confirm duration units, overnight dates, breaks, missing punches, boundary inclusivity, grace/reset, overtime and processing schedule. Target disposition: selected business behavior/configuration boundary in DF05. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-06 Leave rules | HR/Payroll | Confirm eligibility mappings, accrual, carry/expiry, fractions, reservation, cancellation and holiday/outdoor effects. Target disposition: selected business behavior/configuration boundary in DF03, DF05. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-07 Salary calculation | Payroll/Finance | Provide signed examples for gross, annual cost, estimated in-hand, paid-day denominator, proration, arrears, loans and contributions. Target disposition: selected business behavior/configuration boundary in DF05. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-08 Tax and statutory outputs | Payroll owner | Confirm jurisdiction/period rules and rates, form names, certificate applicability and sample output layouts. Target disposition: selected business behavior/configuration boundary in DF05, DF18. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-09 Payroll lock release and stop | Payroll approver | Confirm stored and displayed states, approval/reopen authority, stop modes, disbursement ownership and payment evidence. Target disposition: selected business behavior/configuration boundary in DF03, DF05, DF07. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-10 Appraisal rules | HR/managers | Confirm visibility values, reviewer mapping, weights, upload-mode interpretation, formula/manual calculations and return behaviour. Target disposition: selected business behavior/configuration boundary in DF04, DF18. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-11 Timesheet rules | Operations | Confirm required fields, period/hour caps, allocation capacity, utilisation definition and any payroll or billing effect. Target disposition: selected business behavior/configuration boundary in DF04, DF18. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-12 Training and separation | HR | Confirm participant/feedback fields, training status boundaries, exit/clearance/notice/benefit rules and settlement state meaning. Target disposition: selected business behavior/configuration boundary in DF04, DF05, DF18. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-13 Import output and correspondence | Module owners | Provide required templates, validation and partial-processing rules, output columns, recipients and scheduling expectations. Target disposition: selected business behavior/configuration boundary in DF09, DF12. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-14 Unconfirmed non-functional targets | Business/application owner | Confirm access/session policies, usability/accessibility goals, capacity, performance, recovery and availability needs; none asserted as observed. Target disposition: selected business behavior/configuration boundary in DF10. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-15 Integration behaviour | Business owners | Confirm external business parties, exchanged data categories, responsibility, frequency, exceptions and reconciliation; omit technical connection details from this BRD. Target disposition: selected business behavior/configuration boundary in DF09, DF13. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-16 Expense policy and approvals | HR/Finance | Approve category eligibility, date/submission limits, receipts, exceptions, partial decisions, threshold route, independent roles and support access. Target disposition: selected business behavior/configuration boundary in DF03, DF06. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-17 Expense currency and accounting | Finance | Approve supported currencies, conversion basis, precision/rounding, reimbursement treatment, direct/payroll route and reversal/reconciliation examples. Target disposition: selected business behavior/configuration boundary in DF07. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-18 Data behaviour and history | Data owner/senior developer | Confirm actual entity/field relationships, required-record conditions, controlled code lists, duplicate constraints, active/archive/delete behaviour and retained history. Target disposition: selected business behavior/configuration boundary in DF04, DF08. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-19 Underlying data evidence | Data owner/QA | Complete DQ-01 to DQ-15 using anonymised record definitions and approved reconciliation examples; no direct source validation has been performed. Target disposition: selected business behavior/configuration boundary in DF08, DF18. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-20 Acceptance and zero tolerance gates | Delivery owner/QA | Approve fixed positive, negative, boundary and concurrent test examples. A failed approved isolation/self-approval/duplicate-payment/reconciliation condition blocks affected release. Target disposition: selected business behavior/configuration boundary in DF10. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-21 Confirmation policy parameters | HR | Approve default/applicability precedence, day/month inclusivity and month-end rule, start basis, override/extension/early-confirmation permissions, status transitions and reminder recipients/lead times. Target disposition: selected business behavior/configuration boundary in DF11. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-22 Notification and privacy policy | HR/access/business owners | Approve event catalogue, channels, recipient scopes, celebration consent/publication, mandatory alerts, leap-day/service anniversary rules, templates, business timezone, lead times and bounded retries. Target disposition: selected business behavior/configuration boundary in DF12. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-23 Biometric provider contract | Integration/HR/data owners | Provide restricted provider schema/auth/request/pagination details outside shared BRD; approve supported mapping paths/transforms, timezone/DST, event key fallback, limits/lookback/checkpoints, late-punch and quarantine reprocessing rules. Target disposition: selected business behavior/configuration boundary in DF09, DF13. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-24 Increment history basis | Payroll/Finance/HR | Approve comparable salary basis, annual calendar/financial/report period boundaries, opening/closing as-of convention, percent precision/rounding, non-comparability and correction/decrease cases; supply synthetic expected examples. Target disposition: selected business behavior/configuration boundary in DF14. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ-25 Employee increment cycles | HR/Payroll | Approve annual/common-date/anniversary schedule, recurrence, eligibility/cutoff, confirmation/appraisal linkage, overrides/off-cycle approval, proposal/final financial duties, effective date and locked-payroll arrears/reopen treatment. Target disposition: selected business behavior/configuration boundary in DF15. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ26 My Team catalogue | HR and access owner | Approve direct/indirect reporting depth, inactive and historical membership, delegation and every detail category/field. Target disposition: selected business behavior/configuration boundary in DF16. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ27 Confidential policy impact | Sponsor, HR, payroll, finance and access owner | Approve classified fields/documents/aggregates and workflow reassignment or redaction for employee, payroll, finance, treasury and other ineligible roles. Latest restriction is already requested; implementation choices remain pending. Target disposition: selected business behavior/configuration boundary in DF02, DF18. Source evidence remains unverified; external-input dependencies are recorded in F4. |
| OQ28 Dashboard definitions | Each role owner and reporting owner | Approve per-role layout, metric formula, filters, period, refresh behavior, empty states and permitted quick actions; no performance target presumed. Target disposition: selected business behavior/configuration boundary in DF17. Source evidence remains unverified; external-input dependencies are recorded in F4. |


#### 14.1 Assumptions and risks

| Type | Statement | Resolution |
| --- | --- | --- |
| Assumption | The recorded Administrator-visible labels identify discovery scope, not verified feature completion. | Validate each proposed requirement and obtain additional walkthrough evidence. |
| Assumption | Expense approval is a requested extension, not a verified dedicated source module. | Approve its target field, policy, route and output examples. |
| Risk | Only one role was reviewed; data visibility may differ materially for other roles. | Role-specific walkthrough and negative access testing before source-parity acceptance. |
| Risk | Menu-only features and unreachable forms can hide mandatory fields and rules. | Keep evidence limits visible; no source-behaviour sign-off until owner confirmation. |
| Risk | Actual stored types, relationships, constraints and calculations were not inspected. | Complete data checks and reconciliation; developer shall not infer source constraints from the target business model. |
| Risk | Recorded navigation may omit lower-level sections, tabs, accordions or links. | Further read-only exhaustive coverage review; add every discovered item with an allowed status. |
| Risk | Financial and status rules are unresolved. | Signed examples required before dependent calculation/approval/payment release. |
| Release condition | Zero tolerance is an acceptance gate, not a defect-free certification. | Record evidence and results; release affected scope only after all mandatory approved tests pass. |


### Appendix A Coverage Log

This log covers the recorded visible inventory, including menu leaves, reviewed controls and status views. Coverage is 100% of the recorded inventory represented here, not a claim of 100% of the current live application. Documented records a label and its known limitation; Restricted requires observed access denial; Not reachable identifies a destination that could not be opened. No other status is used. The earlier evidence has no confirmed access-denied destination, so there are no invented Restricted rows. Role-specific and undiscovered navigation gaps remain in Section 14.

#### Master and organisation setup

| Entry and hierarchy | Status and evidence | Documented coverage and limitation |
| --- | --- | --- |
| CL-001<br>Master and organisation setup / Org Set Up → Company → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-002<br>Master and organisation setup / Org Set Up → Department → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-003<br>Master and organisation setup / Org Set Up → Designation → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-004<br>Master and organisation setup / Org Set Up → Entity Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-005<br>Master and organisation setup / Org Set Up → Qualification Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-006<br>Master and organisation setup / Org Set Up → State Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-007<br>Master and organisation setup / Org Set Up → City Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-008<br>Master and organisation setup / Org Set Up → Shift Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E04 | Screen or area observations recorded in Section 4; write actions and detailed rules remain unverified unless expressly stated.<br>Requirements: FR-001 to FR-010 |
| CL-009<br>Master and organisation setup / Org Set Up → Holiday Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-010<br>Master and organisation setup / Org Set Up → Bank Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-011<br>Master and organisation setup / Org Set Up → My Account → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E01 | Screen or area observations recorded in Section 4; write actions and detailed rules remain unverified unless expressly stated.<br>Requirements: FR-001 to FR-010 |
| CL-012<br>Master and organisation setup → Employee Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E03 | Screen or area observations recorded in Section 4; write actions and detailed rules remain unverified unless expressly stated.<br>Requirements: FR-001 to FR-010 |
| CL-013<br>Master and organisation setup → Emp Master Upload → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-014<br>Master and organisation setup → Upload Employee Update → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-015<br>Master and organisation setup → Emp Master Changes → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-016<br>Master and organisation setup → User Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-017<br>Master and organisation setup → User Rights → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E16 | Screen or area observations recorded in Section 4; write actions and detailed rules remain unverified unless expressly stated.<br>Requirements: FR-001 to FR-010 |
| CL-018<br>Master and organisation setup → Attach new menu item → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-019<br>Master and organisation setup → Reporting Manager → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-020<br>Master and organisation setup → Upload Reporting Managers → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-021<br>Master and organisation setup → Event Planner → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-022<br>Master and organisation setup → Ticker Message → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-023<br>Master and organisation setup → Org Structure → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-024<br>Master and organisation setup → Alerts config → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-025<br>Master and organisation setup → Policy Upload → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-026<br>Master and organisation setup → Bulk Emp Docs upload → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-027<br>Master and organisation setup → Export Docs → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-028<br>Master and organisation setup → Upload Other Activities → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-001 to FR-010 |
| CL-166<br>Master and organisation setup → Employee Master → Company filter → Not exposed in reviewed evidence | Documented<br>E03 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-167<br>Master and organisation setup → Employee Master → Status filter → Not exposed in reviewed evidence | Documented<br>E03 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-168<br>Master and organisation setup → Employee Master → Search criteria and search text → Not exposed in reviewed evidence | Documented<br>E03 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-169<br>Master and organisation setup → Employee Master → Date filters → Not exposed in reviewed evidence | Documented<br>E03 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-170<br>Master and organisation setup → Employee Master → Pagination → Not exposed in reviewed evidence | Documented<br>E03 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-171<br>Master and organisation setup → Employee Master → Sortable list and counts → Not exposed in reviewed evidence | Documented<br>E03 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-172<br>Master and organisation setup → Employee Master → Employee export → Not exposed in reviewed evidence | Documented<br>E03 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-173<br>Master and organisation setup → Employee Master → Family export → Not exposed in reviewed evidence | Documented<br>E03 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-174<br>Master and organisation setup → Employee Master → Qualification export → Not exposed in reviewed evidence | Documented<br>E03 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-175<br>Master and organisation setup → Employee Master → Past employer export → Not exposed in reviewed evidence | Documented<br>E03 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-176<br>Master and organisation setup → Employee Master → Branch export → Not exposed in reviewed evidence | Documented<br>E03 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-177<br>Master and organisation setup → Employee Master → Grade export → Not exposed in reviewed evidence | Documented<br>E03 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-178<br>Master and organisation setup → Employee Master → Status views → Current | Documented<br>E03 | Status view label observed; lifecycle transition logic not verified.<br>Requirements: FR-001 to FR-010 |
| CL-179<br>Master and organisation setup → Employee Master → Status views → Offered Rejected | Documented<br>E03 | Status view label observed; lifecycle transition logic not verified.<br>Requirements: FR-001 to FR-010 |
| CL-180<br>Master and organisation setup → Employee Master → Status views → Offered | Documented<br>E03 | Status view label observed; lifecycle transition logic not verified.<br>Requirements: FR-001 to FR-010 |
| CL-181<br>Master and organisation setup → Employee Master → Status views → On Probation | Documented<br>E03 | Status view label observed; lifecycle transition logic not verified.<br>Requirements: FR-001 to FR-010 |
| CL-182<br>Master and organisation setup → Employee Master → Status views → On Notice | Documented<br>E03 | Status view label observed; lifecycle transition logic not verified.<br>Requirements: FR-001 to FR-010 |
| CL-183<br>Master and organisation setup → Employee Master → Status views → Left | Documented<br>E03 | Status view label observed; lifecycle transition logic not verified.<br>Requirements: FR-001 to FR-010 |
| CL-184<br>Master and organisation setup → Shift Master → Shift list and displayed fields → Not exposed in reviewed evidence | Documented<br>E04 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-251<br>Master and organisation setup → User Rights → Company filter → Not exposed in reviewed evidence | Documented<br>E16 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-252<br>Master and organisation setup → User Rights → Search on Role → Not exposed in reviewed evidence | Documented<br>E16 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-253<br>Master and organisation setup → User Rights → Search on Employee → Not exposed in reviewed evidence | Documented<br>E16 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-254<br>Master and organisation setup → User Rights → Search on User type → Not exposed in reviewed evidence | Documented<br>E16 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-255<br>Master and organisation setup → User Rights → Search on Active → Not exposed in reviewed evidence | Documented<br>E16 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-256<br>Master and organisation setup → User Rights → Search on Employee code → Not exposed in reviewed evidence | Documented<br>E16 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-257<br>Master and organisation setup → User Rights → Search on Login identifier → Not exposed in reviewed evidence | Documented<br>E16 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-258<br>Master and organisation setup → User Rights → Search text → Not exposed in reviewed evidence | Documented<br>E16 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |
| CL-259<br>Master and organisation setup → User Rights → Pagination → Not exposed in reviewed evidence | Documented<br>E16 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-001 to FR-010 |


#### Hiring

| Entry and hierarchy | Status and evidence | Documented coverage and limitation |
| --- | --- | --- |
| CL-029<br>Hiring / Masters → Vendor → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-011 to FR-014 |
| CL-030<br>Hiring → Manpower Budget → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-011 to FR-014 |
| CL-031<br>Hiring → Talent Register → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-011 to FR-014 |
| CL-032<br>Hiring → Search CV → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-011 to FR-014 |
| CL-033<br>Hiring → TR Tracker → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-011 to FR-014 |
| CL-034<br>Hiring → Talent Acquisition → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E10 | Screen or area observations recorded in Section 4; write actions and detailed rules remain unverified unless expressly stated.<br>Requirements: FR-011 to FR-014 |
| CL-035<br>Hiring → Talent Acquisition Approval → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-011 to FR-014 |
| CL-036<br>Hiring → HR View Talent Acquisitions → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-011 to FR-014 |
| CL-218<br>Hiring → Talent Acquisition → Search → Not exposed in reviewed evidence | Documented<br>E10 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-011 to FR-014 |
| CL-219<br>Hiring → Talent Acquisition → New → Not exposed in reviewed evidence | Not reachable<br>E10 | New was opened and returned an application error; the entry form, mandatory fields and validation could not be reviewed.<br>Requirements: FR-011 to FR-014 |
| CL-220<br>Hiring → Talent Acquisition → Copy existing → Not exposed in reviewed evidence | Documented<br>E10 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-011 to FR-014 |


#### ELC and Letters

| Entry and hierarchy | Status and evidence | Documented coverage and limitation |
| --- | --- | --- |
| CL-037<br>ELC and Letters → Letter Printing → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-015 to FR-018 |
| CL-038<br>ELC and Letters → Process Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E15 | Screen or area observations recorded in Section 4; write actions and detailed rules remain unverified unless expressly stated.<br>Requirements: FR-015 to FR-018 |
| CL-039<br>ELC and Letters → Employee Process Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-015 to FR-018 |
| CL-040<br>ELC and Letters → Exit Notes/Remarks/Warnings → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-015 to FR-018 |
| CL-041<br>ELC and Letters → Send Mail → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-015 to FR-018 |
| CL-042<br>ELC and Letters → Letter Designer → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-015 to FR-018 |
| CL-249<br>ELC and Letters → Process Master → New → Not exposed in reviewed evidence | Documented<br>E15 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-015 to FR-018 |
| CL-250<br>ELC and Letters → Process Master → Selection controls → Not exposed in reviewed evidence | Documented<br>E15 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-015 to FR-018 |


#### Attendance and leave

| Entry and hierarchy | Status and evidence | Documented coverage and limitation |
| --- | --- | --- |
| CL-043<br>Attendance and leave → Attendance Control → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E07 | Screen or area observations recorded in Section 4; write actions and detailed rules remain unverified unless expressly stated.<br>Requirements: FR-019 to FR-027 |
| CL-044<br>Attendance and leave / Capture Attendance → Biometric Upload → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-045<br>Attendance and leave / Capture Attendance → Import Attendance → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-046<br>Attendance and leave / Capture Attendance → Import In Out Time → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-047<br>Attendance and leave / Attendance Reports → Shift Punch Register → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-048<br>Attendance and leave / Attendance Reports → Attendance Register → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-049<br>Attendance and leave / Attendance Reports → Shift Plan Register → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-050<br>Attendance and leave / Attendance Reports → Shift Deviation Register → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-051<br>Attendance and leave / Attendance Reports → Absconding Report → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-052<br>Attendance and leave / Attendance Reports → Absconding Audit Report → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-053<br>Attendance and leave → Attendance Dashboard → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-054<br>Attendance and leave → Wage Register → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-055<br>Attendance and leave → Attendance Policy → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E05 | Screen or area observations recorded in Section 4; write actions and detailed rules remain unverified unless expressly stated.<br>Requirements: FR-019 to FR-027 |
| CL-056<br>Attendance and leave → Leave Policy Config → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E06 | Screen or area observations recorded in Section 4; write actions and detailed rules remain unverified unless expressly stated.<br>Requirements: FR-019 to FR-027 |
| CL-057<br>Attendance and leave → Employee Leave Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-058<br>Attendance and leave → Upload Opening Leave Balance → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-059<br>Attendance and leave → Mobile App Linking → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-060<br>Attendance and leave → Shift Planning Upload → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-061<br>Attendance and leave → HR View Leaves &amp; Outdoor → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-062<br>Attendance and leave → HR View Work On Holiday → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-063<br>Attendance and leave → EOD Utility → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-064<br>Attendance and leave → Run Eod → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-019 to FR-027 |
| CL-185<br>Attendance and leave → Attendance Policy → Grace and deduction settings → Not exposed in reviewed evidence | Documented<br>E05 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |
| CL-186<br>Attendance and leave → Attendance Policy → Attendance duration thresholds → Not exposed in reviewed evidence | Documented<br>E05 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |
| CL-187<br>Attendance and leave → Attendance Policy → Overtime settings → Not exposed in reviewed evidence | Documented<br>E05 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |
| CL-188<br>Attendance and leave → Attendance Policy → Effective from settings → Not exposed in reviewed evidence | Documented<br>E05 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |
| CL-189<br>Attendance and leave → Leave Policy Config → Company filter → Not exposed in reviewed evidence | Documented<br>E06 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |
| CL-190<br>Attendance and leave → Leave Policy Config → Leave type filter → Not exposed in reviewed evidence | Documented<br>E06 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |
| CL-191<br>Attendance and leave → Leave Policy Config → Effective from filter → Not exposed in reviewed evidence | Documented<br>E06 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |
| CL-192<br>Attendance and leave → Leave Policy Config → Grade and location mapping → Not exposed in reviewed evidence | Documented<br>E06 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |
| CL-193<br>Attendance and leave → Leave Policy Config → Unmapped policy colour indication → Not exposed in reviewed evidence | Documented<br>E06 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |
| CL-194<br>Attendance and leave → Leave Policy Config → Mapped policy export → Not exposed in reviewed evidence | Documented<br>E06 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |
| CL-195<br>Attendance and leave → Attendance Control → Organisation and working organisation filters → Not exposed in reviewed evidence | Documented<br>E07 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |
| CL-196<br>Attendance and leave → Attendance Control → Employee and employee code filters → Not exposed in reviewed evidence | Documented<br>E07 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |
| CL-197<br>Attendance and leave → Attendance Control → Department and location filters → Not exposed in reviewed evidence | Documented<br>E07 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |
| CL-198<br>Attendance and leave → Attendance Control → Status and shift filters → Not exposed in reviewed evidence | Documented<br>E07 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |
| CL-199<br>Attendance and leave → Attendance Control → Date filters → Not exposed in reviewed evidence | Documented<br>E07 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |
| CL-200<br>Attendance and leave → Attendance Control → Minute comparison filter → Not exposed in reviewed evidence | Documented<br>E07 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |
| CL-201<br>Attendance and leave → Attendance Control → Entity filter → Not exposed in reviewed evidence | Documented<br>E07 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |
| CL-202<br>Attendance and leave → Attendance Control → Policy control → Not exposed in reviewed evidence | Documented<br>E07 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |
| CL-203<br>Attendance and leave → Attendance Control → Amendment log control → Not exposed in reviewed evidence | Documented<br>E07 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-019 to FR-027 |


#### Payroll configuration

| Entry and hierarchy | Status and evidence | Documented coverage and limitation |
| --- | --- | --- |
| CL-065<br>Payroll configuration → Paid Days Setting → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-066<br>Payroll configuration → Working days settings → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-067<br>Payroll configuration → Grade Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-068<br>Payroll configuration → Earning Head Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-069<br>Payroll configuration → Deduction Head Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-070<br>Payroll configuration → Grade Mapping → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-071<br>Payroll configuration → Grade Salary Structure → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-072<br>Payroll configuration → External Deduction Mapping → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-073<br>Payroll configuration → PT Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-074<br>Payroll configuration → Challan Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |


#### Payroll inputs

| Entry and hierarchy | Status and evidence | Documented coverage and limitation |
| --- | --- | --- |
| CL-075<br>Payroll inputs → Salary Master Upload → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-064 |
| CL-076<br>Payroll inputs → TDS Projection → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-064 |
| CL-077<br>Payroll inputs → Upload Variable Payments → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-064 |
| CL-078<br>Payroll inputs → Compute Paid Days → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-064 |
| CL-079<br>Payroll inputs → Loan/Advance Entry → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-064 |
| CL-080<br>Payroll inputs → Upload Loan/Advance → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-064 |
| CL-081<br>Payroll inputs → Monthly TDS Challan Entry → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-064 |
| CL-082<br>Payroll inputs → Upload Investment → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-064 |
| CL-083<br>Payroll inputs → Upload Claims - Reimbursement/L.T.A → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-064 |
| CL-084<br>Payroll inputs → Past Salary TDS → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-064 |
| CL-085<br>Payroll inputs → Upload Perquisites → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-064 |
| CL-086<br>Payroll inputs → Set Salary Stop → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-064 |
| CL-087<br>Payroll inputs → Upload Stop Salary → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-064 |


#### Payroll reports

| Entry and hierarchy | Status and evidence | Documented coverage and limitation |
| --- | --- | --- |
| CL-088<br>Payroll reports → Pay Register → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-056 |
| CL-089<br>Payroll reports → Arrear Register → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-056 |
| CL-090<br>Payroll reports → TDS Register → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-056 |
| CL-091<br>Payroll reports → Salary Disbursement → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-056 |
| CL-092<br>Payroll reports → Reimbursement Register → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-056 |
| CL-093<br>Payroll reports → TDS Form27 → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-056 |
| CL-094<br>Payroll reports → Salary Progression Chart → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-056 |
| CL-095<br>Payroll reports → TDS Form-24Q / Form 138 → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-056 |
| CL-096<br>Payroll reports → Salary Comparison Report → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-056 |
| CL-097<br>Payroll reports → Salary JV → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-056 |
| CL-098<br>Payroll reports → Liability Provisions → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-056 |
| CL-099<br>Payroll reports → NPS Report → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-056 |
| CL-100<br>Payroll reports → Export for EDOC → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039; FR-056 |


#### Payroll compliance

| Entry and hierarchy | Status and evidence | Documented coverage and limitation |
| --- | --- | --- |
| CL-101<br>Payroll compliance → PF Register → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-102<br>Payroll compliance → ESIC Register → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-103<br>Payroll compliance → PT Register → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-104<br>Payroll compliance → LWF Register → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-105<br>Payroll compliance → PF Form9 → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-106<br>Payroll compliance → e PF Challan → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-107<br>Payroll compliance → ESIC Six Monthly Report → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-108<br>Payroll compliance → ESIC Monthly Contribution → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |


#### Payroll processing

| Entry and hierarchy | Status and evidence | Documented coverage and limitation |
| --- | --- | --- |
| CL-109<br>Payroll processing → Payroll Controller → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E09 | Screen or area observations recorded in Section 4; write actions and detailed rules remain unverified unless expressly stated.<br>Requirements: FR-028 to FR-039 |
| CL-110<br>Payroll processing → Emp Salary Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E08 | Screen or area observations recorded in Section 4; write actions and detailed rules remain unverified unless expressly stated.<br>Requirements: FR-028 to FR-039 |
| CL-111<br>Payroll processing → Salary Generation → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-112<br>Payroll processing → TDS Calculation → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-113<br>Payroll processing → Check Medical Claims → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-114<br>Payroll processing → Arrear-Increment → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-115<br>Payroll processing → Prepare Form 16 / Form 130 (Salary certificate) → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-116<br>Payroll processing → Lock Salary → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-117<br>Payroll processing → Check Inv Declaration → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-118<br>Payroll processing → TDS Full And Final → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-119<br>Payroll processing → Upload Past Salary → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-028 to FR-039 |
| CL-204<br>Payroll processing → Emp Salary Master → Company and status filters → Not exposed in reviewed evidence | Documented<br>E08 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-028 to FR-039 |
| CL-205<br>Payroll processing → Emp Salary Master → CTC category filter → Not exposed in reviewed evidence | Documented<br>E08 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-028 to FR-039 |
| CL-206<br>Payroll processing → Emp Salary Master → Employee search → Not exposed in reviewed evidence | Documented<br>E08 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-028 to FR-039 |
| CL-207<br>Payroll processing → Emp Salary Master → Month and date filters → Not exposed in reviewed evidence | Documented<br>E08 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-028 to FR-039 |
| CL-208<br>Payroll processing → Emp Salary Master → Salary export → Not exposed in reviewed evidence | Documented<br>E08 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-028 to FR-039 |
| CL-209<br>Payroll processing → Emp Salary Master → Annual salary export → Not exposed in reviewed evidence | Documented<br>E08 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-028 to FR-039 |
| CL-210<br>Payroll processing → Emp Salary Master → Salary list and displayed fields → Not exposed in reviewed evidence | Documented<br>E08 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-028 to FR-039 |
| CL-211<br>Payroll processing → Payroll Controller → Financial year selection → Not exposed in reviewed evidence | Documented<br>E09 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-028 to FR-039 |
| CL-212<br>Payroll processing → Payroll Controller → April to March period selection → Not exposed in reviewed evidence | Documented<br>E09 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-028 to FR-039 |
| CL-213<br>Payroll processing → Payroll Controller → Company filter → Not exposed in reviewed evidence | Documented<br>E09 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-028 to FR-039 |
| CL-214<br>Payroll processing → Payroll Controller → Department filter → Not exposed in reviewed evidence | Documented<br>E09 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-028 to FR-039 |
| CL-215<br>Payroll processing → Payroll Controller → Grade filter → Not exposed in reviewed evidence | Documented<br>E09 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-028 to FR-039 |
| CL-216<br>Payroll processing → Payroll Controller → Working for filter → Not exposed in reviewed evidence | Documented<br>E09 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-028 to FR-039 |
| CL-217<br>Payroll processing → Payroll Controller → Location filter → Not exposed in reviewed evidence | Documented<br>E09 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-028 to FR-039 |


#### Performance management

| Entry and hierarchy | Status and evidence | Documented coverage and limitation |
| --- | --- | --- |
| CL-120<br>Performance management / PMS Config → Appraisal Config → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E11 | Screen or area observations recorded in Section 4; write actions and detailed rules remain unverified unless expressly stated.<br>Requirements: FR-040 to FR-044 |
| CL-121<br>Performance management / PMS Config → PMS Schedule → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-040 to FR-044 |
| CL-122<br>Performance management / PMS Config → Upload KRA/Goals → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-040 to FR-044 |
| CL-123<br>Performance management → Competency Config → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-040 to FR-044 |
| CL-124<br>Performance management → KRA Setting → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-040 to FR-044 |
| CL-125<br>Performance management → KRA Setting Review → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-040 to FR-044 |
| CL-126<br>Performance management → View KRASetting → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-040 to FR-044 |
| CL-127<br>Performance management → Appraisal Entry → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-040 to FR-044 |
| CL-128<br>Performance management → Appraisal Review → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-040 to FR-044 |
| CL-129<br>Performance management → Appraisal Reviewer Review → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-040 to FR-044 |
| CL-130<br>Performance management → HR View Appraisals → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-040 to FR-044 |
| CL-131<br>Performance management → Appraisal Report → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-040 to FR-044 |
| CL-132<br>Performance management → Bell Curve → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-040 to FR-044 |
| CL-221<br>Performance management → Appraisal Config → Section visibility settings → Not exposed in reviewed evidence | Documented<br>E11 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-040 to FR-044 |
| CL-222<br>Performance management → Appraisal Config → Grade competency mapping → Not exposed in reviewed evidence | Documented<br>E11 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-040 to FR-044 |
| CL-223<br>Performance management → Appraisal Config → Rating visibility setting → Not exposed in reviewed evidence | Documented<br>E11 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-040 to FR-044 |
| CL-224<br>Performance management → Appraisal Config → Approval levels → Not exposed in reviewed evidence | Documented<br>E11 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-040 to FR-044 |
| CL-225<br>Performance management → Appraisal Config → Cycle month → Not exposed in reviewed evidence | Documented<br>E11 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-040 to FR-044 |
| CL-226<br>Performance management → Appraisal Config → KRA upload mode → Not exposed in reviewed evidence | Documented<br>E11 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-040 to FR-044 |
| CL-227<br>Performance management → Appraisal Config → Formula and manual rating information → Not exposed in reviewed evidence | Documented<br>E11 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-040 to FR-044 |


#### Timesheet

| Entry and hierarchy | Status and evidence | Documented coverage and limitation |
| --- | --- | --- |
| CL-133<br>Timesheet → Project Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-045 to FR-048 |
| CL-134<br>Timesheet → Job Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-045 to FR-048 |
| CL-135<br>Timesheet → Activity Master → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-045 to FR-048 |
| CL-136<br>Timesheet → Resource Allocation → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E12 | Screen or area observations recorded in Section 4; write actions and detailed rules remain unverified unless expressly stated.<br>Requirements: FR-045 to FR-048 |
| CL-137<br>Timesheet → Time Sheet Approval → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-045 to FR-048 |
| CL-138<br>Timesheet → HR View Time Sheet → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-045 to FR-048 |
| CL-139<br>Timesheet → TMS Reports → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-045 to FR-048 |
| CL-228<br>Timesheet → Resource Allocation → New → Not exposed in reviewed evidence | Documented<br>E12 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-045 to FR-048 |
| CL-229<br>Timesheet → Resource Allocation → Bulk Upload → Not exposed in reviewed evidence | Documented<br>E12 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-045 to FR-048 |
| CL-230<br>Timesheet → Resource Allocation → Search → Not exposed in reviewed evidence | Documented<br>E12 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-045 to FR-048 |
| CL-231<br>Timesheet → Resource Allocation → Export → Not exposed in reviewed evidence | Documented<br>E12 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-045 to FR-048 |
| CL-232<br>Timesheet → Resource Allocation → Export XLSX → Not exposed in reviewed evidence | Documented<br>E12 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-045 to FR-048 |


#### Training and Asset

| Entry and hierarchy | Status and evidence | Documented coverage and limitation |
| --- | --- | --- |
| CL-140<br>Training and Asset → Training Plan → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E13 | Screen or area observations recorded in Section 4; write actions and detailed rules remain unverified unless expressly stated.<br>Requirements: FR-049 to FR-050 |
| CL-141<br>Training and Asset → Training Participants Entry → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-049 to FR-050 |
| CL-233<br>Training and Asset → Training Plan → Search → Not exposed in reviewed evidence | Documented<br>E13 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-049 to FR-050 |
| CL-234<br>Training and Asset → Training Plan → Date filters → Not exposed in reviewed evidence | Documented<br>E13 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-049 to FR-050 |
| CL-235<br>Training and Asset → Training Plan → Export → Not exposed in reviewed evidence | Documented<br>E13 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-049 to FR-050 |
| CL-236<br>Training and Asset → Training Plan → Status views → Cancelled | Documented<br>E13 | Status view label observed; lifecycle transition logic not verified.<br>Requirements: FR-049 to FR-050 |
| CL-237<br>Training and Asset → Training Plan → Status views → Past | Documented<br>E13 | Status view label observed; lifecycle transition logic not verified.<br>Requirements: FR-049 to FR-050 |
| CL-238<br>Training and Asset → Training Plan → Status views → Current | Documented<br>E13 | Status view label observed; lifecycle transition logic not verified.<br>Requirements: FR-049 to FR-050 |
| CL-239<br>Training and Asset → Training Plan → Status views → Future | Documented<br>E13 | Status view label observed; lifecycle transition logic not verified.<br>Requirements: FR-049 to FR-050 |


#### Separation

| Entry and hierarchy | Status and evidence | Documented coverage and limitation |
| --- | --- | --- |
| CL-142<br>Separation → Relieving Letter → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-051 to FR-055 |
| CL-143<br>Separation → Experience Letter → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-051 to FR-055 |
| CL-144<br>Separation → Full and Final → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E14 | Screen or area observations recorded in Section 4; write actions and detailed rules remain unverified unless expressly stated.<br>Requirements: FR-051 to FR-055 |
| CL-145<br>Separation → Upload Full And Final → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-051 to FR-055 |
| CL-240<br>Separation → Full and Final → Company filter → Not exposed in reviewed evidence | Documented<br>E14 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-051 to FR-055 |
| CL-241<br>Separation → Full and Final → Disbursement month filter → Not exposed in reviewed evidence | Documented<br>E14 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-051 to FR-055 |
| CL-242<br>Separation → Full and Final → Employee search → Not exposed in reviewed evidence | Documented<br>E14 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-051 to FR-055 |
| CL-243<br>Separation → Full and Final → Uploaded list search → Not exposed in reviewed evidence | Documented<br>E14 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-051 to FR-055 |
| CL-244<br>Separation → Full and Final → Bulk Upload → Not exposed in reviewed evidence | Documented<br>E14 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-051 to FR-055 |
| CL-245<br>Separation → Full and Final → Send PDF → Not exposed in reviewed evidence | Documented<br>E14 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-051 to FR-055 |
| CL-246<br>Separation → Full and Final → Send Excel → Not exposed in reviewed evidence | Documented<br>E14 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-051 to FR-055 |
| CL-247<br>Separation → Full and Final → ZIP Export → Not exposed in reviewed evidence | Documented<br>E14 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-051 to FR-055 |
| CL-248<br>Separation → Full and Final → Settlement status views → Not exposed in reviewed evidence | Documented<br>E14 | Control observed; destructive or business-changing actions not executed.<br>Requirements: FR-051 to FR-055 |


#### Analytics

| Entry and hierarchy | Status and evidence | Documented coverage and limitation |
| --- | --- | --- |
| CL-146<br>Analytics / Office Reports → Training with feedback Register → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-056 to FR-058 |
| CL-147<br>Analytics / Office Reports → Attrition Register → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-056 to FR-058 |
| CL-148<br>Analytics / Office Reports → Attrition Summary → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-056 to FR-058 |
| CL-149<br>Analytics / Office Reports → Employee History → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-056 to FR-058 |
| CL-150<br>Analytics / Office Reports → Employee Document Compliance → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-056 to FR-058 |
| CL-151<br>Analytics / Audit Trails → Emp Master Audit Trail → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-056 to FR-058 |
| CL-152<br>Analytics / Audit Trails → Download Audit Trails → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-056 to FR-058 |
| CL-153<br>Analytics / Audit Trails → Transaction Audit trail → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-056 to FR-058 |
| CL-154<br>Analytics / Audit Trails → Emp Master Field Level Audit Trail → Not exposed in reviewed evidence → Not exposed in reviewed evidence | Documented<br>E17 | Visible menu label recorded; page internals and business action not inspected.<br>Requirements: FR-056 to FR-058 |


#### Application access

| Entry and hierarchy | Status and evidence | Documented coverage and limitation |
| --- | --- | --- |
| CL-155<br>Application access → Login → Entry or header or footer → Not exposed in reviewed evidence | Documented<br>E01 | Visible entry/display recorded. Recovery, self-service and profile change actions were not completed.<br>Requirements: FR-001 to FR-003; FR-059 to FR-061 |
| CL-156<br>Application access → Forgot Password → Entry or header or footer → Not exposed in reviewed evidence | Documented<br>E01 | Visible entry/display recorded. Recovery, self-service and profile change actions were not completed.<br>Requirements: FR-001 to FR-003; FR-059 to FR-061 |
| CL-157<br>Application access → Home → Entry or header or footer → Not exposed in reviewed evidence | Documented<br>E01 | Visible entry/display recorded. Recovery, self-service and profile change actions were not completed.<br>Requirements: FR-001 to FR-003; FR-059 to FR-061 |
| CL-158<br>Application access → Employee Self Service → Entry or header or footer → Not exposed in reviewed evidence | Documented<br>E01 | Visible entry/display recorded. Recovery, self-service and profile change actions were not completed.<br>Requirements: FR-001 to FR-003; FR-059 to FR-061 |
| CL-159<br>Application access → My Account → Entry or header or footer → Not exposed in reviewed evidence | Documented<br>E01 | Visible entry/display recorded. Recovery, self-service and profile change actions were not completed.<br>Requirements: FR-001 to FR-003; FR-059 to FR-061 |
| CL-160<br>Application access → Last login display → Entry or header or footer → Not exposed in reviewed evidence | Documented<br>E01 | Visible entry/display recorded. Recovery, self-service and profile change actions were not completed.<br>Requirements: FR-001 to FR-003; FR-059 to FR-061 |
| CL-161<br>Application access → External footer link → Entry or header or footer → Not exposed in reviewed evidence | Documented<br>E01 | Visible entry/display recorded. Recovery, self-service and profile change actions were not completed.<br>Requirements: FR-001 to FR-003; FR-059 to FR-061 |
| CL-162<br>Application access → Home → Pending Approvals → Not exposed in reviewed evidence | Documented<br>E01 | Dashboard area label observed; pending-item actions were not executed.<br>Requirements: FR-001 to FR-003; FR-059 to FR-061 |
| CL-163<br>Application access → Home → My Submitted Request → Not exposed in reviewed evidence | Documented<br>E01 | Dashboard area label observed; pending-item actions were not executed.<br>Requirements: FR-001 to FR-003; FR-059 to FR-061 |
| CL-164<br>Application access → Home → Alerts → Not exposed in reviewed evidence | Documented<br>E01 | Dashboard area label observed; pending-item actions were not executed.<br>Requirements: FR-001 to FR-003; FR-059 to FR-061 |
| CL-165<br>Application access → Home → Recruitment Alerts → Not exposed in reviewed evidence | Documented<br>E01 | Dashboard area label observed; pending-item actions were not executed.<br>Requirements: FR-001 to FR-003; FR-059 to FR-061 |


Recorded coverage reconciliation: 259 distinct entries; 258 Documented; 0 Restricted; 1 Not reachable; no blank or unsupported statuses. Every recorded entry is represented. Lower-level details explicitly marked unknown require further evidence. The dedicated expense module is a target extension and is not falsely added as an observed navigation entry.

### Appendix B Proposed database schema and relationships

Developer design proposal for a new HRMS. These logical table and column names are newly proposed, not names extracted from the reference application. No source database schema was accessed. This appendix is an implementation baseline subject to business sign off and schema migration review. The existing field dictionary remains the source for observed labels; business meanings must be preserved when mapping them to these proposed columns.

#### B1 Conventions and integrity boundaries

Every table has id ID as primary key. ID means one consistent surrogate identifier type chosen by the developer. TXT means bounded Unicode text; CODE means a controlled code; DATE means a calendar date; TS means a timezone-aware timestamp; BOOL means true or false; MONEY means exact decimal 19,4; QTY means decimal 12,4. Required fields below are NOT NULL. A question mark means nullable. Ref followed by a table name means foreign key to its id. No database product or deployed database name is specified.

Every tenant-owned table includes company_id Ref company, created_at TS, created_by Ref user_account, updated_at TS, updated_by Ref user_account and version integer. Company itself is the tenant root. user_account and permission are global roots, with nullable bootstrap actors only for controlled initial creation. Role records are company-owned. Historical and audit rows are append-only; updated metadata on immutable rows stays equal to creation metadata. All relationship joins between company-owned records must enforce the same company with composite foreign keys (company_id, referenced_id) to a unique (company_id, id), not application filters alone. A cross-company FK must not be silently accepted.

The column lists below omit these common columns to avoid repetition. Uniqueness keys on company-owned tables include company_id unless explicitly global. FK deletion is RESTRICT by default. References to users are attributable global identities; authorization still requires a company-scoped assignment. No credentials or actual employee data are specified.

Effective intervals use inclusive effective_from and exclusive effective_to. Null end means open-ended. Require end after start; overlapping intervals for the same business key are rejected unless explicitly allowed below. Monetary rounding, statutory formulas, retention periods and detailed source statuses remain owner decisions. Store exact inputs and the approved rule version; do not implement guessed formulas.

#### B2 Domain map and screen traceability

| Domain | Proposed tables and linked business area |
| --- | --- |
| Organisation and access | company through delegation; Employee Master, User Master, User Rights, Reporting Manager. |
| Attendance and leave | shift through leave_movement; E04 to E07, shift and leave menus. |
| Payroll | pay_component through employee_financial_input; E08/E09 and payroll configuration/input/report menus. |
| Approval and evidence | business_transaction through attachment; Pending Approvals and approval-related menus; target workflow engine. |
| Expense and payment | expense_category through payment_event; requested extension, no verified source expense screen. |
| Hiring and performance | requisition through appraisal_item; E10/E11 and hiring/PMS menus. |
| Time training and lifecycle | project through settlement_line; E12/E13/E14/E15 and associated menus. |
| Outputs and traceability | report_execution, audit_event, notification; E01/E17 and audit/report menus. |


#### B3 Detailed proposed table definitions

All definitions below are proposed. Column requiredness describes the target schema, not verified source nullability. Reference dropdowns must use the defined reference table/category; hard-coded values cannot bypass controlled membership. Defaults: no implicit business default unless approved; created_at/updated_at assigned at write time, version starts at 1. Required active flags and business states must be explicitly set by the relevant lifecycle action.

##### DB 001 company

Business source: Organisation masters. Proposed key and rule: Unique code globally; root deactivation cannot orphan active assignments.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| name | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| active | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 002 department

Business source: Department Master. Proposed key and rule: Unique code.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| name | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| active | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 003 location

Business source: Employee Master location. Proposed key and rule: Unique code; source location maintenance screen unverified.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| name | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| active | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 004 designation

Business source: Designation Master. Proposed key and rule: Unique code.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| name | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| active | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 005 grade

Business source: Grade Master. Proposed key and rule: Unique code.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| name | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| active | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 006 reference_value

Business source: Controlled dropdowns. Proposed key and rule: Unique category and code; FK category consistency required.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| category | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| label | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| active | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 007 user_account

Business source: User Master. Proposed key and rule: Global unique account_key; synthetic identifier only; authentication storage design outside this appendix.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| account_key | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| active | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 008 employee

Business source: Employee Master. Proposed key and rule: Unique employee_code permanently per company; status/type references require correct categories.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_code | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| display_name | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| joining_date | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| confirmation_date | DATE optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |
| employment_type_id | Ref reference_value required | References reference_value.id; enforce company boundary where applicable. |
| status_id | Ref reference_value required | References reference_value.id; enforce company boundary where applicable. |
| date_of_birth | DATE optional | Protected; required for configured birthday processing only; future date rejected. |
| service_anniversary_date | DATE optional | Approved service anniversary base; if absent configured joining-date basis used. No silent rejoin rule. |


##### DB 009 user_employee_link

Business source: Own record scope. Proposed key and rule: No overlapping links for user within company; employee belongs to company; link does not itself grant permission.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| user_id | Ref user_account required | References user_account.id; enforce company boundary where applicable. |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| effective_from | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| effective_to | DATE optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |


##### DB 010 employment_assignment

Business source: Employee organisation history. Proposed key and rule: One assignment per employee at an effective instant; history retained.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| department_id | Ref department required | References department.id; enforce company boundary where applicable. |
| location_id | Ref location required | References location.id; enforce company boundary where applicable. |
| designation_id | Ref designation required | References designation.id; enforce company boundary where applicable. |
| grade_id | Ref grade optional | References grade.id; enforce company boundary where applicable. |
| effective_from | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| effective_to | DATE optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |


##### DB 011 manager_assignment

Business source: Reporting Manager. Proposed key and rule: No self-manager; no reporting cycle at any effective instant; one active primary manager.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| manager_employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| effective_from | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| effective_to | DATE optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |


##### DB 012 employee_document

Business source: Employee documents. Proposed key and rule: Same employee/company as attachment owner; document type controlled.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| document_type_id | Ref reference_value required | References reference_value.id; enforce company boundary where applicable. |
| attachment_id | Ref attachment required | References attachment.id; enforce company boundary where applicable. |
| expires_on | DATE optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |


##### DB 013 role

Business source: User Rights. Proposed key and rule: Unique code; role does not confer scope by itself.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| name | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| active | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 014 permission

Business source: User Rights target actions. Proposed key and rule: Global unique resource/action/field_group; explicit catalogue, no wildcard grant.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| resource | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| action | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| field_group | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 015 role_permission

Business source: Proposed permission mapping. Proposed key and rule: Unique role and permission; effect ALLOW or DENY.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| role_id | Ref role required | References role.id; enforce company boundary where applicable. |
| permission_id | Ref permission required | References permission.id; enforce company boundary where applicable. |
| effect | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 016 role_assignment

Business source: Proposed scoped role grant. Proposed key and rule: Scope kind OWN, TEAM, ASSIGNED or COMPANY; granting actor cannot approve own grant.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| user_id | Ref user_account required | References user_account.id; enforce company boundary where applicable. |
| role_id | Ref role required | References role.id; enforce company boundary where applicable. |
| scope_kind | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| effective_from | TS required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| effective_to | TS optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |
| approved_by | Ref user_account required | References user_account.id; enforce company boundary where applicable. |


##### DB 017 role_scope_filter

Business source: Proposed scope restrictions. Proposed key and rule: Exactly one matching typed dimension reference; values within dimension OR, dimensions AND; assignment scope never widened.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| role_assignment_id | Ref role_assignment required | References role_assignment.id; enforce company boundary where applicable. |
| dimension | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| department_id | Ref department optional | References department.id; enforce company boundary where applicable. |
| location_id | Ref location optional | References location.id; enforce company boundary where applicable. |
| employee_id | Ref employee optional | References employee.id; enforce company boundary where applicable. |


##### DB 018 delegation

Business source: Proposed approval substitute. Proposed key and rule: No self delegation; no privilege escalation; delegate must hold applicable base permission and scope; original entitlement remains required.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| delegator_user_id | Ref user_account required | References user_account.id; enforce company boundary where applicable. |
| delegate_user_id | Ref user_account required | References user_account.id; enforce company boundary where applicable. |
| permission_id | Ref permission required | References permission.id; enforce company boundary where applicable. |
| effective_from | TS required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| effective_to | TS required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| approved_by | Ref user_account required | References user_account.id; enforce company boundary where applicable. |


##### DB 019 shift

Business source: Shift Master. Proposed key and rule: Unique code; overnight handling explicit, no negative elapsed duration.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| name | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| in_time | time required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| out_time | time required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| spans_midnight | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| active | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 020 shift_break

Business source: Shift Master breaks. Proposed key and rule: Unique shift/sequence; non-overlapping breaks inside shift duration.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| shift_id | Ref shift required | References shift.id; enforce company boundary where applicable. |
| sequence | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| start_offset_minutes | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| end_offset_minutes | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 021 shift_assignment

Business source: Shift planning. Proposed key and rule: No overlapping primary assignment per employee.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| shift_id | Ref shift required | References shift.id; enforce company boundary where applicable. |
| effective_from | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| effective_to | DATE optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |


##### DB 022 holiday

Business source: Holiday Master. Proposed key and rule: Unique location/date/type; category controlled.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| location_id | Ref location required | References location.id; enforce company boundary where applicable. |
| holiday_date | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| holiday_type_id | Ref reference_value required | References reference_value.id; enforce company boundary where applicable. |


##### DB 023 attendance_policy

Business source: Attendance Policy. Proposed key and rule: Unique code/revision; thresholds nonnegative; owner validates threshold order and deduction formulas.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| revision | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| effective_from | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| effective_to | DATE optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |
| grace_minutes | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| present_minutes | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| half_day_minutes | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| overtime_enabled | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 024 attendance_policy_mapping

Business source: Policy applicability. Proposed key and rule: At least one dimension; no equally specific concurrent policy match; ambiguity is a blocking error.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| policy_id | Ref attendance_policy required | References attendance_policy.id; enforce company boundary where applicable. |
| grade_id | Ref grade optional | References grade.id; enforce company boundary where applicable. |
| location_id | Ref location optional | References location.id; enforce company boundary where applicable. |


##### DB 025 attendance_punch

Business source: Attendance imports and requested biometric API ingestion. Proposed key and rule: direction controlled; unique company/source_identity_key/external_event_key when external key is present. BIOMETRIC_API source requires same-company biometric_profile and its stable namespace. Deterministic fallback keys follow approved mapping strategy. This replaces the narrower source_kind-only key to avoid collisions between providers.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| occurred_at | TS required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| direction | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| source_kind | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| external_event_key | TXT optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |
| biometric_profile_id | Ref biometric_profile optional | Required for BIOMETRIC_API source; otherwise null unless approved mapping. |
| source_identity_key | TXT required | Stable company-local source namespace; no connection address. |


##### DB 026 attendance_record

Business source: Attendance Control. Proposed key and rule: Unique employee/work_date for proposed daily model; split shifts require owner-approved extension; calculated records keep policy version.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| work_date | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| shift_id | Ref shift optional | References shift.id; enforce company boundary where applicable. |
| policy_id | Ref attendance_policy required | References attendance_policy.id; enforce company boundary where applicable. |
| worked_minutes | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| status_id | Ref reference_value required | References reference_value.id; enforce company boundary where applicable. |


##### DB 027 attendance_amendment

Business source: Amendment log. Proposed key and rule: Append-only; proposed amendment must preserve before/after values and cannot overwrite history.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| attendance_record_id | Ref attendance_record required | References attendance_record.id; enforce company boundary where applicable. |
| prior_version | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| old_status_id | Ref reference_value required | References reference_value.id; enforce company boundary where applicable. |
| new_status_id | Ref reference_value required | References reference_value.id; enforce company boundary where applicable. |
| reason | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| actor_id | Ref user_account required | References user_account.id; enforce company boundary where applicable. |
| occurred_at | TS required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 028 leave_type

Business source: Leave Policy Config. Proposed key and rule: Unique code; unit DAY or HOUR and precision owner approved.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| name | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| unit | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| active | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 029 leave_policy

Business source: Leave Policy Config. Proposed key and rule: Unique leave_type/revision; formula codes reference owner-approved rules, not guessed calculations.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| leave_type_id | Ref leave_type required | References leave_type.id; enforce company boundary where applicable. |
| revision | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| effective_from | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| effective_to | DATE optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |
| eligibility_code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| accrual_rule_code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 030 leave_policy_mapping

Business source: Grade location mapping. Proposed key and rule: At least one dimension; no ambiguous equally specific applicable policy.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| policy_id | Ref leave_policy required | References leave_policy.id; enforce company boundary where applicable. |
| grade_id | Ref grade optional | References grade.id; enforce company boundary where applicable. |
| location_id | Ref location optional | References location.id; enforce company boundary where applicable. |


##### DB 031 leave_request

Business source: Leave review menus. Proposed key and rule: Unique transaction; end not before start; units positive; overlap exclusions owner confirmed before implementation.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| leave_type_id | Ref leave_type required | References leave_type.id; enforce company boundary where applicable. |
| policy_id | Ref leave_policy required | References leave_policy.id; enforce company boundary where applicable. |
| transaction_id | Ref business_transaction required | References business_transaction.id; enforce company boundary where applicable. |
| start_date | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| end_date | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| requested_units | QTY required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 032 leave_movement

Business source: Leave opening and balance. Proposed key and rule: Unique idempotency_key; signed units; corrections use reversing movements; balance derived from movements.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| leave_type_id | Ref leave_type required | References leave_type.id; enforce company boundary where applicable. |
| request_id | Ref leave_request optional | References leave_request.id; enforce company boundary where applicable. |
| movement_kind | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| units | QTY required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| effective_date | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| idempotency_key | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 033 pay_component

Business source: Payroll configuration. Proposed key and rule: Unique code; EARNING or DEDUCTION; classification and statutory mappings owner approved.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| name | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| component_kind | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| active | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 034 salary_arrangement

Business source: Employee Salary Master. Proposed key and rule: No overlapping arrangement per employee; amounts nonnegative; estimated in hand is not assumed to equal stored CTC.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| effective_from | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| effective_to | DATE optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |
| annual_ctc | MONEY required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| currency_code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 035 salary_component

Business source: Salary structure. Proposed key and rule: Unique arrangement/component; approved amount basis; component company matches employee company.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| salary_arrangement_id | Ref salary_arrangement required | References salary_arrangement.id; enforce company boundary where applicable. |
| component_id | Ref pay_component required | References pay_component.id; enforce company boundary where applicable. |
| amount | MONEY required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| basis | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 036 payroll_run

Business source: Payroll Controller. Proposed key and rule: Unique period/revision; end after start; one effective final run per company/period; rerun explicitly supersedes prior output.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| period_start | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| period_end | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| revision | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| transaction_id | Ref business_transaction required | References business_transaction.id; enforce company boundary where applicable. |
| supersedes_run_id | Ref payroll_run optional | References payroll_run.id; enforce company boundary where applicable. |


##### DB 037 payroll_record

Business source: Salary and payroll reports. Proposed key and rule: Unique run/employee; net equals gross minus deductions under approved rounding; final rows immutable.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| run_id | Ref payroll_run required | References payroll_run.id; enforce company boundary where applicable. |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| salary_arrangement_id | Ref salary_arrangement required | References salary_arrangement.id; enforce company boundary where applicable. |
| paid_units | QTY required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| gross | MONEY required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| deductions | MONEY required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| net | MONEY required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| currency_code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 038 payroll_line

Business source: Payroll component result. Proposed key and rule: Unique record/component under proposed grouped component model; allowance sublines require owner-approved sequence extension.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| payroll_record_id | Ref payroll_record required | References payroll_record.id; enforce company boundary where applicable. |
| component_id | Ref pay_component required | References pay_component.id; enforce company boundary where applicable. |
| amount | MONEY required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| rule_version | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 039 employee_financial_input

Business source: Loan reimbursement investment input menus. Proposed key and rule: Controlled type; one active claim obligation across expense and payroll channels; loan repayment schedules require approved child schema before build.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| input_kind | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| effective_date | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| amount | MONEY required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| currency_code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| transaction_id | Ref business_transaction optional | References business_transaction.id; enforce company boundary where applicable. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 040 business_transaction

Business source: All approval journeys target design. Proposed key and rule: Transaction registry; exactly one typed root for kind; relationship cannot use an arbitrary unvalidated record identifier.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| kind | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| owner_employee_id | Ref employee optional | References employee.id; enforce company boundary where applicable. |
| revision | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 041 workflow_definition

Business source: Approval configuration target. Proposed key and rule: Unique kind/revision; approved version immutable once used.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| kind | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| revision | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| effective_from | TS required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| effective_to | TS optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |
| active | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 042 workflow_step

Business source: Approval stages target. Proposed key and rule: Unique workflow/sequence; selection and quorum explicitly configured; no default assumed parallel quorum.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| workflow_id | Ref workflow_definition required | References workflow_definition.id; enforce company boundary where applicable. |
| sequence | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| permission_id | Ref permission required | References permission.id; enforce company boundary where applicable. |
| selection_rule | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| completion_rule | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 043 approval_instance

Business source: Pending Approvals target. Proposed key and rule: Unique transaction/revision; pins immutable submitted revision and workflow.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| transaction_id | Ref business_transaction required | References business_transaction.id; enforce company boundary where applicable. |
| transaction_revision | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| workflow_id | Ref workflow_definition required | References workflow_definition.id; enforce company boundary where applicable. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 044 approval_task

Business source: Assigned decisions target. Proposed key and rule: Unique instance/step/assignee; assignee must be eligible at decision time; decision to prior revision prohibited.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| instance_id | Ref approval_instance required | References approval_instance.id; enforce company boundary where applicable. |
| step_id | Ref workflow_step required | References workflow_step.id; enforce company boundary where applicable. |
| assignee_user_id | Ref user_account required | References user_account.id; enforce company boundary where applicable. |
| delegation_id | Ref delegation optional | References delegation.id; enforce company boundary where applicable. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| decided_at | TS optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |


##### DB 045 approval_decision

Business source: Decision history target. Proposed key and rule: Unique idempotency_key and at most one terminal decision per task; reason required for return/reject/override; append-only.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| task_id | Ref approval_task required | References approval_task.id; enforce company boundary where applicable. |
| actor_user_id | Ref user_account required | References user_account.id; enforce company boundary where applicable. |
| decision | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| reason | TXT optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |
| occurred_at | TS required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| expected_version | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| idempotency_key | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 046 attachment

Business source: Employee documents and expense receipts. Proposed key and rule: No deployed storage address recorded; reference is opaque; permissions inherited from typed parent links; file read cannot bypass record scope.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| owner_user_id | Ref user_account required | References user_account.id; enforce company boundary where applicable. |
| employee_id | Ref employee optional | References employee.id; enforce company boundary where applicable. |
| content_reference | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| media_type | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| checksum | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| classification | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 047 expense_category

Business source: Requested expense extension. Proposed key and rule: Unique code; category owner approved.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| name | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| active | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 048 expense_policy

Business source: Requested expense extension. Proposed key and rule: Unique code/revision; immutable once referenced.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| revision | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| currency_code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| effective_from | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| effective_to | DATE optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |


##### DB 049 expense_policy_rule

Business source: Requested expense eligibility. Proposed key and rule: No ambiguous equal-priority matching rule; optional limit means owner-approved no-cap rule, not accidental missing value.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| policy_id | Ref expense_policy required | References expense_policy.id; enforce company boundary where applicable. |
| category_id | Ref expense_category required | References expense_category.id; enforce company boundary where applicable. |
| grade_id | Ref grade optional | References grade.id; enforce company boundary where applicable. |
| location_id | Ref location optional | References location.id; enforce company boundary where applicable. |
| limit_amount | MONEY optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |
| receipt_required | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 050 expense_claim

Business source: Requested expense entry. Proposed key and rule: Unique transaction; only draft edits; approved entitlement separate from payment state.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| transaction_id | Ref business_transaction required | References business_transaction.id; enforce company boundary where applicable. |
| current_revision | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| payment_state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 051 expense_revision

Business source: Requested immutable submission. Proposed key and rule: Unique claim/revision; submission timestamp/actor required once submitted; snapshot immutable after submission.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| claim_id | Ref expense_claim required | References expense_claim.id; enforce company boundary where applicable. |
| revision | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| policy_id | Ref expense_policy required | References expense_policy.id; enforce company boundary where applicable. |
| currency_code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| submitted_at | TS optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |
| submitted_by | Ref user_account optional | References user_account.id; enforce company boundary where applicable. |


##### DB 052 expense_line

Business source: Requested expense line. Proposed key and rule: Unique revision/sequence; claimed positive; approved between zero and claimed unless explicitly approved exception; no mixed currency within revision.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| revision_id | Ref expense_revision required | References expense_revision.id; enforce company boundary where applicable. |
| sequence | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| category_id | Ref expense_category required | References expense_category.id; enforce company boundary where applicable. |
| expense_date | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| claimed_amount | MONEY required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| approved_amount | MONEY optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |
| description | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 053 expense_receipt

Business source: Requested receipt evidence. Proposed key and rule: Unique line/attachment; attachment scope follows claim; required receipt enforced at submit using pinned rule.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| line_id | Ref expense_line required | References expense_line.id; enforce company boundary where applicable. |
| attachment_id | Ref attachment required | References attachment.id; enforce company boundary where applicable. |


##### DB 054 expense_line_decision

Business source: Requested line approval. Proposed key and rule: Unique line/decision; final entitlement derived from applicable final decisions, not sum of all review stages.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| line_id | Ref expense_line required | References expense_line.id; enforce company boundary where applicable. |
| approval_decision_id | Ref approval_decision required | References approval_decision.id; enforce company boundary where applicable. |
| allowed_amount | MONEY required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| exception_reason | TXT optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |


##### DB 055 expense_obligation

Business source: Requested approved liability. Proposed key and rule: One effective approved obligation per claim; amount equals final approved line sum; never create second obligation for payroll routing.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| claim_id | Ref expense_claim required | References expense_claim.id; enforce company boundary where applicable. |
| revision_id | Ref expense_revision required | References expense_revision.id; enforce company boundary where applicable. |
| approved_amount | MONEY required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| currency_code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 056 payment_batch

Business source: Requested payout preparation. Proposed key and rule: Unique transaction; release actor differs from preparer and entitlement approver for allocated claims.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| transaction_id | Ref business_transaction required | References business_transaction.id; enforce company boundary where applicable. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| prepared_by | Ref user_account required | References user_account.id; enforce company boundary where applicable. |
| currency_code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 057 payment_instruction

Business source: Requested payout retry tracking. Proposed key and rule: Unique idempotency_key; positive amount; retries cannot pay a still-pending instruction again.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| batch_id | Ref payment_batch required | References payment_batch.id; enforce company boundary where applicable. |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| amount | MONEY required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| currency_code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| idempotency_key | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| retry_of_id | Ref payment_instruction optional | References payment_instruction.id; enforce company boundary where applicable. |


##### DB 058 payment_allocation

Business source: Requested payout liability mapping. Proposed key and rule: Unique instruction/obligation; positive allocation; same employee/currency/company; reserved plus confirmed cannot exceed obligation.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| instruction_id | Ref payment_instruction required | References payment_instruction.id; enforce company boundary where applicable. |
| obligation_id | Ref expense_obligation required | References expense_obligation.id; enforce company boundary where applicable. |
| amount | MONEY required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 059 payment_event

Business source: Requested confirmed outcome. Proposed key and rule: Unique event_key; confirmation/reversal append-only; reversal references confirmation; no reversal above confirmed amount.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| instruction_id | Ref payment_instruction required | References payment_instruction.id; enforce company boundary where applicable. |
| event_key | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| event_kind | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| amount | MONEY required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| occurred_at | TS required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| reverses_event_id | Ref payment_event optional | References payment_event.id; enforce company boundary where applicable. |


##### DB 060 requisition

Business source: Talent Acquisition. Proposed key and rule: Unique code/transaction; form fields and hiring stages unverified.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| department_id | Ref department required | References department.id; enforce company boundary where applicable. |
| designation_id | Ref designation required | References designation.id; enforce company boundary where applicable. |
| transaction_id | Ref business_transaction required | References business_transaction.id; enforce company boundary where applicable. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 061 candidate

Business source: Talent Register. Proposed key and rule: Unique candidate_code; detailed personal fields not observed and must be separately approved.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| candidate_code | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 062 application

Business source: Hiring tracker. Proposed key and rule: Unique candidate/requisition unless owner approves reapplication revision model.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| candidate_id | Ref candidate required | References candidate.id; enforce company boundary where applicable. |
| requisition_id | Ref requisition required | References requisition.id; enforce company boundary where applicable. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 063 appraisal_cycle

Business source: Appraisal Config. Proposed key and rule: Unique code; end after start; observed one/two levels mapped to approved workflow.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| start_date | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| end_date | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| approval_levels | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 064 appraisal

Business source: Appraisal review. Proposed key and rule: Unique cycle/employee; rating bounds/formula owner approved; no self review unless owner explicitly defines self assessment stage.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| cycle_id | Ref appraisal_cycle required | References appraisal_cycle.id; enforce company boundary where applicable. |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| reviewer_employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| transaction_id | Ref business_transaction required | References business_transaction.id; enforce company boundary where applicable. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| final_rating | QTY optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |


##### DB 065 appraisal_item

Business source: Goals and competencies. Proposed key and rule: Unique appraisal/kind/sequence; weight/rating bounds and totals owner approved.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| appraisal_id | Ref appraisal required | References appraisal.id; enforce company boundary where applicable. |
| item_kind | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| sequence | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| description | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| weight | QTY optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |
| rating | QTY optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |


##### DB 066 project

Business source: Project Master. Proposed key and rule: Unique code.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| name | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| active | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 067 job

Business source: Job Master. Proposed key and rule: Unique project/code.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| project_id | Ref project required | References project.id; enforce company boundary where applicable. |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| active | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 068 activity

Business source: Activity Master. Proposed key and rule: Unique code.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| name | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| active | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 069 resource_allocation

Business source: Resource Allocation. Proposed key and rule: End not before start; duplicate employee/job/interval rejected; simultaneous allocations policy pending.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| job_id | Ref job required | References job.id; enforce company boundary where applicable. |
| start_date | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| end_date | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 070 timesheet

Business source: Timesheet approval. Proposed key and rule: Unique employee/period; date bounds owner approved.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| period_start | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| period_end | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| transaction_id | Ref business_transaction required | References business_transaction.id; enforce company boundary where applicable. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 071 timesheet_line

Business source: Timesheet entry target. Proposed key and rule: Positive minutes; date inside timesheet period; applicable resource allocation required where owner confirms.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| timesheet_id | Ref timesheet required | References timesheet.id; enforce company boundary where applicable. |
| job_id | Ref job required | References job.id; enforce company boundary where applicable. |
| activity_id | Ref activity required | References activity.id; enforce company boundary where applicable. |
| work_date | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| minutes | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 072 training_plan

Business source: Training Plan. Proposed key and rule: Unique code; cancellation is state, not record deletion.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| start_date | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| end_date | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 073 training_participant

Business source: Training participants. Proposed key and rule: Unique plan/employee.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| plan_id | Ref training_plan required | References training_plan.id; enforce company boundary where applicable. |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| participation_state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 074 training_feedback

Business source: Training feedback register. Proposed key and rule: Unique participant/question; response rules owner approved.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| participant_id | Ref training_participant required | References training_participant.id; enforce company boundary where applicable. |
| question_code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| score | QTY optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |
| response | TXT optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |


##### DB 075 lifecycle_process

Business source: Process Master. Proposed key and rule: Unique code; detailed step rules pending.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| name | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| active | BOOL required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 076 employee_process

Business source: Employee Process Master. Proposed key and rule: Unique transaction; process step extension requires owner-approved flow.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| process_id | Ref lifecycle_process required | References lifecycle_process.id; enforce company boundary where applicable. |
| transaction_id | Ref business_transaction required | References business_transaction.id; enforce company boundary where applicable. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 077 letter_output

Business source: Letter printing. Proposed key and rule: Retains exact output and template version for traceability; regeneration produces new output.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_process_id | Ref employee_process required | References employee_process.id; enforce company boundary where applicable. |
| attachment_id | Ref attachment required | References attachment.id; enforce company boundary where applicable. |
| template_code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| template_revision | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| generated_at | TS required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 078 exit_case

Business source: Separation. Proposed key and rule: Unique transaction; one effective open exit per employee.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; enforce company boundary where applicable. |
| transaction_id | Ref business_transaction required | References business_transaction.id; enforce company boundary where applicable. |
| leaving_date | DATE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 079 settlement

Business source: Full and Final. Proposed key and rule: Unique exit/revision and transaction; final settlement components preserved and reconcile.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| exit_case_id | Ref exit_case required | References exit_case.id; enforce company boundary where applicable. |
| revision | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| transaction_id | Ref business_transaction required | References business_transaction.id; enforce company boundary where applicable. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| currency_code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| net_amount | MONEY required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 080 settlement_line

Business source: Full and Final components. Proposed key and rule: Unique settlement/component under proposed grouped model; sign convention owner approved.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| settlement_id | Ref settlement required | References settlement.id; enforce company boundary where applicable. |
| component_id | Ref pay_component required | References pay_component.id; enforce company boundary where applicable. |
| amount | MONEY required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 081 report_execution

Business source: Reports and exports target. Proposed key and rule: No sensitive credentials in snapshots; download rechecks current permission; no persistent cached output shared across scopes.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| report_code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| requested_by | Ref user_account required | References user_account.id; enforce company boundary where applicable. |
| filter_snapshot | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| scope_snapshot | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| generated_at | TS required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| output_attachment_id | Ref attachment optional | References attachment.id; enforce company boundary where applicable. |


##### DB 082 audit_event

Business source: Audit trail menus target. Proposed key and rule: Append-only, protected structured before/after history; create has after, delete has before, update has both; resource/key is an audit locator only, never an approval or permission relation.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| resource_code | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| record_key | ID required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| actor_user_id | Ref user_account required | References user_account.id; enforce company boundary where applicable. |
| action | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| occurred_at | TS required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| prior_version | integer optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |
| new_version | integer optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |
| before_values | TXT optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |
| after_values | TXT optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |
| reason | TXT optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |


##### DB 083 notification

Business source: Alerts target. Proposed key and rule: Recipient scope validated; no sensitive payload copied to unrelated users; external delivery unverified.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| recipient_user_id | Ref user_account required | References user_account.id; enforce company boundary where applicable. |
| transaction_id | Ref business_transaction optional | References business_transaction.id; enforce company boundary where applicable. |
| category | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| occurred_at | TS required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| event_id | Ref notification_event optional | Required for new requested rule-driven event notifications; legacy notification handling remains explicit. |
| rule_id | Ref notification_rule optional | Pinned effective rule/channel/template revision for generated event. |
| channel | CODE required | Approved supported channel; no implicit external send. |
| idempotency_key | TXT required | Unique company/event/recipient/channel/rule/occurrence key; deduplication transaction-safe. |


##### DB 084 import_job

Business source: Bulk uploads. Proposed key and rule: Unique idempotency_key; counts reconcile to rows; replay creates no second business effect.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| kind | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| attachment_id | Ref attachment required | References attachment.id; enforce company boundary where applicable. |
| submitted_by | Ref user_account required | References user_account.id; enforce company boundary where applicable. |
| idempotency_key | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| accepted_count | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| rejected_count | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |


##### DB 085 import_row

Business source: Upload validation results. Proposed key and rule: Unique job/row; row acceptance occurs only with successful business commit; error text contains no sensitive source values.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| job_id | Ref import_job required | References import_job.id; enforce company boundary where applicable. |
| row_number | integer required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| state | CODE required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| error_code | CODE optional | Business meaning follows column and the linked field dictionary; NULL is distinct from zero or empty. |
| business_key | TXT required | Business meaning follows column and the linked field dictionary; Missing value rejected. |
| applied_transaction_id | Ref business_transaction optional | References business_transaction.id; enforce company boundary where applicable. |


##### DB 086 confirmation_policy

Business source: requested target Confirmation Policies. Proposed key and rule: Unique code/revision; positive duration; approved matching precedence with no ambiguity; dated approved policy remains immutable once assigned.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| revision | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| duration | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| duration_unit | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| start_basis | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| month_end_rule | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| start_day_inclusive | BOOL required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| grade_id | Ref grade optional | References grade.id; same company and parent consistency required. |
| location_id | Ref location optional | References location.id; same company and parent consistency required. |
| effective_from | DATE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| effective_to | DATE optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |


##### DB 087 employee_confirmation

Business source: requested target Employee Confirmation Review. Proposed key and rule: Unique transaction and one effective case per employee; due not before start; only one override mode; conditional approval/reason and confirmed actual date checks.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; same company and parent consistency required. |
| policy_id | Ref confirmation_policy required | References confirmation_policy.id; same company and parent consistency required. |
| transaction_id | Ref business_transaction required | References business_transaction.id; same company and parent consistency required. |
| start_date | DATE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| initial_due_date | DATE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| current_due_date | DATE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| override_duration | integer optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| override_due_date | DATE optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| override_reason | TXT optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| actual_confirmation_date | DATE optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| state | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |


##### DB 088 confirmation_action

Business source: requested target Confirmation decision history. Proposed key and rule: Unique decision; append-only; action and date requiredness match decision; approved extension later than prior date unless separate approved correction.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| confirmation_id | Ref employee_confirmation required | References employee_confirmation.id; same company and parent consistency required. |
| approval_decision_id | Ref approval_decision required | References approval_decision.id; same company and parent consistency required. |
| action | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| prior_due_date | DATE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| new_due_date | DATE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| actual_confirmation_date | DATE optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| reason | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| occurred_at | TS required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |


##### DB 089 notification_rule

Business source: requested target Notification Rules. Proposed key and rule: Unique code/revision; nonnegative timing/retry; controlled selectors/placeholders; active config approved; no arbitrary query/executable templates.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| revision | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| event_type | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| channel | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| recipient_selector | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| template_code | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| template_revision | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| template_id | Ref notification_template required | References notification_template.id; same company and parent consistency required. |
| lead_minutes | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| retry_ceiling | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| optional_event | BOOL required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| effective_from | TS required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| effective_to | TS optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| active | BOOL required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |


##### DB 090 notification_template

Business source: requested target Message templates. Proposed key and rule: Unique code/revision/language/channel; immutable after use; placeholders allowlisted and never widen recipient field access.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| revision | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| language | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| channel | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| subject_template | TXT optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| body_template | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| approved_placeholders | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| active | BOOL required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |


##### DB 091 notification_preference

Business source: requested target Notification Preferences. Proposed key and rule: Unique user/event/channel; mandatory transaction events unaffected unless approved; employee link and same company required for employee preferences.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| user_id | Ref user_account required | References user_account.id; same company and parent consistency required. |
| event_type | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| channel | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| publish_celebration | BOOL required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| receive_optional | BOOL required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |


##### DB 092 notification_event

Business source: requested target Committed business notifications. Proposed key and rule: Unique event_key; event subject matches transaction owner where applicable; birth/anniversary event uses explicit year occurrence; created with business commit or validated schedule; minimal data only.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| event_key | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| event_type | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| subject_employee_id | Ref employee optional | References employee.id; same company and parent consistency required. |
| transaction_id | Ref business_transaction optional | References business_transaction.id; same company and parent consistency required. |
| transaction_revision | integer optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| occurrence_date | DATE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| business_timezone | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| occurred_at | TS required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |


##### DB 093 notification_delivery_attempt

Business source: requested target Delivery tracking. Proposed key and rule: Unique notification/attempt; positive attempt; opaque result reference only; delivery success requires evidence; append-only attempts preserve previous failures.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| notification_id | Ref notification required | References notification.id; same company and parent consistency required. |
| attempt_number | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| attempted_at | TS required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| outcome | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| outcome_at | TS optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| failure_code | CODE optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| provider_result_reference | TXT optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |


##### DB 094 biometric_profile

Business source: requested target Biometric API Profiles. Proposed key and rule: Unique code; config/secret references opaque in shared schema; lookback bounded positive; activation requires approved valid mappings, request and time rules.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| name | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| request_config_reference | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| auth_reference | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| provider_timezone | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| pagination_mode | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| schedule_reference | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| lookback_minutes | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| active | BOOL required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |


##### DB 095 biometric_mapping_revision

Business source: requested target Field Mapping version. Proposed key and rule: Unique profile/revision; immutable once used; no overlapping active revision; explicit approved key/time strategy.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| profile_id | Ref biometric_profile required | References biometric_profile.id; same company and parent consistency required. |
| revision | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| effective_from | TS required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| effective_to | TS optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| dedupe_strategy | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| timestamp_rule | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| approved_by | Ref user_account required | References user_account.id; same company and parent consistency required. |


##### DB 096 biometric_field_mapping

Business source: requested target Dynamic API fields. Proposed key and rule: Unique revision/target_field; source path and target/transform allowlisted; required timestamp/identity/key strategy fields cannot lack mapping; no arbitrary executable transforms.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| mapping_revision_id | Ref biometric_mapping_revision required | References biometric_mapping_revision.id; same company and parent consistency required. |
| source_path | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| target_field | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| transform_code | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| format_config | TXT optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| enum_config | TXT optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| required | BOOL required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| default_code | CODE optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |


##### DB 097 biometric_employee_link

Business source: requested target External employee mapping. Proposed key and rule: No overlapping profile/external key link; company matches; reassignments preserve prior dated link.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| profile_id | Ref biometric_profile required | References biometric_profile.id; same company and parent consistency required. |
| external_employee_key | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| employee_id | Ref employee required | References employee.id; same company and parent consistency required. |
| effective_from | TS required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| effective_to | TS optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |


##### DB 098 biometric_sync_run

Business source: requested target Sync Monitor. Proposed key and rule: End after start; counters nonnegative; mapping belongs to profile; checkpoints opaque, advanced only at successful commit; profile/run concurrency controlled.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| profile_id | Ref biometric_profile required | References biometric_profile.id; same company and parent consistency required. |
| mapping_revision_id | Ref biometric_mapping_revision required | References biometric_mapping_revision.id; same company and parent consistency required. |
| window_start | TS required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| window_end | TS required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| starting_checkpoint_reference | TXT optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| committed_checkpoint_reference | TXT optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| source_observation_count | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| accepted_count | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| duplicate_count | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| rejected_count | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| quarantined_count | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| state | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |


##### DB 099 biometric_run_observation

Business source: requested target Per run outcome evidence. Proposed key and rule: Unique run/observation_index; positive index; same company/profile as canonical event where linked; retained per-run ACCEPTED/DUPLICATE/REJECTED/QUARANTINED outcome reconciles counters and conflicting payload fingerprints.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| run_id | Ref biometric_sync_run required | References biometric_sync_run.id; same company and parent consistency required. |
| observation_index | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| ingest_event_id | Ref biometric_ingest_event optional | References biometric_ingest_event.id; same company and parent consistency required. |
| source_event_key | TXT optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| fingerprint | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| outcome | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| failure_code | CODE optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |


##### DB 100 biometric_ingest_event

Business source: requested target Source event and quarantine. Proposed key and rule: Unique profile/source_event_key for canonical event; differing fingerprint collision retained as run exception/audit not replacement; accepted requires valid employee/time/direction/punch link; raw biometric templates excluded.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| profile_id | Ref biometric_profile required | References biometric_profile.id; same company and parent consistency required. |
| first_run_id | Ref biometric_sync_run required | References biometric_sync_run.id; same company and parent consistency required. |
| latest_run_id | Ref biometric_sync_run required | References biometric_sync_run.id; same company and parent consistency required. |
| mapping_revision_id | Ref biometric_mapping_revision required | References biometric_mapping_revision.id; same company and parent consistency required. |
| source_event_key | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| fingerprint | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| external_employee_key | TXT optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| employee_id | Ref employee optional | References employee.id; same company and parent consistency required. |
| normalised_time | TS optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| direction | CODE optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| punch_id | Ref attendance_punch optional | References attendance_punch.id; same company and parent consistency required. |
| state | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| failure_code | CODE optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |


##### DB 101 increment_cycle

Business source: requested target Increment Cycles. Proposed key and rule: Unique code/revision; positive recurrence and window; nonnegative lead; common-date anchor required for COMMON_DATE basis, anniversary base resolves employee approved service date; explicit owner-approved date/eligibility rules; immutable definition while referenced by active plan/case.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| code | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| revision | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| recurrence_basis | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| recurrence_unit | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| recurrence_interval | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| recurrence_anchor_date | DATE optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| review_lead_days | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| review_window_days | integer required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| eligibility_rule_code | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| eligibility_config | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| cutoff_rule_code | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| cutoff_config | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| effective_date_rule_code | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| effective_date_config | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| compensation_basis | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| effective_from | DATE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| effective_to | DATE optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| active | BOOL required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |


##### DB 102 employee_increment_plan

Business source: requested target Cycle Assignment. Proposed key and rule: No overlapping primary plan per employee; cycle/company match; reason/independent approval required for override; next due recomputed only through approved action with history.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; same company and parent consistency required. |
| cycle_id | Ref increment_cycle required | References increment_cycle.id; same company and parent consistency required. |
| effective_from | DATE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| effective_to | DATE optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| next_review_date | DATE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| override_review_date | DATE optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| override_reason | TXT optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| override_approved_by | Ref user_account optional | References user_account.id; same company and parent consistency required. |
| active | BOOL required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |


##### DB 103 increment_case

Business source: requested target Increment Review. Proposed key and rule: Unique transaction and employee/cycle_occurrence_key; off-cycle has explicit reason/authority; normal cycle requires plan/cycle; comparable baseline/version validated; preparer differs from approval actor; applied salary is unique per case.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; same company and parent consistency required. |
| plan_id | Ref employee_increment_plan optional | References employee_increment_plan.id; same company and parent consistency required. |
| cycle_id | Ref increment_cycle optional | References increment_cycle.id; same company and parent consistency required. |
| transaction_id | Ref business_transaction required | References business_transaction.id; same company and parent consistency required. |
| cycle_occurrence_key | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| off_cycle | BOOL required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| prepared_by | Ref user_account required | References user_account.id; same company and parent consistency required. |
| baseline_salary_id | Ref salary_arrangement required | References salary_arrangement.id; same company and parent consistency required. |
| compensation_basis | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| currency_code | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| baseline_amount | MONEY required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| proposed_amount | MONEY required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| approved_amount | MONEY optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| proposed_effective_date | DATE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| approved_effective_date | DATE optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| applied_salary_id | Ref salary_arrangement optional | References salary_arrangement.id; same company and parent consistency required. |
| state | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| reason | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |


##### DB 104 increment_component

Business source: requested target Increment component proposal. Proposed key and rule: Unique case/component; same company and declared basis/currency; approved component totals reconcile to approved declared compensation definition.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| case_id | Ref increment_case required | References increment_case.id; same company and parent consistency required. |
| component_id | Ref pay_component required | References pay_component.id; same company and parent consistency required. |
| before_amount | MONEY required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| proposed_amount | MONEY required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| approved_amount | MONEY optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |


##### DB 105 increment_history

Business source: requested target Employee salary history event. Proposed key and rule: Unique case; append-only; both salaries/decision belong to same employee/case; percent positive-baseline formula at approved precision, else nullable with reason; new salary is same as applied case salary.. Common B1 company/id/audit/version columns and composite same-company FKs apply. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| employee_id | Ref employee required | References employee.id; same company and parent consistency required. |
| case_id | Ref increment_case required | References increment_case.id; same company and parent consistency required. |
| approval_decision_id | Ref approval_decision required | References approval_decision.id; same company and parent consistency required. |
| old_salary_id | Ref salary_arrangement required | References salary_arrangement.id; same company and parent consistency required. |
| new_salary_id | Ref salary_arrangement required | References salary_arrangement.id; same company and parent consistency required. |
| effective_date | DATE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| compensation_basis | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| currency_code | CODE required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| before_amount | MONEY required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| after_amount | MONEY required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| change_amount | MONEY required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| change_percent | QTY optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| percent_na_reason | CODE optional | Business meaning follows the central field dictionary and the table rule; conditional NULL requires explicit reason where specified. |
| reason | TXT required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| applied_at | TS required | Business meaning follows the central field dictionary and the table rule; Missing value rejected. |
| applied_by | Ref user_account required | References user_account.id; same company and parent consistency required. |


#### B4 Foreign key and cardinality register

Each row is a proposed foreign key. A parent can have zero to many children unless the uniqueness rules in B3 constrain it to at most one. Junction-table pairs define many-to-many business relations. Composite company enforcement and RESTRICT deletion apply to every company-owned relationship. Common company and audit actor references defined in B1 apply in addition to this register.

| Parent table | Child table and foreign key | Child to parent |
| --- | --- | --- |
| reference_value | employee.employment_type_id | 1 parent per child |
| reference_value | employee.status_id | 1 parent per child |
| user_account | user_employee_link.user_id | 1 parent per child |
| employee | user_employee_link.employee_id | 1 parent per child |
| employee | employment_assignment.employee_id | 1 parent per child |
| department | employment_assignment.department_id | 1 parent per child |
| location | employment_assignment.location_id | 1 parent per child |
| designation | employment_assignment.designation_id | 1 parent per child |
| grade | employment_assignment.grade_id | 0..1 parent per child |
| employee | manager_assignment.employee_id | 1 parent per child |
| employee | manager_assignment.manager_employee_id | 1 parent per child |
| employee | employee_document.employee_id | 1 parent per child |
| reference_value | employee_document.document_type_id | 1 parent per child |
| attachment | employee_document.attachment_id | 1 parent per child |
| role | role_permission.role_id | 1 parent per child |
| permission | role_permission.permission_id | 1 parent per child |
| user_account | role_assignment.user_id | 1 parent per child |
| role | role_assignment.role_id | 1 parent per child |
| user_account | role_assignment.approved_by | 1 parent per child |
| role_assignment | role_scope_filter.role_assignment_id | 1 parent per child |
| department | role_scope_filter.department_id | 0..1 parent per child |
| location | role_scope_filter.location_id | 0..1 parent per child |
| employee | role_scope_filter.employee_id | 0..1 parent per child |
| user_account | delegation.delegator_user_id | 1 parent per child |
| user_account | delegation.delegate_user_id | 1 parent per child |
| permission | delegation.permission_id | 1 parent per child |
| user_account | delegation.approved_by | 1 parent per child |
| shift | shift_break.shift_id | 1 parent per child |
| employee | shift_assignment.employee_id | 1 parent per child |
| shift | shift_assignment.shift_id | 1 parent per child |
| location | holiday.location_id | 1 parent per child |
| reference_value | holiday.holiday_type_id | 1 parent per child |
| attendance_policy | attendance_policy_mapping.policy_id | 1 parent per child |
| grade | attendance_policy_mapping.grade_id | 0..1 parent per child |
| location | attendance_policy_mapping.location_id | 0..1 parent per child |
| employee | attendance_punch.employee_id | 1 parent per child |
| employee | attendance_record.employee_id | 1 parent per child |
| shift | attendance_record.shift_id | 0..1 parent per child |
| attendance_policy | attendance_record.policy_id | 1 parent per child |
| reference_value | attendance_record.status_id | 1 parent per child |
| attendance_record | attendance_amendment.attendance_record_id | 1 parent per child |
| reference_value | attendance_amendment.old_status_id | 1 parent per child |
| reference_value | attendance_amendment.new_status_id | 1 parent per child |
| user_account | attendance_amendment.actor_id | 1 parent per child |
| leave_type | leave_policy.leave_type_id | 1 parent per child |
| leave_policy | leave_policy_mapping.policy_id | 1 parent per child |
| grade | leave_policy_mapping.grade_id | 0..1 parent per child |
| location | leave_policy_mapping.location_id | 0..1 parent per child |
| employee | leave_request.employee_id | 1 parent per child |
| leave_type | leave_request.leave_type_id | 1 parent per child |
| leave_policy | leave_request.policy_id | 1 parent per child |
| business_transaction | leave_request.transaction_id | 1 parent per child |
| employee | leave_movement.employee_id | 1 parent per child |
| leave_type | leave_movement.leave_type_id | 1 parent per child |
| leave_request | leave_movement.request_id | 0..1 parent per child |
| employee | salary_arrangement.employee_id | 1 parent per child |
| salary_arrangement | salary_component.salary_arrangement_id | 1 parent per child |
| pay_component | salary_component.component_id | 1 parent per child |
| business_transaction | payroll_run.transaction_id | 1 parent per child |
| payroll_run | payroll_run.supersedes_run_id | 0..1 parent per child |
| payroll_run | payroll_record.run_id | 1 parent per child |
| employee | payroll_record.employee_id | 1 parent per child |
| salary_arrangement | payroll_record.salary_arrangement_id | 1 parent per child |
| payroll_record | payroll_line.payroll_record_id | 1 parent per child |
| pay_component | payroll_line.component_id | 1 parent per child |
| employee | employee_financial_input.employee_id | 1 parent per child |
| business_transaction | employee_financial_input.transaction_id | 0..1 parent per child |
| employee | business_transaction.owner_employee_id | 0..1 parent per child |
| workflow_definition | workflow_step.workflow_id | 1 parent per child |
| permission | workflow_step.permission_id | 1 parent per child |
| business_transaction | approval_instance.transaction_id | 1 parent per child |
| workflow_definition | approval_instance.workflow_id | 1 parent per child |
| approval_instance | approval_task.instance_id | 1 parent per child |
| workflow_step | approval_task.step_id | 1 parent per child |
| user_account | approval_task.assignee_user_id | 1 parent per child |
| delegation | approval_task.delegation_id | 0..1 parent per child |
| approval_task | approval_decision.task_id | 1 parent per child |
| user_account | approval_decision.actor_user_id | 1 parent per child |
| user_account | attachment.owner_user_id | 1 parent per child |
| employee | attachment.employee_id | 0..1 parent per child |
| expense_policy | expense_policy_rule.policy_id | 1 parent per child |
| expense_category | expense_policy_rule.category_id | 1 parent per child |
| grade | expense_policy_rule.grade_id | 0..1 parent per child |
| location | expense_policy_rule.location_id | 0..1 parent per child |
| employee | expense_claim.employee_id | 1 parent per child |
| business_transaction | expense_claim.transaction_id | 1 parent per child |
| expense_claim | expense_revision.claim_id | 1 parent per child |
| expense_policy | expense_revision.policy_id | 1 parent per child |
| user_account | expense_revision.submitted_by | 0..1 parent per child |
| expense_revision | expense_line.revision_id | 1 parent per child |
| expense_category | expense_line.category_id | 1 parent per child |
| expense_line | expense_receipt.line_id | 1 parent per child |
| attachment | expense_receipt.attachment_id | 1 parent per child |
| expense_line | expense_line_decision.line_id | 1 parent per child |
| approval_decision | expense_line_decision.approval_decision_id | 1 parent per child |
| expense_claim | expense_obligation.claim_id | 1 parent per child |
| expense_revision | expense_obligation.revision_id | 1 parent per child |
| business_transaction | payment_batch.transaction_id | 1 parent per child |
| user_account | payment_batch.prepared_by | 1 parent per child |
| payment_batch | payment_instruction.batch_id | 1 parent per child |
| employee | payment_instruction.employee_id | 1 parent per child |
| payment_instruction | payment_instruction.retry_of_id | 0..1 parent per child |
| payment_instruction | payment_allocation.instruction_id | 1 parent per child |
| expense_obligation | payment_allocation.obligation_id | 1 parent per child |
| payment_instruction | payment_event.instruction_id | 1 parent per child |
| payment_event | payment_event.reverses_event_id | 0..1 parent per child |
| department | requisition.department_id | 1 parent per child |
| designation | requisition.designation_id | 1 parent per child |
| business_transaction | requisition.transaction_id | 1 parent per child |
| candidate | application.candidate_id | 1 parent per child |
| requisition | application.requisition_id | 1 parent per child |
| appraisal_cycle | appraisal.cycle_id | 1 parent per child |
| employee | appraisal.employee_id | 1 parent per child |
| employee | appraisal.reviewer_employee_id | 1 parent per child |
| business_transaction | appraisal.transaction_id | 1 parent per child |
| appraisal | appraisal_item.appraisal_id | 1 parent per child |
| project | job.project_id | 1 parent per child |
| employee | resource_allocation.employee_id | 1 parent per child |
| job | resource_allocation.job_id | 1 parent per child |
| employee | timesheet.employee_id | 1 parent per child |
| business_transaction | timesheet.transaction_id | 1 parent per child |
| timesheet | timesheet_line.timesheet_id | 1 parent per child |
| job | timesheet_line.job_id | 1 parent per child |
| activity | timesheet_line.activity_id | 1 parent per child |
| training_plan | training_participant.plan_id | 1 parent per child |
| employee | training_participant.employee_id | 1 parent per child |
| training_participant | training_feedback.participant_id | 1 parent per child |
| employee | employee_process.employee_id | 1 parent per child |
| lifecycle_process | employee_process.process_id | 1 parent per child |
| business_transaction | employee_process.transaction_id | 1 parent per child |
| employee_process | letter_output.employee_process_id | 1 parent per child |
| attachment | letter_output.attachment_id | 1 parent per child |
| employee | exit_case.employee_id | 1 parent per child |
| business_transaction | exit_case.transaction_id | 1 parent per child |
| exit_case | settlement.exit_case_id | 1 parent per child |
| business_transaction | settlement.transaction_id | 1 parent per child |
| settlement | settlement_line.settlement_id | 1 parent per child |
| pay_component | settlement_line.component_id | 1 parent per child |
| user_account | report_execution.requested_by | 1 parent per child |
| attachment | report_execution.output_attachment_id | 0..1 parent per child |
| user_account | audit_event.actor_user_id | 1 parent per child |
| user_account | notification.recipient_user_id | 1 parent per child |
| business_transaction | notification.transaction_id | 0..1 parent per child |
| attachment | import_job.attachment_id | 1 parent per child |
| user_account | import_job.submitted_by | 1 parent per child |
| import_job | import_row.job_id | 1 parent per child |
| business_transaction | import_row.applied_transaction_id | 0..1 parent per child |
| grade | confirmation_policy.grade_id | 0..1 parent per child |
| location | confirmation_policy.location_id | 0..1 parent per child |
| employee | employee_confirmation.employee_id | 1 parent per child |
| confirmation_policy | employee_confirmation.policy_id | 1 parent per child |
| business_transaction | employee_confirmation.transaction_id | 1 parent per child |
| employee_confirmation | confirmation_action.confirmation_id | 1 parent per child |
| approval_decision | confirmation_action.approval_decision_id | 1 parent per child |
| notification_template | notification_rule.template_id | 1 parent per child |
| user_account | notification_preference.user_id | 1 parent per child |
| employee | notification_event.subject_employee_id | 0..1 parent per child |
| business_transaction | notification_event.transaction_id | 0..1 parent per child |
| notification | notification_delivery_attempt.notification_id | 1 parent per child |
| biometric_profile | biometric_mapping_revision.profile_id | 1 parent per child |
| user_account | biometric_mapping_revision.approved_by | 1 parent per child |
| biometric_mapping_revision | biometric_field_mapping.mapping_revision_id | 1 parent per child |
| biometric_profile | biometric_employee_link.profile_id | 1 parent per child |
| employee | biometric_employee_link.employee_id | 1 parent per child |
| biometric_profile | biometric_sync_run.profile_id | 1 parent per child |
| biometric_mapping_revision | biometric_sync_run.mapping_revision_id | 1 parent per child |
| biometric_sync_run | biometric_run_observation.run_id | 1 parent per child |
| biometric_ingest_event | biometric_run_observation.ingest_event_id | 0..1 parent per child |
| biometric_profile | biometric_ingest_event.profile_id | 1 parent per child |
| biometric_sync_run | biometric_ingest_event.first_run_id | 1 parent per child |
| biometric_sync_run | biometric_ingest_event.latest_run_id | 1 parent per child |
| biometric_mapping_revision | biometric_ingest_event.mapping_revision_id | 1 parent per child |
| employee | biometric_ingest_event.employee_id | 0..1 parent per child |
| attendance_punch | biometric_ingest_event.punch_id | 0..1 parent per child |
| employee | employee_increment_plan.employee_id | 1 parent per child |
| increment_cycle | employee_increment_plan.cycle_id | 1 parent per child |
| user_account | employee_increment_plan.override_approved_by | 0..1 parent per child |
| employee | increment_case.employee_id | 1 parent per child |
| employee_increment_plan | increment_case.plan_id | 0..1 parent per child |
| increment_cycle | increment_case.cycle_id | 0..1 parent per child |
| business_transaction | increment_case.transaction_id | 1 parent per child |
| user_account | increment_case.prepared_by | 1 parent per child |
| salary_arrangement | increment_case.baseline_salary_id | 1 parent per child |
| salary_arrangement | increment_case.applied_salary_id | 0..1 parent per child |
| increment_case | increment_component.case_id | 1 parent per child |
| pay_component | increment_component.component_id | 1 parent per child |
| employee | increment_history.employee_id | 1 parent per child |
| increment_case | increment_history.case_id | 1 parent per child |
| approval_decision | increment_history.approval_decision_id | 1 parent per child |
| salary_arrangement | increment_history.old_salary_id | 1 parent per child |
| salary_arrangement | increment_history.new_salary_id | 1 parent per child |
| user_account | increment_history.applied_by | 1 parent per child |
| biometric_profile | attendance_punch.biometric_profile_id | 0..1 parent per child |
| notification_event | notification.event_id | 0..1 parent per child |
| notification_rule | notification.rule_id | 0..1 parent per child |
| role | role_dashboard_definition.role_id | Exactly one parent; same company; parent has zero/many definitions |
| role_dashboard_definition | role_dashboard_widget.dashboard_id | Exactly one parent; same company; parent has zero/many widgets |
| permission | role_dashboard_widget.permission_id | Exactly one required permission; current assignment and field checks remain mandatory |
| user_account | confidential_field_policy.approved_by | Exactly one approval actor per active policy; recorded business scope enforced |
| role_assignment | role_assignment_permission.role_assignment_id | Exactly one parent; same company; parent has zero/many permission restrictions |
| permission | role_assignment_permission.permission_id | Exactly one catalogue permission; parent role must allow it |


#### B5 Transactions history and calculation sources

| Concern | Required developer design |
| --- | --- |
| Typed transaction integrity | business_transaction.kind maps to exactly one of leave_request, payroll_run, expense_claim, payment_batch, requisition, appraisal, timesheet, employee_process, exit_case, settlement, employee_confirmation or increment_case. Enforce root FK uniqueness and matching kind, with a deferred integrity check or equivalent transaction constraint. Any additional workflow requires an explicit typed root and migration. No arbitrary target table string grants authorization. |
| Submission snapshots | expense_revision, workflow_definition and rule versions used by submitted transactions are immutable. Revisions create new approval instances; prior tasks become superseded and cannot decide the new revision. Attendance amendments and audit history retain previous values. |
| Atomic decisions | Validate permission, live assignment, scope, current revision, state and expected version inside the same transaction as decision and state change. Lock the reviewed record or use version compare-and-swap; concurrent losing decision has no effects. Write audit and queue notification only after successful decision. |
| Attendance source | attendance_punch is source evidence; attendance_record is a reproducible daily result using pinned shift and policy. No invented grace, paid-day or overtime formula. Recalculation after amendment produces attributable history. |
| Leave balance | Derive balance from signed leave_movement entries as of the same effective date. Reserving pending requests and consumption/cancellation rules require owner approval. Movement idempotency prevents double consumption. |
| Payroll amount | salary arrangement/components and financial inputs are inputs. Payroll lines and totals are stored calculation snapshots for a run; reports aggregate effective approved run records. Gross, deduction and net reconciliation uses owner-approved precision, sign and rounding. |
| Expense entitlement | Submitted claim total equals its revision line sum. Approved obligation equals applicable final line-approved sum. Intermediate manager and finance decisions must not be cumulatively summed. policy_id pins rules applicable under the owner-approved policy date basis. |
| Payment conservation | Available entitlement equals approved obligation less net confirmed payments less pending reservations. In one locked transaction, reserve allocations and reject any over-allocation; release reservations only after definitive failure or cancellation. Confirmed payment events reduce reservations once and increase paid once. Reversal restores outstanding once up to confirmed amount. |
| Payroll payout channel | If expenses are paid via payroll, reuse the same expense_obligation and allocation ledger; route the instruction to the payroll channel. Do not create another employee_financial_input obligation that can be paid independently. An explicit obligation-to-payroll-line link is required before implementing this option. |
| Reporting reconciliation | Filter the same company, employee scope, effective period, currency, state and revision across lists, dashboard and export. Monetary difference must be zero after the same approved rounding; counts must be exactly equal. Keep report filter and permission context, without sensitive credentials. |
| Deletion and retention | Deactivate reference masters and revoke assignments by effective dates. No hard deletion of referenced employees, submitted transactions, decisions, confirmed payments or audit events. Physical retention/purge rules remain an owner decision; no undocumented retention promise. |
| Indexes and migration | Index FK joins and company/employee/period/state lookup paths; unique indexes enforce listed natural keys. Reject existing duplicates/orphans before adding constraints. Backfill with anonymised fixtures; record rejected exceptions and reconcile migration counts. Index names and platform syntax are implementation decisions. |


#### B6 Requirement to schema traceability

| FR identifiers | Primary proposed tables | Blocked detail or no storage reason |
| --- | --- | --- |
| FR-001 to FR-003; FR-066 to FR-069 | user_account, user_employee_link, role, permission, role_permission, role_assignment, role_scope_filter, delegation | Authentication/session implementation is separate; no source identity policy confirmed. |
| FR-004 to FR-005 | company, department, location, designation, grade, reference_value, shift, shift_break, holiday | Calendar applicability and local reference lists need owner approval. |
| FR-006 to FR-010 | employee, employment_assignment, employee_document, attachment, import_job, import_row, report_execution, notification | Family, qualification, previous employer and detailed employee fields need approved child schemas. |
| FR-011 to FR-014 | requisition, candidate, application, business_transaction, approval_instance | Manpower budget, CV details, offers and onboarding handover mapping require detailed extensions. |
| FR-015 to FR-018 | lifecycle_process, employee_process, letter_output, attachment, notification | Process steps, restricted notes and letter template definitions require approved extensions. |
| FR-019 to FR-023 | attendance_punch, attendance_record, attendance_amendment, attendance_policy, attendance_policy_mapping, shift_assignment, import_job | EOD execution and mobile identity/device links require additional owner-approved control records. |
| FR-024 to FR-027 | leave_type, leave_policy, leave_policy_mapping, leave_request, leave_movement, approval_instance | Outdoor/work-on-holiday require typed transaction roots and approved separate states; not assumed to be leave. |
| FR-028 to FR-039 | pay_component, salary_arrangement, salary_component, payroll_run, payroll_record, payroll_line, employee_financial_input | Grade structure, loans/schedules, arrears, tax/declarations, stops, statutory rules/challans and controlled reopen need approved extensions. |
| FR-040 to FR-044 | appraisal_cycle, appraisal, appraisal_item, workflow_definition, workflow_step | Competency/rating masters, formula/visibility configuration and cycle mapping require approved extensions. |
| FR-045 to FR-048 | project, job, activity, resource_allocation, timesheet, timesheet_line | Lock history and payroll linkage rules require owner-approved mappings. |
| FR-049 to FR-050 | training_plan, training_participant, training_feedback | Feedback question definitions and scoring require controlled approved reference definitions. |
| FR-051 to FR-055 | exit_case, settlement, settlement_line, employee_process, letter_output, role_assignment | Exit clearances and release duties require defined tasks; access revocation retained by assignment end dates. |
| FR-056 to FR-058; FR-065 | report_execution, attachment, audit_event | Reports have no separate duplicated business totals; retention/purge rules remain owner decisions. |
| FR-059 to FR-061 | employee, approval_task, notification | Portal and queues use the same scoped entities, no second independent employee dataset. |
| FR-062 to FR-064 | All B3 keys and constraints; import_job, import_row | Service responsibility is an implementation boundary, not a separate business entity. |
| FR-070 to FR-079 | expense_category, expense_policy, expense_policy_rule, expense_claim, expense_revision, expense_line, expense_receipt, expense_line_decision, expense_obligation, payment_batch, payment_instruction, payment_allocation, payment_event | Duplicate receipt/line warning rules need owner-approved comparison criteria; payment channel and exceptions need owner sign off. |
| FR-080 to FR-082 | confirmation_policy, employee_confirmation, confirmation_action, approval_instance/task/decision | OQ21 HD11 policy/date/override/approval/reminder parameters. |
| FR-083 to FR-085 | employee dates; notification_rule, notification_template, notification_preference, notification_event, notification, notification_delivery_attempt | OQ22 HD12 recipient/channel/privacy/timing/template and provider delivery capabilities. |
| FR-086 to FR-088 | biometric_profile, mapping_revision, field_mapping, employee_link, sync_run, run_observation, ingest_event; attendance_punch | OQ23 HD13 restricted provider contract; mappings/time/key/late-punch/checkpoint decisions. |
| FR-089 to FR-093 | increment_cycle, employee_increment_plan, increment_case, increment_component, increment_history; salary_arrangement/components; existing employee/assignment/audit history | OQ24 HD14 comparable basis/year formula; OQ25 HD15 cycle/eligibility/approval/effective payroll rules. |


#### B7 Build dependencies and unresolved schema extensions

This is a logical implementation baseline, not executable platform-specific DDL or a verified replica of the vendor schema. Detailed tax declarations/challans, statutory component mappings, loan schedules, candidate personal forms, appraisal competency/rating masters, lifecycle steps, clearance tasks, letter templates, report definitions and asset custody require approved field dictionaries and rules before their implementation migrations. Existing menu-only requirements remain blocked from business sign off until these definitions are supplied. The senior developer must produce a migration and constraint checklist from B3/B4 and map every delivered FR to its tables; a schema omission must be raised, not filled by guessing.

#### B8 Required consistency checks across relationships

The final review adds the following required target constraints. Ordinary individual foreign keys do not establish these multi-record invariants. Use composite keys, controlled references, deferred constraints, or atomic transaction checks as appropriate to the chosen platform. The senior developer must record which enforcement mechanism implements each invariant and test direct data writes as well as application requests. No new source behaviour is asserted.

| Constraint | Required invariant | Acceptance gate |
| --- | --- | --- |
| CI01 Approval instance and task | approval_task.step_id must belong to the workflow_definition referenced by its approval_instance; task, step, workflow, instance and transaction must share company. Task cannot reference a step from another workflow revision. | ZT06 ZT10 |
| CI02 Submitted revision identity | approval_instance.transaction_revision equals the frozen submitted revision of its typed transaction root. expense_claim.current_revision resolves to one expense_revision belonging to that same claim. Resubmission supersedes old active instance/tasks atomically. | ZT10 ZT11 ZT12 |
| CI03 Expense obligation parent identity | expense_obligation.revision_id belongs to expense_obligation.claim_id and is the approved revision. Its amount and currency match that revision and final approved line sum. At most one obligation per claim under the current proposed model; post-approval entitlement correction needs an approved adjustment design. | ZT06 ZT13 ZT14 |
| CI04 Expense line decision provenance | expense_line_decision.line_id belongs to the claim revision reviewed by the referenced approval_decision task/instance. allowed_amount equals that decision’s retained line amount. A decision for another claim/revision cannot establish entitlement. | ZT06 ZT10 ZT13 |
| CI05 Payment employee and currency | Every allocation joins an obligation for the instruction employee; instruction employee is claim owner; batch, instruction, revision and obligation currencies match. Instruction amount equals its allocation sum. One instruction may cover several same-currency obligations for the same employee. | ZT06 ZT13 ZT14 |
| CI06 Payment retries and reversals | retry_of_id refers to same employee, currency and original liability set and cannot form a cycle. Prior instruction must be definitively failed/cancelled with no live reservation before replacement. reverses_event_id identifies a confirmation for the same instruction/currency; aggregate reversals cannot exceed confirmations. | ZT07 ZT14 ZT15 |
| CI07 Payroll identity and dates | payroll_record.salary_arrangement_id belongs to the record employee and company and is applicable under the owner-approved payroll valuation date rule. payroll_run supersedes link uses same company/period and no cycle. Component parent/company and monetary currency/sign agree. | ZT06 ZT09 ZT16 |
| CI08 Leave policy and movements | leave_request.policy_id uses the same leave_type as request.leave_type_id. A movement referencing a request has the same employee and leave type. One business consumption/reversal key is unique and approved reservation rules apply atomically. | ZT06 ZT07 ZT16 |
| CI09 Scoped role grants | role_assignment role/company match; each role_scope_filter belongs to that assignment and exactly one correctly typed reference is populated. Deny duplicate dimension/value filters. Approved_by is the actual independent authorised actor, not a freely editable attribution field. No assignment becomes usable before approved grant creation commits. | ZT01 ZT02 ZT04 ZT05 |
| CI10 Delegated task | Task assignee equals delegation.delegate_user_id; delegator is the originally eligible reviewer; delegated permission includes task action in the same company and record scope. Role authority and delegation are checked at actual decision time; delegates cannot delegate again unless a separate owner-approved chain design exists. | ZT02 ZT04 ZT05 |
| CI11 Attachment authorisation | employee_document attachment employee matches its parent employee where employee_id is set; expense receipt attachment is authorised for the claim owner and classification. Owner_user_id alone never permits access to linked protected records. Unlinked temporary uploads remain private to authorised uploader until linkage. | ZT01 ZT02 ZT03 |
| CI12 Typed transaction ownership | For each business_transaction kind, exactly one approved typed root exists in the same company; owner_employee_id agrees with claimant/employee on that root where applicable. Finance batches and company-wide payroll runs may have no employee owner; preparer attribution still required. Terminal states cannot diverge from typed root state. | ZT06 ZT10 |
| CI13 Employment reference graph | Manager and employee are active eligible employments in the same company under the approved applicability dates. Check self/cyclic manager chains at each effective change boundary. Dated assignment and salary/shift intervals cannot overlap for a defined exclusive business key. | ZT06 ZT09 |
| CI14 Dependent process identities | training_feedback participant belongs to its training plan; settlement employee resolves through the same exit_case; timesheet line job/activity company matches timesheet and work_date lies within the period. Enforce the approved resource allocation rule before posting work. | ZT06 ZT08 ZT16 |
| CI15 Controlled statuses and codes | Create an approved state/transition catalogue per resource and controlled value category per reference field. General transaction.state uses the catalogue for transaction.kind; it is not restricted to expense-only states. Add database membership checks or typed state references so unsupported text cannot be inserted directly. Currency codes, units and rounding scales must use the approved code set. | ZT08 ZT10 ZT16 |
| CI16 Import and audit provenance | import_row.job_id and applied target share company; job accepted/rejected counts equal terminal row counts; staging/error evidence must avoid real personal values in shared reports. Audit update requires before/after snapshot and real actor, written atomically with business change; submitted immutable records cannot be changed through import. | ZT07 ZT12 ZT18 ZT19 |


Key correction: the expense_obligation uniqueness rule in B3 is enforced as UNIQUE(company_id, claim_id) for this proposed single-obligation model. An approved claim revision is immutable; changing an approved entitlement, cancelling a paid claim or reusing rejected claims requires a separately approved workflow and schema extension. These capabilities are blocked until that design is agreed, rather than implicitly handled by editing the obligation.

#### B9 Requested extension constraints and calculation boundaries

| Invariant | Required implementation check |
| --- | --- |
| CI17 Confirmation policy and action | Employee/policy/transaction/action/decision share company and employee identity. Assigned policy/start/initial due retained; extension requires valid decision and reason. Derived overdue status cannot auto-write actual confirmation. Confirmation decisions use the typed employee_confirmation root and controlled independent approval. |
| CI18 Notification occurrence and visibility | Rule/template/event/notification/attempt company and event type/channel match; template code/revision/language/channel agrees with pinned template_id. Approved placeholders have no access to unrelated protected values. Event owner/transaction revision verified. Recipient still holds required record/field authority at delivery, not only queue creation. Optional publication preferences and repeat keys apply. No secrets, age/full DOB or unrelated leave/salary facts in payloads. |
| CI19 Biometric profile run and punch | Run mapping belongs to profile, per-run observations reconcile all counters and preserve conflicting fingerprints, link date covers event instant and employee belongs to profile company. Accepted ingest punch is same employee/profile/instant/direction. Required mappings and stable key validate before activation. Namespace-scoped duplicates, conflicting fingerprints, atomic checkpoint and concurrent fetch are enforced. |
| CI20 Increment ownership and atomic application | Plan/cycle/case/history/old/new salary/component/decision share employee/company; basis and currency agree. Final approver differs from prepared_by and is not beneficiary. Current baseline rechecked inside locked effective application; one case creates one applied salary/history; same-date concurrent changes reject or enter explicitly approved merge design. |
| CI21 Annual increment reconstruction | Year/basis/currency snapshot uses approved opening/closing as-of convention and effective history, not arbitrary report creation dates. Do not aggregate percentages; no-change zero only for known comparable baseline, missing/basis/currency change yields N/A. History remains attributable after corrections; scoped report/export reconcile exactly. |


Yearly increment report is derived from immutable increment_history plus salary_arrangement; a cached output must retain filters and approval/rule context, not become a second independent salary truth. There is no fixed hard-coded three/six-month confirmation period, annual raise rate, birthday channel, API field name or increment date. These are configuration and approval decisions. New typed roots employee_confirmation and increment_case extend the exactly-one-root registry and state catalogue. Existing salary_arrangement/salary_component remain authoritative compensation snapshots; cycle definitions must state how declared basis reconciles to components.

#### B10 Requested team, dashboard and confidentiality schema

Proposed logical design only. My Team reuses employee and existing effective-dated reporting/assignment relationships; do not create a duplicate employee master. Existing role permissions and scoped assignments remain authoritative. Add role.access_class as a controlled required ADMIN/MANAGER/OTHER classification approved by the access owner, default OTHER. Only the explicitly eligible baseline roles may be classified ADMIN/MANAGER; new roles require a recorded owner decision. Common B1 id, company, actor/timestamp and version constraints apply.

##### DB 106 confidential_field_policy

Business source: requested target. Every definition requires same-company relationships, current authorization, uniqueness and auditability. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| resource_code | CODE required | Controlled business resource |
| field_group | CODE required | Controlled field/document/aggregate category |
| classification | CODE required | CONFIDENTIAL or OPERATIONAL; unknown denied |
| effective_from / effective_to | DATE required / optional | Non-overlapping active revisions |
| approved_by / approved_at | FK user_account / TIMESTAMP required | Recorded policy approval; no secret values |


##### DB 107 role_dashboard_definition

Business source: requested target. Every definition requires same-company relationships, current authorization, uniqueness and auditability. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| role_id | FK role required | Role within the same company scope |
| dashboard_code / revision | CODE / INTEGER required | Unique role/code/revision |
| title | TEXT required | Visible role dashboard label |
| state | CODE required | DRAFT, ACTIVE, RETIRED; one active definition per role/code |


##### DB 108 role_dashboard_widget

Business source: requested target. Every definition requires same-company relationships, current authorization, uniqueness and auditability. No source database definition was inspected.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| dashboard_id | FK role_dashboard_definition required | Parent dashboard |
| permission_id | FK permission required | Required resource/action grant; all field checks also apply |
| widget_code / position | CODE / INTEGER required | Unique code and deterministic order per parent |
| metric_code / field_group | CODE required | Approved controlled metric definition and classified input/output group |
| scope_rule | CODE required | Assignment-relative scope; cannot widen the parent assignment |
| display_kind | CODE required | Controlled count/list/chart/shortcut presentation |


Relationship register additions: role → role_dashboard_definition.role_id; role_dashboard_definition → role_dashboard_widget.dashboard_id; permission → role_dashboard_widget.permission_id. Each child references exactly one parent and each parent may have zero or many children; common same-company composite constraints apply. confidential_field_policy uses controlled resource/field codes, not an unvalidated arbitrary field path. role_dashboard_widget carries no executable user-entered SQL. Versioned metric definitions and classification metadata must be approved before activation.

CI22: prove confidential access requires an eligible active assignment, field permission and row scope together; cross-assignment privilege stitching fails. CI23: dashboard definitions/widgets resolve same-company parents, controlled metric and field-group codes, current permissions and non-overlapping active definitions. My Team reporting links resolve existing employee relationships without creating duplicate or cross-company employees.

Traceability additions: FR-094/095 → existing employee/reporting/history entities and permissions, plus DB106 field classification. FR-096/097 → DB107/108 and existing role/permission/assignment records. FR-098 → DB106, role.access_class and all existing delivery-surface authorization. BR-042 to BR-046 apply across these relationships.

#### B11 Assignment-level permission narrowing

##### DB 109 role_assignment_permission

Target selected in DF02. Common B1 id/company/created-updated actor/time/version columns apply. Unique assignment/permission; active grant periods lie within their assignment. Each permission must already be allowed by the role catalogue, cannot override any DENY, and must be independently approved as part of the parent grant. An empty assignment allowlist denies every action. Role action, assignment action, field classification and row scope are evaluated in the same selected assignment. This replaces any earlier assumption that a broad Admin role automatically grants all its possible permissions.

| Column | Type and requiredness | Meaning or constraint |
| --- | --- | --- |
| role_assignment_id | Ref role_assignment required | Same-company parent assignment |
| permission_id | Ref permission required | Controlled resource/action/field-group grant |
| active | BOOL required; default false | Activates only after parent independent approval |
| effective_from | TS required | At/after parent assignment start |
| effective_to | TS optional | No later than parent end where present; exclusive end |


CI24 Assignment privilege containment: every confidential read/action proves Admin/Manager eligibility, role permission, active DB109 allowlist entry and row scope in one assignment. Cross-assignment joins cannot lend grants. Synthetic Finance Admin assignment allows only expense financial review, not employee edit/salary read; expired/empty/cross-company entries deny. Traceability: FR-002/098; BR-044/046; DF02; ZT02/03/04/05/29/30. This adds a consistency check, not a claim of implemented enforcement.

### Appendix C Proposed RBAC and data visibility

RCBA is interpreted as RBAC, role-based access control. All assignments and grants here are proposed target defaults and require business-owner approval. The source application was observed only under the Administrator role. No other role or source permission settings were verified. Section 5 defines stakeholder responsibilities and the role descriptions; this appendix specifies enforcement.

#### C1 Access decision and relationship model

Decision order: authenticate active user; select company; find a currently effective active role_assignment and active role; verify an exact resource/action/field_group permission; apply all scope filters attached to that same assignment; verify OWN via user_employee_link, TEAM via effective manager_assignment, ASSIGNED via eligible current approval_task, or COMPANY via approved company grant; then enforce state and separation of duties. Allow if at least one complete eligible grant permits the action and no applicable scoped DENY or global business prohibition applies. Default is DENY. Combining the action from one assignment with the company scope from another is forbidden. A deny only applies within its matched scope; it does not silently affect unrelated companies.

Role filters constrain their parent assignment; role_permission controls actions, not employee scope. Permissions and row scope also apply to search suggestions, counts, dashboard KPIs, reports, exports, attachments and historical records. Field groups separately govern identity, HR sensitive records, salary, payment details and expense receipts. Navigation hiding is only a display rule; each data request repeats authorization. When a role or delegation expires, the next data request and decision must fail; queued output download rechecks current access.

#### C2 Role action and restriction matrix

| Role and record scope | Explicit proposed actions | Explicit restrictions |
| --- | --- | --- |
| System Administrator<br>COMPANY | Manage users, roles and configuration through approved grants All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. | No salary/payment/approval rights by default; no own grant approval Confidential fields require a separately approved field grant within this assignment’s employee scope; no organisation-wide manager bypass. |
| HR Administrator<br>COMPANY plus filters | Employee and organisation maintenance; HR records and history All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. | No payroll release or expense finance/payment approval Confidential fields require a separately approved field grant within this assignment’s employee scope; no organisation-wide manager bypass. |
| Employee<br>OWN | Own operational profile, attendance/leave balances and request states, goals/tasks, timesheets, training and expense operational lines. Own issued payslips, Form 16 and approved ESS private records are available under the H1 OWN exception; other employees’ confidential information remains denied. | No other employee rows, role changes, or any self approval Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Reporting Manager<br>TEAM and ASSIGNED | Team attendance review; assigned leave/time/appraisal and expense manager decision All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. | Salary/payment fields require eligible scoped grants; no own transaction decision Confidential fields require a separately approved field grant within this assignment’s employee scope; no organisation-wide manager bypass. |
| Payroll Operator<br>COMPANY plus filters | Salary input, calculate permitted payroll runs, view payroll records All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. Sensitive-dependent duties execute only in the independently approved eligible Admin context with DB109 narrow allowlist, never this ordinary role context. See DF02/07. | Cannot approve or release own prepared payroll Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Payroll Approver<br>ASSIGNED and COMPANY filters | Review approved inputs and independently approve/lock/release payroll All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. Sensitive-dependent duties execute only in the independently approved eligible Admin context with DB109 narrow allowlist, never this ordinary role context. See DF02/07. | No own prepared run approval; no edit of final payroll facts Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Finance Reviewer<br>COMPANY plus filters | Read financial summaries and reconcile eligible records All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. Sensitive-dependent duties execute only in the independently approved eligible Admin context with DB109 narrow allowlist, never this ordinary role context. See DF02/07. | No create/update/approve/pay permission implied Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Expense Finance Approver<br>ASSIGNED plus filters | Review receipts/policy exceptions; final line amounts; return/reject/approve All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. Sensitive-dependent duties execute only in the independently approved eligible Admin context with DB109 narrow allowlist, never this ordinary role context. See DF02/07. | No own claim approval or payment release for own approved entitlement Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Treasury Operator<br>COMPANY plus filters | Prepare allocations/instructions for approved unpaid liabilities All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. Sensitive-dependent duties execute only in the independently approved eligible Admin context with DB109 narrow allowlist, never this ordinary role context. See DF02/07. | No entitlement decision; no own prepared batch release Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Treasury Approver<br>ASSIGNED plus filters | Independent release and approved reversal All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. Sensitive-dependent duties execute only in the independently approved eligible Admin context with DB109 narrow allowlist, never this ordinary role context. See DF02/07. | No own claim payment or own prepared batch release Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Recruiter<br>COMPANY plus filters | Candidate, requisition and recruitment tracker All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. | No general employee salary/payment or expense data Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Appraisal Reviewer<br>ASSIGNED | Read and decide permitted appraisal goals/ratings All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. | No unrelated HR financial data or expense actions Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Training Coordinator<br>COMPANY plus filters | Training plans, participants and permitted feedback All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. | No salary/bank or unrelated appraisal data Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |
| Auditor<br>COMPANY plus filters read only | Approved reports, audit history and decisions All actions and information are subject to FR-098/BR-044; confidential operations listed here require an eligible assignment. | No writes, decisions, processing or payment; field masking applies Confidential access in this operational role is denied except the explicitly granted Employee OWN ESS context in H1. Other-person access still requires scoped eligible Admin/Manager grants. |


#### C3 Permission catalogue and field controls

| Resource | Separate actions requiring grants | Field or workflow restriction |
| --- | --- | --- |
| Employee | list, read, create, update, deactivate, export, read_history | Identity and HR-sensitive field groups separate; own-read fields owner-approved. |
| Salary and payroll | read_salary, input, calculate, review, approve, lock, release, export | Salary field group required; preparation and release duties separate. |
| Leave attendance time | read, draft, submit, amend, review, approve, reject, return, cancel, export | Ownership/team/task scope and state restrictions; amendments audited. |
| Appraisal training hiring | read, create, update, submit, review, approve, export | Reviewer/participant/candidate scope; sensitive feedback separated. |
| Expense | read, draft, edit_draft, submit, withdraw, manager_decide, finance_decide, view_receipt, export | Receipt access separate; claimant facts immutable after submission. |
| Payment | read_liability, prepare, release, confirm_outcome, reverse, export | Payment-detail field group; independent release; confirmation actor explicitly assigned. |
| Access administration | read_users, assign_role, approve_role_grant, revoke_role, maintain_role_permissions | No implicit grants; privileged change approved and logged, no own approval. |
| Reports audit files | run_report, export_report, read_audit, download_file | Underlying resource scope and field permissions still required; output permission cannot widen data scope. |


#### C4 Separation of duties and delegation

| Prohibition | Implementation and test expectation |
| --- | --- |
| Self approval | Deny when decision actor resolves to transaction claimant/owner employee in that company, even with another role or delegation. |
| Preparing and approving payroll | Record actual preparer; approver must differ. Membership in two roles does not override this rule. |
| Preparing and releasing payment | Prepared_by differs from release actor. Final entitlement approver cannot release the related claim payment. Batch containing any conflicting claim cannot be released until reassigned/split. |
| Own privilege grant | User cannot approve a role grant benefiting that same user; existing company scope cannot authorize an expansion beyond approved administrative scope. |
| Delegated task | Check delegator authority remains active, permission matches, delegation date valid, delegate independently eligible and no conflict. Preserve delegator, delegate and actual actor in history. |
| Changed organisation or manager | New list/read access uses current effective assignment. A task assignment does not automatically transfer to new manager; owner-approved rerouting creates new task with history. Historical financial views require an explicit history grant. |
| Role revocation during session | Every data/action request evaluates live effective assignments; stale client display, cached role or previously generated report cannot authorize access. |


#### C5 Expense approval lifecycle and stored states

These are target states, not verified vendor values. Owner approval must settle withdrawals, line exceptions, reapproval and cancellation timing before build. claim.state controls entitlement; payment_state is derived separately from the obligation ledger. business_transaction mirrors the authoritative typed root state in the same transaction.

| From and action | To and authorised actor | Data and rejection conditions |
| --- | --- | --- |
| DRAFT submit | MANAGER_PENDING; claimant | Valid positive lines, policy snapshot, required receipts, valid eligible manager; freeze revision and create instance. |
| MANAGER_PENDING approve | FINANCE_PENDING; assigned manager | No self decision; current revision; manager decision history recorded. |
| MANAGER_PENDING return or reject | RETURNED or REJECTED; assigned manager | Reason required; no payment obligation. |
| FINANCE_PENDING approve | APPROVED; assigned finance approver | Final line amounts and reasons retained; create single obligation equal to approved line sum. |
| FINANCE_PENDING return or reject | RETURNED or REJECTED; assigned finance approver | Reason required; pending tasks end; entitlement not created. |
| RETURNED revise and resubmit | MANAGER_PENDING; claimant | Create new immutable revision and approval instance; prior decisions retained and superseded. |
| DRAFT or RETURNED withdraw | WITHDRAWN; claimant | Record actor/time; owner must confirm whether submitted withdrawal is permitted; deny until decided. |
| APPROVED prepare payment | Claim remains APPROVED; treasury preparer | Reserve unpaid amount; payment batch DRAFT then READY; no over-allocation. |
| READY release | Batch RELEASED; treasury approver | Duties checked across all allocations; instruction PENDING; unique idempotency key. |
| PENDING confirmed success or failure | Instruction CONFIRMED or FAILED; authorised outcome actor | Authenticated business evidence and unique event; ambiguous outcome stays PENDING, no automatic retry. |
| Confirmed reversal | Instruction outcome retained with reversal event; authorised reversal actor | Reference confirmed event; reverse no more than net confirmed amount; reason and evidence retained. |


Derived claim payment states: NO_PAYABLE_AMOUNT when approved amount is zero; UNPAID when approved amount is positive and net paid is zero; PART_PAID when between zero and approved amount; PAID when equal to approved amount. REVERSED is an event, not an extra entitlement. Pending reservation status is shown separately and must not be counted as confirmed payment. General approval task states are PENDING, APPROVED, REJECTED, RETURNED, SUPERSEDED and CANCELLED; instance states are ACTIVE, APPROVED, REJECTED, RETURNED, SUPERSEDED and CANCELLED. All state writes use a controlled transition catalogue; invalid transitions are rejected.

#### C6 Requested capability permissions and lifecycle

| Role or permission grant | Proposed actions and allowed scope | Restrictions |
| --- | --- | --- |
| HR Administrator | Maintain approved confirmation/cycle policies, assign own company employees; propose overrides/confirmation/increments; read scoped history. | No self/beneficiary approval; increment financial amounts require salary field grant, not HR role alone. |
| Assigned Confirmation Reviewer | Review and decide assigned confirmation/extension case under an explicit confirmation_decide grant. | Reporting-manager title alone is insufficient; no self decision; no unrestricted salary or increments. |
| Payroll Operator and Payroll Approver | Operator proposes component changes; independently assigned Payroll Approver approves increment financial outcome/application under explicit increment grants. | Preparer/beneficiary cannot approve; locked payroll remains protected; no auto-release from cycle due. |
| Employee | Own confirmation dates/status and permitted history; own requested notices/preferences; own salary/increment detail only where explicit field grant exists. | No team DOB/full salary, colleague increment rates, profile credentials or approval rights. |
| Integration Administrator explicit grant | Company-filtered biometric_profile_manage, mapping_manage, employee_link_manage, sync_run and sync_exception_reprocess. | Existing System Administrator role has no implicit credential/API authority; configuration secret display separately restricted; no payroll/confirmation decision. |
| Notification Administrator explicit grant | Company-filtered rule/template maintenance and permitted delivery log; publication and mandatory notification settings require business owner approval. | No unrestricted leave reasons, DOB/age/salary access; notification permission does not widen parent scope. |
| Auditor read only | Approved history, cycle/confirmation decisions and filtered outcomes under separate sensitive-field grants. | No change/sync/reprocess/decision rights; read-only exports preserve field and company scope. |


The original 14-role baseline remains. Integration Administrator, Notification Administrator and Assigned Confirmation Reviewer are explicit grant bundles or separately approved custom roles; they do not silently add broad privileges to existing roles. Add distinct actions for confirmation_policy_manage, confirmation_propose, confirmation_decide, confirmation_history_read, notification_rule_manage, notification_delivery_read, biometric_profile_manage, mapping_manage, employee_link_manage, sync_run, sync_exception_reprocess, increment_cycle_manage, increment_propose, increment_approve, increment_apply and increment_history_read. User may hold combined grants only within C4 separation-of-duty prohibitions.

| Domain | Proposed stored state catalogue and transitions |
| --- | --- |
| Confirmation case | OPEN -&gt; REVIEW_PENDING -&gt; CONFIRMED or OPEN (approved extension creates action and new due); REVIEW_PENDING -&gt; RETURNED/REJECTED according to approved routing; CANCELLED requires explicit owner rule. Upcoming/due/overdue are derived views, not automatic confirmed states. |
| Notification | QUEUED -&gt; DELIVERED or RETRY_PENDING/FAILED; SUPPRESSED when preference/scope/rule prevents delivery; no state counted delivered without evidence. Delivery attempts keep independent outcomes. |
| Biometric run and event | Run QUEUED -&gt; RUNNING -&gt; COMPLETED/PARTIAL/FAILED; event ACCEPTED/QUARANTINED/REJECTED; repeated observations counted DUPLICATE without another canonical punch. Reprocess preserves previous outcome evidence. |
| Increment case | DRAFT -&gt; SUBMITTED -&gt; APPROVED -&gt; APPLIED; submitted review may RETURN/REJECT/DEFER or NO_CHANGE. Returned proposal new revision requires resubmission. Only approved valid case applies; scheduler never grants raise. |


#### C7 Role dashboards and overriding confidential access

Latest requested confidentiality rule (version 7.1): confidential information may be disclosed only through an active, owner-approved Admin or Manager role assignment with the necessary field permission and employee scope. Admin eligibility is limited to System Administrator and HR Administrator; Manager eligibility is limited to Reporting Manager. Other role titles are not eligible merely because they include approval or review duties. Eligibility alone grants no field access. The same assignment must provide eligible role, field grant and row scope; combining an eligible role in one scope with another role in a different scope cannot expand confidential access. This rule supersedes earlier proposed self-service, payroll, finance, treasury, recruiter, reviewer and auditor visibility wherever it would disclose confidential information. Until field classification is approved, salary, CTC, increment amounts/percentages, bank/payment/tax details, identity documents, medical details, private contact/address, sensitive leave reasons, appraisal narratives and confidential attachments are restricted. Credentials and integration secrets are never displayed as employee information. The explicit Employee OWN ESS exception in H1 permits only the listed own-record fields and issued outputs; no other implicit exception exists. For own ESS data only, apply the explicit Employee OWN exception in H1; this does not grant other-person or operational-role confidential access.

| Role | Dashboard and scope | Confidential eligibility |
| --- | --- | --- |
| System Administrator | Assigned-company configuration, access reviews and system exceptions | Eligible only with same-assignment field grant and row scope |
| HR Administrator | Assigned HR scope: workforce, confirmation, lifecycle and training due | Eligible only with same-assignment field grant and row scope |
| Employee | Own permitted attendance, leave/request status and tasks | Denied; sensitive-dependent workflow blocked pending approved reassignment/redaction |
| Reporting Manager | Current reporting team: attendance exceptions, leave decisions and review due | Eligible only with same-assignment field grant and row scope |
| Payroll Operator | Assigned payroll batch status, input exceptions and processing tasks | Denied; sensitive-dependent workflow blocked pending approved reassignment/redaction |
| Payroll Approver | Assigned payroll approval tasks and batch states | Denied; sensitive-dependent workflow blocked pending approved reassignment/redaction |
| Finance Reviewer | Assigned reconciliation exceptions and financial task states | Denied; sensitive-dependent workflow blocked pending approved reassignment/redaction |
| Expense Finance Approver | Assigned expense review tasks and claim states | Denied; sensitive-dependent workflow blocked pending approved reassignment/redaction |
| Treasury Operator | Assigned payment preparation task counts and states | Denied; sensitive-dependent workflow blocked pending approved reassignment/redaction |
| Treasury Approver | Assigned payment approval task counts and states | Denied; sensitive-dependent workflow blocked pending approved reassignment/redaction |
| Recruiter | Assigned hiring pipeline stages and tasks | Denied; sensitive-dependent workflow blocked pending approved reassignment/redaction |
| Appraisal Reviewer | Assigned appraisal task completion and review due | Denied; sensitive-dependent workflow blocked pending approved reassignment/redaction |
| Training Coordinator | Assigned training sessions, participation and due tasks | Denied; sensitive-dependent workflow blocked pending approved reassignment/redaction |
| Auditor | Approved operational/audit counts and redacted review tasks | Denied; sensitive-dependent workflow blocked pending approved reassignment/redaction |


Dashboard actions are configured separately from metric access. Payroll and finance screens showing operational state do not receive sensitive totals, beneficiary details or documents. No aggregate, receipt preview or notification may leak classified information. Only Admin and Manager eligibility is authorized by the latest request; no additional role exception is presumed.

### Appendix D Zero tolerance release acceptance

Zero tolerance means no failed mandatory gates at release. It does not claim the document or future application is error free, or that the source database has been verified. These are proposed acceptance gates requiring sponsor and module-owner sign off; they are not observed non-functional properties of the reference application. An unknown rule is a blocked decision, not a passing test. A failed gate blocks the affected release scope; the defect must be fixed and its test rerun with evidence. Removing a feature from scope requires a recorded owner decision and traceability update, not marking a failed gate passed.

#### D1 Mandatory gates and objective evidence

| Gate and invariant | Pass condition | Traceability and sign off |
| --- | --- | --- |
| ZT01 Cross-company access | For every delivered resource/action, company A user requesting company B record/list/count/export/file/history returns no B data and no successful mutation. Attempt a direct identifier bypass. | RBAC C1; composite FK B1<br>Owner: QA and access owner |
| ZT02 Own team and task scope | Two employees, two managers, expired manager link and reassigned task fixtures: only permitted own/team/current task records visible. Out-of-scope identifiers return no data. | C1 C4; user/manager/task links<br>Owner: QA and HR owner |
| ZT03 Sensitive field leakage | With no salary/payment/HR-sensitive/receipt grant, those values never appear in lists, detail, search hints, dashboards, exports or attachment responses. Test both permitted record and denied field. | C3; attachments and reports<br>Owner: QA and data owner |
| ZT04 Self decision and duties | Self claim, alternate role, delegated self task, preparer as approver and entitlement approver as payment releaser all fail with no state/payment/audit success event. | C4; approval/payment actor links<br>Owner: QA Finance Payroll |
| ZT05 Permission expiry and revocation | Grant, role, employee link and delegation expire/revoke while user remains signed in; next read/decision/export download denies access with no leaked data or side effect. | C1 C4<br>Owner: QA and access owner |
| ZT06 Orphan and tenant mismatch | Insert/update every proposed FK with missing parent or mismatched company; all reject. Referential scan shows zero orphans. Referenced historical parent deletion rejects. | B1 B3 B4<br>Owner: Senior developer and data owner |
| ZT07 Duplicate identities and replay | Duplicate employee code, transaction root, run/employee, claim/revision, event key and idempotency key reject or return the existing identical result without a second effect. | B3 natural keys<br>Owner: Senior developer and QA |
| ZT08 Mandatory and controlled fields | Missing required field, invalid reference category, negative duration/amount, invalid dates and unsupported state each reject; optional NULL is preserved distinctly from zero. | B3 and approved field dictionary<br>Owner: QA and module owner |
| ZT09 Effective history and policy match | Boundary-date fixtures select exactly one applicable assignment/policy; overlap or ambiguity rejects. Earlier records retain original policy and classification after later edits. | B1 B3 B5<br>Owner: QA HR Payroll |
| ZT10 State and revision integrity | Every allowed transition succeeds once; every other state/action combination rejects. Decision on superseded revision fails. Typed root and transaction state remain equal after commit/rollback. | C5; transaction/approval schema<br>Owner: Senior developer and QA |
| ZT11 Concurrent decision | Two simultaneous decisions against same pending task/version produce one valid terminal result and one non-success; one decision/audit/business effect only. | B5 atomic decisions<br>Owner: Senior developer and QA |
| ZT12 Immutable submission and audit | Edit submitted revision, final payroll, decision, confirmation or prior audit event is denied. Authorised amendment creates attributable before/after history; actor/time/reason present. | B5 history; audit_event<br>Owner: QA and audit owner |
| ZT13 Expense totals and policy | Owner-approved fixtures: submitted sum equals line sum; final approved obligation equals final decision sum exactly; required receipt omission and unauthorized exception reject. | B5 expense; C5<br>Owner: Finance owner and QA |
| ZT14 No duplicate or excess payment | Concurrent allocations/retries, duplicate callbacks and mixed payroll/direct payout do not increase net paid or pending reservations beyond one obligation. Paid plus pending never exceeds approved amount. | B5 conservation; payment ledger<br>Owner: Finance owner and QA |
| ZT15 Payment failure and reversal | Ambiguous result stays pending; no new live retry reservation. Definitive failure releases once. Duplicate reversal has no effect; excessive reversal rejects; outstanding reconciles exactly. | B5 and C5 payment events<br>Owner: Finance owner and QA |
| ZT16 Payroll leave and attendance calculations | All module-owner-approved normal, boundary and reversal fixtures match expected result at approved precision. Missing formula/rule version blocks affected calculation acceptance. | B5; existing BRs and DQ checks<br>Owner: Payroll HR and QA |
| ZT17 Report reconciliation | Same company/scope/period/state/revision/currency fixtures produce identical list/report/export record counts and zero monetary difference after approved rounding; pending payments excluded from paid. | B5 reports; report_execution<br>Owner: Finance Payroll and QA |
| ZT18 Rollback and notification integrity | Force failure after decision validation and before commit: no state/payment effect and no success notification. Successful retry applies once and notification recipients stay in authorised scope. | B5 atomicity; notification<br>Owner: Senior developer and QA |
| ZT19 Migration reconciliation | Fixture migration has zero rejected unexplained records, zero orphans/duplicates, exact counts and reconciled monetary balances. Every rejected row has owner-approved disposition. | B5 migrations; DQ01 to DQ15<br>Owner: Data owner and senior developer |
| ZT20 Requirements and coverage completeness | Every delivered FR and BR maps to source/proposal, owner decision, schema or explicit no-storage reason, and passing test. All 259 recorded CL items retain allowed status; unverified live items cannot be called verified. | Sections 7 to 14; Appendix A<br>Owner: Delivery owner and QA |
| ZT21 Open questions and privacy | No unresolved rule affecting delivered permission/calculation/payment/schema requiredness. Final shared artefact and evidence contain no actual credentials, technical connection addresses or real personal data; use synthetic fixtures. | Section 14; B7<br>Owner: Delivery owner and data owner |
| ZT22 Flexible confirmation | Configured day/month/override fixtures yield approved due date; extension history preserved; no date-only auto-confirmation; self/stale decision denied; confirmed actual date valid and future reminders suppressed. | FR080 to FR082; CI17; BR029 to BR031<br>Owner: HR and QA |
| ZT23 Notification correctness | Committed leave state generates correct claimant/reviewer event; rollback/wrong-state message denied; replay creates one logical notification; privacy/expiry/preference respected across channels; failed delivery bounded and visible. Provider without idempotency support not described as exactly-once external delivery. | FR083 to FR085; CI18; BR032 to BR034<br>Owner: HR access owner and QA |
| ZT24 Biometric dynamic fetch | Different configured provider fields map valid same-company punches; pagination/replay/partial-failure/concurrency counts and checkpoints reconcile; unmatched/time-ambiguous/conflicting events quarantined; no secret exposure or false absence due to fetch failure. | FR086 to FR088; CI19; BR035 to BR037<br>Owner: Integration HR and QA |
| ZT25 Increment cycle application | Eligibility/date/override fixtures yield approved roster; no implicit raise; independent approver; baseline changed/stale application denied; single atomic salary/history revision; locked payroll not silently rewritten. | FR091 to FR093; CI20; BR040 BR041<br>Owner: HR Payroll and QA |
| ZT26 Increment history percent | 100000 -&gt; 110000 -&gt; 121000 fixture shows two 10 percent changes and 21 percent annual growth, not 20. Zero/missing/non-comparable baseline yields N/A; historical salary and annual outputs reconcile exactly and field scope applies. | FR089 FR090 FR093; CI21; BR038 BR039<br>Owner: Payroll Finance and QA |
| ZT27 My Team isolation | Current-report fixtures match list, detail, filters, pagination and export; expired/unrelated/cross-company IDs disclose no records. | FR-094/095; BR-042; HR/access/QA |
| ZT28 Role dashboards | All 14 role fixtures get their approved scope and widgets; metrics reconcile; forbidden shortcuts and inference are denied. | FR-096/097; CI23; role owners/QA |
| ZT29 Confidential delivery surfaces | Every ineligible operational role and missing-grant eligible role fails confidential reads; H1 Employee OWN fixtures pass only permitted own ESS fields and issued outputs. Other-person and reviewer-private fixtures fail on every channel. | FR-098; BR-043/044; CI22; access/security/QA |
| ZT30 Role change and mixed-role isolation | Permission expiry, role switches, stale cache and queued downloads cannot retain or stitch confidential privileges. | BR-046; CI22; access/QA H1/BR-053 controls the explicit own-record ESS exception introduced in version 8.2. |
| ZT31 Concurrent capacity and burst | G1/G2 fixtures: 10 million distinct active identities, 1 million offered RPS for 2 hours, 1.5 million RPS for 15 minutes; S03 latency/error limits pass. A smaller extrapolated run is not a full-capacity pass. | NFR-S01/02/03/06; platform lead and QA |
| ZT32 Login and permission correctness at scale | 10 million distinct login flows over 10 minutes plus MFA workload; expiry/revocation/scope/field/DB109 tests pass under load, including cached and failed authority cases. | NFR-S04/08; access owner and QA |
| ZT33 Partition and transaction integrity | Hot-company, shard/cell movement, lag and concurrent decisions produce zero orphans, duplicate entitlements/payments, self decisions, stale-grant leaks or lost acknowledged writes. | NFR-S06/08; CI01–CI24; data owner/QA |
| ZT34 Failure recovery and soak | Nominal zone-loss test, regional failover &lt;=15 minutes, required RPOs, restore reconciliation and 24-hour nominal soak pass with bounded queue recovery; no dropped acknowledged outcome. | NFR-S05/07/09/11; platform lead/QA |
| ZT35 Capacity evidence and safe rollout | Measured per-unit/global capacity, dependency quotas, full workload evidence, saturation/queue metrics, topology/cost plan and staged rollback are reviewed. Untested or generator-limited capacity remains blocked. | NFR-S10/11/12; sponsor/platform/senior developer/QA |


#### D2 Developer handover and evidence checklist

Maintain one verification register with FR/BR/DQ/CL or ZT identifier, classification observed/proposed, owner-approved decision, table/column/FK reference, test fixture, expected result, actual result, evidence location, tester, review date and pass/fail/blocked disposition. This verification register is separate from the navigation Coverage Log, whose only statuses remain Documented, Restricted and Not reachable. Approval of the proposed schema and RBAC is recorded separately from confirmation of source behaviour.

| Phase | Required output and exit condition |
| --- | --- |
| Before implementation | Owners approve field requiredness, reference codes, role/action/scope matrix, state transitions, approval selection, formula examples, schema extensions and payout channel. No blocking decision for delivered scope remains unknown. |
| Before database migration | Developer supplies platform-specific DDL, FK/unique/check enforcement, indexes, transaction locking, audit strategy and reversible migration plan. QA maps constraints to ZT06 to ZT12. |
| Before user acceptance | Use synthetic multi-company/multi-role fixtures and signed module expected-results. Run positive and negative access tests for every delivered permission; reconcile all delivered reports. |
| Before release | All applicable ZT01 to ZT40 pass; no open cross-role leakage, self approval, duplicate/overpayment, orphan, missing audit, lifecycle or reconciliation defect. Sponsor and responsible owners sign acceptance and retained evidence. |
| After a rule or role change | Impact map identifies affected FR/BR, schema, outputs and ZT tests; rerun affected mandatory gates before release. Historical snapshots and earlier approved records remain reproducible. |


Design register totals: 109 proposed tables; 201 explicit business foreign keys plus common company and audit references; 14 baseline roles with explicit extension grant bundles; 40 zero tolerance release gates and 24 CI checks. Proposed design counts, not vendor schema counts. Appendix A retains 259 recorded navigation items.

### Appendix E Final handover review and build decisions

Document review updated 6 October 2026. Target business decisions selected through Appendix F under the user’s delegation. Ready for senior developer target design/implementation with explicit integration, data, technical and release dependencies. Source database/non-Administrator behaviour and implemented acceptance tests are not verified by this document.

#### E1 Review result

| Review area | Result and remaining limit |
| --- | --- |
| Structure and identifiers | 14 main sections in order; Appendix A Coverage Log unchanged. 110 FRs, 55 BRs, 15 DQ checks, 28 OQ items and 259 CL entries; 118 proposed tables and 228 explicit business references plus common actor/company references; CI01–CI30; ZT01–ZT40; 18 HD/DF topics and H extension decisions. |
| Functional requirement format | FR entries include shall wording, priority, source/classification and acceptance criteria. Requirements dependent on unconfirmed rules are proposals; owner-approved expected examples are a prerequisite to testing, not evidence of a passed test. |
| Coverage depth | 259 recorded navigation items: 258 Documented, 0 Restricted, 1 Not reachable. Documented covers recorded label/control and limitations; it does not imply every feature, role, hidden screen or safe write operation was inspected. |
| Data model consistency | 109 proposed tables and 201 explicit FK definitions plus common company/actor links. B8/B9 define parent/revision/workflow/ownership/currency checks; detailed target DDL and execution tests remain developer deliverables. Important field dictionary now contains 155 entries. |
| Permissions and expenses | 14 proposed roles and scoped permissions retained. Expense snapshots, decisions, entitlement and payment ledger are separated. Self-approval, conflicting duties and duplicate/over-allocation prohibitions are explicit; actual source RBAC remains unverified. |
| Zero tolerance | 35 release gates remain objective target acceptance checks with owners and evidence requirements. They have not been run on a new application and cannot be marked passed from this document review. |
| Sensitive content and layout | Document text checked for known credential/address patterns and real source account details; no screenshots included. Final document rendered and reviewed for readable tables and page layout. This is a document check, not a security certification. |


#### E2 Required decisions before feature implementation

HD01–HD18 are resolved for target business design through DF01–DF18 in Appendix F under the user’s delegation. The historical questions are retained for traceability. External inputs, technical design, source evidence and actual release sign-offs remain separate dependencies; the status in Appendix F controls implementation readiness.

| Decision and accountable owners | Selected target decision and implementation disposition | Traceability |
| --- | --- | --- |
| HD01 Delivery scope and source parity<br>Owner: Sponsor and application owner | Target business decision selected: DF01 in Appendix F. Delivery scope, sequencing and evidence. Implement selected rules; distinguish remaining external inputs, technical deliverables and release evidence in F4. | OQ01 OQ03; Appendix A |
| HD02 Role grants and field visibility<br>Owner: HR Finance Payroll and access owner | Target business decision selected: DF02 in Appendix F. Access, confidentiality and operational authority. Implement selected rules; distinguish remaining external inputs, technical deliverables and release evidence in F4. | OQ02 OQ14; Appendix C |
| HD03 Approval routing and states<br>Owner: HR Finance Payroll | Target business decision selected: DF03 in Appendix F. Approval routing, delegation and states. Implement selected rules; distinguish remaining external inputs, technical deliverables and release evidence in F4. | OQ06 OQ09 OQ16 OQ17; C5 |
| HD04 Field dictionary and reference lists<br>Owner: Module and data owners | Target business decision selected: DF04 in Appendix F. Employee records, fields and reference masters. Implement selected rules; distinguish remaining external inputs, technical deliverables and release evidence in F4. | OQ04 OQ10 OQ12 OQ18; B6 B7 |
| HD05 Attendance leave and payroll formulas<br>Owner: HR and Payroll | Target business decision selected: DF05 in Appendix F. Attendance, leave and payroll calculation boundaries. Implement selected rules; distinguish remaining external inputs, technical deliverables and release evidence in F4. | OQ05 to OQ09 OQ12; B5 |
| HD06 Expense policy and entitlement<br>Owner: Finance and HR | Target business decision selected: DF06 in Appendix F. Expense policies and entitlement. Implement selected rules; distinguish remaining external inputs, technical deliverables and release evidence in F4. | OQ16 OQ17; B3 C5 CI03 CI15 |
| HD07 Payout reconciliation and correction<br>Owner: Finance Treasury and Payroll | Target business decision selected: DF07 in Appendix F. Payout, currencies and reconciliation. Implement selected rules; distinguish remaining external inputs, technical deliverables and release evidence in F4. | OQ17; B5 CI03 CI05 CI06 |
| HD08 History privacy and retention<br>Owner: Data audit and business owners | Target business decision selected: DF08 in Appendix F. History, correction, deactivation and retention. Implement selected rules; distinguish remaining external inputs, technical deliverables and release evidence in F4. | OQ18 OQ19; DQ08 DQ09 DQ13 |
| HD09 Integration business mappings<br>Owner: Application and integration owners | Target business decision selected: DF09 in Appendix F. Imports, outputs and business integrations. Implement selected rules; distinguish remaining external inputs, technical deliverables and release evidence in F4. | OQ13 OQ15; Section 13 |
| HD10 Technical constraints and release evidence<br>Owner: Senior developer QA and sponsor | Target business decision selected: DF10 in Appendix F. Implementation and release verification. Implement selected rules; distinguish remaining external inputs, technical deliverables and release evidence in F4. | OQ20; Appendices B D |
| HD11 Confirmation configuration<br>Owner: HR | Target business decision selected: DF11 in Appendix F. Flexible confirmation. Implement selected rules; distinguish remaining external inputs, technical deliverables and release evidence in F4. | OQ21; FR080 to FR082; CI17 |
| HD12 Notification configuration<br>Owner: HR/access/business | Target business decision selected: DF12 in Appendix F. Notifications and privacy. Implement selected rules; distinguish remaining external inputs, technical deliverables and release evidence in F4. | OQ22; FR083 to FR085; CI18 |
| HD13 Biometric API mapping<br>Owner: Integration/HR/data | Target business decision selected: DF13 in Appendix F. Biometric configuration activation. Implement selected rules; distinguish remaining external inputs, technical deliverables and release evidence in F4. | OQ23; FR086 to FR088; CI19 |
| HD14 Annual history reporting<br>Owner: HR/Payroll/Finance | Target business decision selected: DF14 in Appendix F. Increment history and annual growth. Implement selected rules; distinguish remaining external inputs, technical deliverables and release evidence in F4. | OQ24; FR089 FR090; CI21 |
| HD15 Employee increment cycle<br>Owner: HR/Payroll | Target business decision selected: DF15 in Appendix F. Employee increment cycle. Implement selected rules; distinguish remaining external inputs, technical deliverables and release evidence in F4. | OQ25; FR091 to FR093; CI20 |
| HD16 My Team — HR/access owner | Target business decision selected: DF16 in Appendix F. My Team information and membership. Implement selected rules; distinguish remaining external inputs, technical deliverables and release evidence in F4. | OQ26; FR-094/095 |
| HD17 Role dashboards — role/reporting owners | Target business decision selected: DF17 in Appendix F. Role dashboards, metrics and actions. Implement selected rules; distinguish remaining external inputs, technical deliverables and release evidence in F4. | OQ28; FR-096/097 |
| HD18 Confidential workflow impact — sponsor/HR/finance/access | Target business decision selected: DF18 in Appendix F. Operational rollout, exceptions and remaining evidence. Implement selected rules; distinguish remaining external inputs, technical deliverables and release evidence in F4. | OQ27; FR-098; BR-044 |


#### E3 Instructions for the senior developer

Read Sections 4 and 14 for evidence limits, Section 7 for requirements, Appendix B for the proposed data model, Appendix C for enforcement and Appendix D for acceptance. Log proposed changes against FR/BR/CI/ZT identifiers. Validate the schema using synthetic fixtures and record each owner-approved rule before coding the affected workflow. A guessed vendor formula, undocumented permission, missing constraint or unapproved default is not an acceptable resolution of an open item.

Target business decisions have been selected under user delegation; actual stakeholder release sign-offs and source verification are not recorded. Implement the selected behavior in Appendix F and complete the applicable technical deliverables, external inputs and ZT acceptance evidence before enabling production operations.

#### E4 Change summary dated 6 October 2026

Version 7.1 adds all five requested capabilities through FR-080 to FR-093, BR-029 to BR-041, new field definitions, target flows/reports, restricted integration configuration, 20 proposed entity definitions and relationship links, CI17 to CI21, ZT22 to ZT26 and OQ21 to OQ25/HD11 to HD15. The user has authorised capability scope; detailed policy parameters and approval choices remain pending as specifically listed. Historical walkthrough evidence and Appendix A are unchanged because no new source walkthrough was performed. Configuration and daily birthday/anniversary/request events described here are product requirements, not automations scheduled by this document edit. No source application data or external messages were changed.

Version 7.1 change summary: adds FR-094 to FR-098, BR-042 to BR-046, OQ26 to OQ28, DB106 to DB108, CI22/CI23, ZT27 to ZT30 and HD16 to HD18 for My Team, distinct role dashboards and the latest Admin/Manager-only confidentiality restriction. Earlier sensitive access proposals are explicitly constrained. Source coverage is unchanged; database and other-role behaviour remain unverified.

### Appendix F Selected target business decisions

#### Decision authority and precedence

Selected 6 October 2026 under the user’s instruction “complete business decisions”. These are decisions for a new HRMS. They supersede earlier pending target-design wording for mapped topics; they do not change recorded source evidence, prove database extraction, certify legal rates or record stakeholder sign-offs. Values are effective-dated configuration; no default is hard-coded. Mandatory features remain required for their assigned delivery wave. Where actual external/company parameter values are absent, fail-closed activation requirements are themselves decided and listed in F4.

#### DF01 Delivery scope, sequencing and evidence

Traceability: HD01; OQ01/03; all FRs

The user has delegated selection of target business decisions on 6 October 2026. The following choices form the new-application design baseline; they are not a claim that the reference application uses these rules. Earlier wording asking for target decisions is resolved where mapped here. Actual source validation, external contracts, technical design, implementation tests and release sign-offs remain distinct activities.

Delivery wave 1: identity/access, organisation/employee records, My Team, all role dashboard shells, attendance/leave, flexible confirmation, notifications, biometric adapter and monitoring, employee history/increment cycles, general expense approvals, manual payment-outcome tracking, reports and audit. Delivery wave 2: hiring, appraisal, projects/timesheets, training, process/exit/settlement and payroll calculation/statutory outputs. Every existing FR remains in scope; sequencing does not delete a requirement. No module may claim completion before its own mapped fields and tests are implemented.

Build wave 1 now against this target baseline using synthetic fixtures. Build provider-independent interfaces and policy-driven wave 2 structures. Real biometric connections, direct transfers, automated statutory calculations/submissions and financial posting are disabled until their actual provider/rate/mapping inputs are supplied and tested. The boundary between business decisions and these external inputs must remain visible in delivery tracking.

#### DF02 Access, confidentiality and operational authority

Traceability: HD02/18; OQ02/27; FR-002/098; BR-044/046; C1/C7

Only System Administrator, HR Administrator and Reporting Manager assignments are eligible for confidential fields. System Administrator has access/configuration actions by default, with no confidential employee fields or financial approval. HR Administrator has scoped employment-lifecycle actions; payroll, financial, medical and document field groups require explicit grants. Reporting Manager has current direct-team operational access and request decisions; salary/bank/tax/medical/identity-document/appraisal-narrative access is off by default. Granting it requires independent approval and a named business purpose. Employee context has the explicitly limited OWN confidential ESS exception in H1. Other operational role contexts do not inherit this exception; the person must select Employee context for own ESS records. For own ESS data only, apply the explicit Employee OWN exception in H1; this does not grant other-person or operational-role confidential access.

Non-confidential operational fields: employee code/name, work email/extension, job title, department, work location, employment/confirmation status, joining date, manager, approved skills/training, work attendance times/status, leave type/date/day-count/status, goal names and completion flags, expense category/date/claimed and approved amounts/state. Expense operational amounts are visible only to claimant and assigned expense reviewers/payment operators; receipt attachments, bank/payment/tax identifiers and private reasons remain confidential. Private home address/contact, full birth date/year, compensation amounts/percentages, private appraisal text/ratings, medical facts, official identity documents and protected history are confidential. Payroll totals and derived salary aggregates inherit salary classification.

To carry out restricted payroll/finance/treasury duties, a person receives a separately approved HR Administrator assignment limited to the required company/employee scope and exact action/field allowlist. That assignment is selected for confidential work; another role does not lend its grants to it. DB109 supplies the assignment allowlist, intersected with role_permission, field classification and row scope. No entitlement is obtained merely by owning an Admin title. Every new assignment starts with an empty allowlist; seed only the specified role duties.

Finance/Payroll/Treasury role dashboards remain operational and non-confidential. Confidential work uses the selected eligible Admin context, with permitted workload widgets. Preparation, entitlement approval and payment release are distinct actors on a transaction. Grant preparer/approver duties to different people; never approve one’s own role grant, claim, increment, payroll result or payment. Admin status does not bypass these checks. Enforce checks on data requests, attachments, exports, notifications and history, not only menu visibility.

#### DF03 Approval routing, delegation and states

Traceability: HD03; OQ06/09/16/17; C4/C5

Leave, attendance amendments, timesheets and ordinary appraisal review route to the current direct Reporting Manager. Where the manager is missing, inactive, the beneficiary or otherwise ineligible, select a scoped HR Administrator with the appropriate decision grant from an explicit fallback list. No eligible reviewer blocks submission with a repairable routing exception; never auto-approve. Pin the effective workflow and policy revision on submission.

Default sequential quorum is one eligible decision per step. Expense always requires manager operational review followed by independent financial approval in an eligible Admin context, with a third independent payment release if payment is processed. Claimant differs from all claim approvers; final entitlement approver differs from payment releaser; preparer differs from their approver. Returned requests create a new immutable revision on resubmission. Rejected requests are terminal; a new request links to the rejected predecessor.

Reminders after 2 business days; escalation to the explicit fallback list after 5 business days without changing approval state or granting authority. Business days follow the company calendar. Delegation has inclusive start/exclusive end timestamps, maximum 30 calendar days per grant, same-company/current-record/action limits and no redelegation. Delegation cannot introduce Admin eligibility or confidential field grants; an independently eligible delegate assignment is required for sensitive work.

Common request states: DRAFT, SUBMITTED, IN_REVIEW, RETURNED, APPROVED, REJECTED, WITHDRAWN and CANCELLED; each module maps its existing explicit states to this catalogue without losing expense-specific states. Withdraw only before a final decision. Approved changes need a controlled reversal/cancellation action; financial approved entitlements cannot be edited in wave 1. All state transitions are explicit and atomic.

#### DF04 Employee records, fields and reference masters

Traceability: HD04; OQ03/04/10/12/18; FR-004 to FR-014; B7

Employee activation requires immutable company-scoped employee code, legal display name, joining date, employment type, work email, current department/designation/location, assigned shift and current reporting manager or an explicitly recorded top-level/no-manager reason. Date formats are date-only ISO calendar values; display uses the user locale. Identifiers are trimmed and case-normalised for uniqueness; retired codes are never reused. Work email is unique among active employee accounts within a company. No synthetic placeholder private information is required for activation.

Optional private fields: personal email/phone, home address, birth date, emergency contact and document references; bank/tax identifiers are conditionally required only for enabled payroll/payout processing and master maintenance requires an eligible Admin; Employee may submit/view their own allowable request fields under H1 without directly changing the master. An ordinary employee submits change requests for permitted operational fields; confidential field maintenance belongs to eligible Admins. Joining/transfer/manager/salary/confirmation changes create effective-dated history. Employee code and company transfer are not in-place edits; a new employment links to the prior one.

Employment types: PERMANENT, FIXED_TERM, INTERN, CONTRACTOR. Lifecycle states: DRAFT, ACTIVE_PROBATION, ACTIVE_CONFIRMED, NOTICE, INACTIVE_SEPARATED, ARCHIVED. Leave/attendance/payroll eligibility stops after approved last working date, while retained historical records remain scoped. Grade/department/designation/location/shift/leave/expense/document categories use controlled active reference codes with effective periods. No free-text value silently creates a master.

Wave 2 minimum form contracts: requisition(code, title, department, location, employment type, headcount integer &gt;0, proposed start date, requesting employee, reason, status); candidate(name, restricted email/phone, requisition, source code, stage, consent/retention flag); appraisal(employee, cycle, weighted goals, self/manager/reviewer scores, status, restricted comments); training(title, start/end instants, mode, owner, capacity &gt;0, participant employee/state, feedback score 1..5 and optional restricted comment); employee process(type, employee, effective date, owner, sequenced task/status); exit(employee, request date, last working date, reason code, notice policy, clearance states); loan(employee, approved principal, currency, disbursement evidence, dated recovery schedule, balance); declaration(employee, fiscal period, controlled type, declared amount, supporting restricted document, review state). Requiredness follows these contracts and conditional workflow use; platform-specific child entities must be added before the matching feature is marked built.

#### DF05 Attendance, leave and payroll calculation boundaries

Traceability: HD05; OQ05 to OQ09/12; FR-015 to FR-039/052

Company timezone default is Asia/Kolkata, configurable per company. Store punch instants with timezone offsets; date-only leave/joining values do not shift between zones. Default shift is 09:00–18:00 with a 60-minute unpaid scheduled break, Monday–Friday workdays, and no automatic overtime or salary deduction. Shift and holiday calendars are editable and effective-dated. Overnight shifts belong to the date of scheduled shift start. In/out pairs are chronological; a missing punch is an exception, not automatically absence. Grace is configurable, initial 10 minutes inclusive: 09:10 is within grace for a 09:00 start; 09:11 is late.

Default attendance threshold: counted net work &gt;=75% of scheduled net minutes is PRESENT; &gt;=50% and &lt;75% is HALF_DAY; below 50% is ABSENT only after attendance review has resolved exceptions and approved leave/holiday outcomes. Approved paid leave and non-work holidays override punch-based absence for covered segments. Late/early flags do not automatically reduce pay. Overtime requires a separate manager decision and configured approved rate before payroll inclusion. Boundaries use exact minutes; zero-duration/overlapping impossible pairs are rejected.

Leave policy contains mandatory annual entitlement per type/eligible group, paid/unpaid flag, accrual schedule, carry cap/expiry, minimum service and fraction rules. Selected initial company policy: permanent/fixed-term employees have annual paid leave 24 days, sick leave 6 days and casual leave 6 days; interns have annual paid leave 12 days, sick leave 6 days and casual leave 6 days; contractors have unpaid time-off only. Annual leave requires 90 calendar days service for use; sick/casual may be used from joining after accrual. These are selected configurable target business values, not source facts or a claim of statutory compliance. Seed policy revisions as DRAFT, require independent activation and validate applicable legal/contractual minimums before actual operation. Configured annual entitlement accrues monthly in 12 equal parts, prorated by calendar service days in the accrual month; retain 4 decimals internally, display 2 decimals. Requests are full or half days, weekends/holidays excluded, reservation on submission, consumption only on approval, release on rejection/withdrawal. Carry is zero unless explicitly configured; no negative paid balance; excess requires unpaid leave or documented HR exception. Past leave up to 7 calendar days needs manager review; beyond that requires eligible HR approval. No legal entitlement claim is made.

Payroll monthly proration: monthly fixed component × eligible paid calendar days / calendar days in that month, inclusive joining/leaving dates; paid-day segments count once. Monetary components use exact decimals; round to currency minor units with half-up at component output, then sum rounded components. Net pay = earnings + reimbursements − employee deductions; employer contributions are separate cost. Estimated in-hand is labelled an estimate; annual CTC is the sum of declared annual cost components, not an assumed gross-times-12 formula.

No jurisdictional tax, statutory contribution, gratuity, notice deduction, encashment, loan interest or exchange rate is invented. Such calculations use dated, versioned externally supplied rule packs; missing applicable mandatory inputs blocks calculation/approval. Gross/net preview may run against synthetic configured examples. Arrears are calculated from approved effective revisions and prior period paid snapshots, with unique employee/revision/period keys. Recovery cannot exceed principal plus approved interest and cannot advance on a failed/reversed payroll run. Settlement consumes approved balances once and requires separate review/release.

Payroll lifecycle: OPEN → INPUTS_VALIDATED → CALCULATED → REVIEWED → APPROVED → LOCKED. Only reviewed exceptions resolved and independent approval can lock. An authorised reopen requires independent scoped Admin approval, a reason and a superseding revision. Salary-stop default is HOLD_DISBURSEMENT; calculation continues while payment is excluded. EXCLUDE_CALCULATION is an explicitly approved exceptional stop mode. No preview, report export or period lock executes a payment.

#### DF06 Expense policies and entitlement

Traceability: HD06; OQ16; FR-070 to FR-079

Default operational categories: business travel, accommodation, meals, office supplies and other business expense. Personal expenses are ineligible. Company currency is INR for the initial policy; foreign-currency claims are disabled in wave 1. Selected initial limits: meals INR 1,000 per employee/day, accommodation INR 5,000 per night, business travel INR 5,000 per line, office supplies INR 2,000 per line and other business expense INR 1,000 per line. Claim total above INR 50,000 requires one additional independent eligible Admin high-value approver after ordinary financial review. Limits are configured, effective-dated review thresholds, not automatic payment entitlement. Exceeding/unset limits requires exception reason and final financial Admin approval; unset never means unlimited. Per-day/night grouping uses actual expense service date and declared nights with supporting evidence. Apply the policy effective on the expense date.

Expense date cannot be future; ordinary submission within 30 calendar days. Late claims and any receipt omission are flagged exceptions requiring reason and financial Admin decision. Amount must be &gt;0 with two-decimal INR precision. Receipt is normally required for every line; exception approval is separate and auditable. Receipt images/documents are confidential; Finance operational context is denied, while Employee OWN may retrieve own released files under H1; an Employee can submit and retrieve their own released receipt under H1, but cannot retrieve another person’s receipt. Sensitive document viewing is limited to eligible scoped Admin/Manager grants.

Manager may approve operational validity, reject or return; financial Admin independently approves each line from zero to submitted amount and records a reason for reduction/rejection/exception. Approved claim amount equals approved line sum; zero entitlement is a valid terminal approval with NO_PAYABLE_AMOUNT, no payment reservation. Duplicate employee/date/category/amount/receipt fingerprint generates a blocking review flag requiring documented exception; matching an external claim/reference key cannot create duplicate entitlement. Separate categories do not evade a configured aggregate limit.

Claimant sees own operational line amounts and state, not financial identifiers, private decision notes or receipt contents. Approved-entitlement editing and paid-claim cancellation are disabled in wave 1. Returned drafts may be revised before final approval with version/history. Approved-claim reversal/correction requires the later controlled adjustment design; never overwrite the original obligation.

#### DF07 Payout, currencies and reconciliation

Traceability: HD07; OQ17; B5/C5

Wave 1 records approved expense obligations and external manual payment outcomes; it does not send bank transfers or reimburse through payroll. Scoped eligible Admin preparer records a payment instruction with date/currency/amount and restricted outcome reference; an independent eligible Admin releaser confirms actual outcome from evidence. Operational claimant view contains amount/date/payment status only. The entitlement approver cannot release its payment. Failed or unknown outcomes are not PAID.

One approved claim has one obligation. Net confirmed paid = confirmed payments − confirmed reversals; outstanding = approved entitlement − net paid. Pending reservations also reduce available allocation capacity; confirmed plus pending cannot exceed approved amount. Unknown provider outcomes remain pending until reconciled; no blind retry creates another reservation. Idempotent evidence keys and reversal bounds apply. Example: approved 1,000, paid 600, reversal 100 yields net paid 500/outstanding 500; pending 300 leaves allocatable 200.

Wave 2 bank/payment provider and accounting exchanges require actual restricted contracts and configured chart mappings. Initially no currency conversion, mileage formula, advance/card liability or automated accounting posting. Accounting exports are balanced by company/period/currency and reviewed independently; downloading them does not post entries or pay claims.

#### DF08 History, correction, deactivation and retention

Traceability: HD08; OQ18/19; DQ08/09/13

Every master/transaction retains creator/updater/time/version; decisions retain actor, role assignment, reason, immutable revision and before/after changes permitted by field classification. Effective historical values are not overwritten. Corrections append attributable superseding entries and preserve original financial decisions. Employee/salary/assignment/manager histories have non-overlapping validity for exclusive keys.

Disable/deactivate referenced masters; do not physically delete employees, posted punches, approved requests, decisions or financial records. Unsubmitted drafts may be cancelled and retained; attachments unlinked from abandoned drafts follow restricted deletion review. No automatic hard-delete/purge is enabled initially. A separately documented retention schedule is required before any purge feature can run; local legal retention periods are not asserted. UI lists distinguish active/archived filters and never imply deletion merely because a record disappears.

New database consistency is verified using synthetic multi-company data and direct constraint tests. No access to the vendor database is presumed. Migration from the source is a separate delivery dependency requiring authorised source definitions and reconciliation files; target completion does not mean source parity.

#### DF09 Imports, outputs and business integrations

Traceability: HD09; OQ13/15/23; FR-009/064/086 to FR-088

Imports use published versioned templates, header/type/reference/date/currency validation, dry-run preview and row-level error reports. Employee master imports reject the entire batch if a critical identity/company/reference error exists. Attendance imports may accept valid independent events while quarantining invalid events; never partially accept a single event. Other financial/approval imports are atomic per business transaction; accepted/rejected counts reconcile. Maximum initial batch 10,000 rows and 10 MB; larger submissions split into tracked batches. Use synthetic documentation examples only.

Exports are user-initiated, constrained by selected assignment/filter/field group, include filter/period/revision/generated-time context, neutralise spreadsheet formula injection and recheck current access at download. Scheduling is disabled initially except notifications and biometric fetch. Email attachments containing confidential records are disabled; in-app authorised access only. No genuine employee information belongs in shared documentation or QA evidence.

Biometric adapter fetches every 15 minutes and performs a nightly 7-day lookback at 02:00 company local time. A single profile run holds its processing lease; it uses provider pagination until exhausted and advances checkpoint only for the successfully reconciled range. Stable event ID is preferred; otherwise fingerprint source namespace, device employee, original instant, direction and device identity. Conflicting same-key payloads quarantine. Employee mapping is effective-dated and same-company; unmatched employees and ambiguous times quarantine. Retry at 1, 5 and 15 minutes, then show failure and retain checkpoint. Failed fetch never marks an employee absent.

Allowed mappings are typed field paths plus approved parsing/code/date transforms, not arbitrary executable expressions. Required targets: employee device identity, punch instant with timezone semantics, direction or configured pairing semantics, event key/fingerprint inputs. Profile activation requires a successful synthetic/safe preview and actual restricted provider contract. Provider request/authentication/pagination settings remain dynamic and are held outside shared documents. No fingerprint/face templates are ingested.

#### DF10 Implementation and release verification

Traceability: HD10; OQ14/20; ZT01 to ZT30

Business defaults, scope and permissions are selected here under the user’s instruction; stakeholder sign-offs, source validation and implemented test results are not fabricated. Senior developer chooses platform, physical types, migrations, indexes, concurrency and deployment design in a technical decision record. Every delivered FR/BR maps to screen/action, entities/constraints, decision, positive and negative test and retained result.

All applicable 40 gates are mandatory. No outstanding confidentiality/isolation/self-approval/duplicate-payment/orphan/audit/state/reconciliation defect may be waived. Unknown external evidence is a blocked activation dependency, not a passing test. Use two companies, unrelated teams, expired assignments, mixed roles, boundary dates, concurrent decisions and replay scenarios. Release requires actual business-owner/QA acceptance after working software is reviewed.

New target quality settings, not source observations: all protected actions repeat server-side authorization; idle session 30 minutes, absolute session 12 hours; MFA required for Admin/Manager and finance-authority contexts; revocation effective on next protected request. No remembered-device bypass initially. Capacity and latency targets are now governed by NFR-S01 to NFR-S12 and Appendix G for 10,000,000 simultaneous active users. The earlier 100-user sizing example is superseded. Reports remain asynchronous and show progress if exceeding 10 seconds; these are target acceptance conditions, not measured source behavior. Core journeys work with keyboard and text indicators independent of colour. Appendix G sets capacity, resilience and verification targets; the detailed topology, costs, quotas and operations plan remain technical deliverables.

#### DF11 Flexible confirmation

Traceability: HD11; OQ21; FR-080 to FR-082

Default confirmation period is 3 calendar months from joining date, held in configuration. Company default → applicable employee-type/grade policy → independently approved employee override (highest priority). Equal-priority overlapping policies are rejected. Due date is joining date plus calendar months, clamped to destination month end. Example: joining 31 January, one-month period gives 28 February in a non-leap year. Day-based policies add the configured number of days; dates remain company-local date-only values.

Manager recommends; independent scoped HR Admin decides confirm, extend or reject recommendation. Default extension is one calendar month from current due date; maximum two extensions unless a separately recorded exception approval authorises more. Early confirmation is permitted with reason and independent approval; actual date cannot precede joining or be later than decision date. Due/overdue flags never auto-confirm or terminate an employee.

States: OPEN, REVIEW_PENDING, CONFIRMED, EXTENDED, RETURNED, REJECTED_RECOMMENDATION, CANCELLED. Confirmed/cancelled closes the active task; extensions keep full action history and recompute reminders. Notify eligible reviewers 30/7/1 days before due, on due date and weekly overdue; notify employee only operational status/date. Self decisions prohibited.

#### DF12 Notifications and privacy

Traceability: HD12; OQ22; FR-083 to FR-085

In-app notifications are the enabled initial channel. Email may be enabled for non-confidential event templates after actual service configuration and safe recipient tests; SMS/messaging/push are disabled initially. Required events: request submitted, assigned, approved, rejected, returned, withdrawn/cancelled; attendance correction decision; confirmation due/extension/confirmation; increment review due/decision; expense final decision/payment operational status; role-grant/security change and document expiry. No financial/private details are included in broadcast messages.

Birthday and work-anniversary celebration publication requires employee opt-in, default off. Publish at 09:00 company local time to active company employees who have celebration access; include name, work department and event type only, never full birth date, year, age, private contact or salary. Birthday 29 February is observed on 28 February in non-leap years; service anniversary uses original joining/service date and month-end clamp, excluding separated employments. Rehires use the new joining date unless HR explicitly approves carried service date.

Request events go to the claimant and currently assigned reviewers for their permitted context; notifications do not grant record access. Optional digest daily at 09:00; no repeated due reminder after terminal state. Queue only committed events and recheck recipient/classification/preferences at delivery. One logical event/recipient/channel/occurrence key; retries 1/5/15 minutes then FAILED. Retry attempts are auditable; no promise of exactly-once external service delivery without provider support. Mandatory task/security notices cannot be opted out of in-app; optional celebration/email digest can.

#### DF13 Biometric configuration activation

Traceability: HD13; OQ23; FR-086 to FR-088; CI19

Provider-independent mapping, employee links, fetch scheduler, checkpoint/idempotency, typed validation and quarantine/reprocessing behavior are fully specified by DF09. Integration administration is an action bundle granted to an independently approved Admin assignment; no secret values in dashboard/export/log. A safe test preview cannot apply attendance events.

Actual provider authentication, request/pagination syntax, quotas and data samples must be supplied privately by the device owner before the connection is activated. These are integration inputs, not guessed business rules. Source contract version is pinned per mapping revision/run; changing it requires preview and revision activation. Manual approved correction remains available during outages without destroying original punch evidence.

#### DF14 Increment history and annual growth

Traceability: HD14; OQ24; FR-089/090; BR-038/039

Primary comparable basis is monthly gross fixed pay in a single currency; basic/CTC/component views are separate bases. Per-change percentage = (after−before)/before ×100 for positive comparable baseline. Use exact decimals, display percentage to 2 decimals half-up. Zero/missing baseline, basis change or currency change yields N/A with reason, never assumed 0 percent.

Default annual reporting is financial year 1 April–31 March, with an optional calendar-year filter. Opening amount is the last approved effective salary immediately before the period starts; closing is approved salary effective at period-end, including changes on the last day. Annual growth = (closing−opening)/opening ×100, not summed change percentages. Include decrements as negative, no-change as zero only with known comparable snapshots. Example 100,000 →110,000 →121,000 gives 10 percent per event and 21 percent annual growth. Correction retains original/superseding records; report selects the approved effective chain.

Timeline preserves employee joining, transfers, reporting/grade/location changes, confirmations/extensions, salary revisions and separation; each event links its source decision. Operational timeline categories are visible by scope; salary amounts/percentages and confidential before/after facts are eligible Admin/Manager-only.

#### DF15 Employee increment cycle

Traceability: HD15; OQ25; FR-091 to FR-093

Default cycle is annual with 1 April effective date. Review opens 1 January, roster freezes 31 January and ordinary decisions complete by 15 March. Eligibility: active confirmed employment, joining date on/before prior 30 September, no approved separation before effective date and completed required appraisal where that module is enabled. Notice-period employees are excluded by default. Missing eligibility evidence is excluded with reason and repair path, not treated as approval. Anniversary-based cycles and employee-specific overrides are supported through effective policies.

Manager proposes a new amount and reason; independent eligible scoped Admin with increment financial grant approves. There is no guaranteed rate, automatic annual raise or fixed merit percentage. No-change, deferred and rejected decisions are explicit outcomes. Off-cycle changes need HR Admin proposal and a different financial Admin approver with reason. Review due reminders at 30/7/1 days before closing.

Approved change applies on the approved effective date after rechecking baseline version/currency/basis in one transaction with salary history and case state. Current baseline changed while pending requires resubmission. Existing locked payroll is preserved; retroactive difference creates an approved arrears case, rather than reopening/overwriting it by default. Cycle definition, policy assignment and changes retain effective history.

#### DF16 My Team information and membership

Traceability: HD16; OQ26; FR-094/095; BR-042

Default team is current direct reports only. Indirect/recursive team visibility is disabled initially and is an explicit future scope change, not a hidden default. Membership follows effective manager_assignment plus active employment in the same company, includes probation/confirmed/notice employees through last working date and excludes separated/archived employees from current lists. Manager changes revoke old-team access on the effective boundary; prior transactions do not grant unrestricted historical employee access.

Team list columns: employee code/name, department, designation, location, manager, joining date, employment/confirmation status, today’s attendance status and next actionable review date. Filters: employee/name/code, department, location, status and due-review range; paginated 25/50/100 rows, default 25. Search includes permitted work email/extension. Counts and export reflect identical membership and filters.

Detail tabs: Work Profile, Employment and Reporting, Attendance, Leave, Skills and Training, Goals/Tasks, History. Confidential tabs: Compensation and Increment History, Private Information and Documents, enabled only for the specific field group grant. Attendance and leave detail excludes private reasons; history masks protected before/after data. Show empty data states distinctly from not-authorised tabs, without revealing restricted counts. A delegated reviewer can access only assigned transactions unless an independent team assignment exists.

#### DF17 Role dashboards, metrics and actions

Traceability: HD17; OQ28; FR-096/097; C7

Dashboard displays selected role assignment, company/scope, reporting period and refreshed-at time. Default date is today for attendance, current month for operational tasks and selected payroll/cycle period for batch reviews. Refresh on load/action; prefer scope-safe invalidation/subscription for changes. When polling is used, refresh visible widgets at a minimum 60-second interval with independent jitter, pause background tabs and coalesce requests; manual refresh is rate controlled. Authorization is checked on every protected response, regardless of caching or widget freshness. Rendering/query scope cannot widen the selected assignment. Zero means no eligible records; denied widgets are omitted, not shown as zero; retrieval failure is a visible unavailable state.

Widget definitions in F2 below are the selected initial catalogue. Counts are distinct authorised records, pending means current actionable task in an active instance; overdue means pending with due date &lt;company-local today. Employee count excludes draft/separated/archived records; attendance exceptions count unresolved reviewed-day records, not missing fetch results. Expense payable status sums only permitted operational entitlement figures in current assignment, excluding confidential bank identifiers. Salary totals and derived compensation metrics require Admin/Manager eligibility and field grant.

Every widget links to source lists with the same filters; action button is shown only when the current assignment permits the destination action/state. Layout: top scope/period bar, four summary cards, priority task list, recent operational activity and shortcuts. No personal layout override may add a permission. Approved Admin assignments carrying payroll/finance duties may show the corresponding permitted task widgets in Admin context; no merging across role assignments.

#### DF18 Operational rollout, exceptions and remaining evidence

Traceability: HD18 plus HD01/10; OQ19/27/28

The 18 HD decisions now map to selected target business policies DF01–DF18. A decision being selected does not mean source behaviour verified, stakeholder sign-off recorded or QA passed. Record actual selected values, scope, activation dependencies and revisions in configuration; rule changes must rerun affected gates.

Remaining evidence categories are restricted biometric/service contracts, actual statutory/rate packs and activation of the selected/configured company policies, authorised migration extracts, platform-specific detailed schema/migrations, implemented acceptance results and deployment approvals. None is replaced by an invented value. These block the affected integration/calculation/production activation, not independent development of approved target workflows. Defaults may be tested with synthetic values explicitly tagged as fixtures.

If later requested functionality contradicts the selected confidentiality or actor-separation policy, raise a change decision rather than silently weakening it. The document is suitable for senior developer implementation of the selected target behavior; it is not a certified vendor clone or a guarantee of zero defects.

#### F1 Selected supporting wave 2 process rules

Hiring: requisition requester → direct manager validation → HR Administrator budget/headcount approval. Requisition states DRAFT/SUBMITTED/APPROVED/REJECTED/CLOSED; candidate stages APPLIED/SCREENING/INTERVIEW/OFFER/HIRED/REJECTED/WITHDRAWN. An offer requires approved requisition and independent eligible Admin approval for confidential compensation. Recruiter sees operational pipeline; candidate private contacts/documents require eligible scoped Admin assignment. Hiring creates a reviewed employee draft, never auto-activates employment.

Appraisal: financial-year cycle, goal weights sum exactly 100; each goal self/manager score is integer 1..5. Weighted manager result = sum(weight × manager score)/100, displayed 2 decimals. Employee sees own goal names and completion/task status; ratings/comments remain confidential under DF02. Manager rates then an independent assigned eligible reviewer confirms. One reviewer step is the default; configured second step must be explicit. No forced distribution/bell-curve target. Returns create revision; upload creates DRAFT and never silently substitutes for human approval. Unexplained source visibility/upload values are not copied into new rules.

Timesheets: project has many jobs, job belongs to exactly one project, reusable activity catalogue is linked through approved job activities. Work date must fall within employment and active allocation. Daily total &lt;=24 hours; quarter-hour entry increments; expected capacity follows shift/calendar, with &gt;100% allocation blocked unless manager records an approved exception. Weekly Monday–Sunday submission by following Monday, manager review, locks on approval. Corrections need independent authorised reopen with history. Utilisation = approved productive hours / scheduled eligible work hours ×100; zero denominator yields N/A. No billing or payroll monetary effect initially.

Training: FUTURE if now &lt;start, CURRENT if start &lt;=now &lt;=end, PAST if now &gt;end; CANCELLED overrides date grouping. One employee participation per session; capacity enforced at nomination confirmation. States NOMINATED/CONFIRMED/ATTENDED/COMPLETED/NO_SHOW/CANCELLED. Feedback score 1..5 after completion, comments restricted. Coordinator sees plans and operational completion, no protected feedback narratives.

Exit and employee processes: HR-controlled checklist templates with ordered task owners and explicit required/optional tasks; no skipped required clearance at final release. Employee can submit a resignation operational request; manager recommends last working date, HR Admin approves. Notice period is a configured contractual field required for any monetary notice adjustment, with no guessed default rate. Approved last working date is inclusive. Withdrawal before final approval is allowed; after approval requires HR independent decision and history. Full-and-final calculation requires actual approved policy/rate packs, independent review and release; no automatic gratuity/encashment assumption.

Outputs: employee register and team list reconcile to effective employment/reporting links; attendance/leave outputs reconcile to approved day and movement records; annual increments reconcile to effective salary chain; expense paid/outstanding reconciles to obligations and net outcome ledger; payroll/JV/statutory outputs require approved period/rule pack and independently checked templates. New output contracts use plain employee codes, dates, categories, states and totals as permitted; restricted columns are omitted under selected assignment, not masked only after retrieval.

#### F2 Initial role dashboard catalogue

| Role | Initial four widgets | Permitted shortcuts |
| --- | --- | --- |
| System Administrator | Active accounts; Pending independent access grants; Failed integration runs; Failed notification deliveries | Only granted source lists/tasks; confidential work requires selected eligible Admin/Manager assignment and DB109 allowlist |
| HR Administrator | Active employees; Confirmation due within 30 days; Missing required employee activation data; Assigned HR tasks | Only granted source lists/tasks; confidential work requires selected eligible Admin/Manager assignment and DB109 allowlist |
| Employee | Today attendance status; Own leave balance/status; Own pending requests; Own training/tasks due | Only granted source lists/tasks; confidential work requires selected eligible Admin/Manager assignment and DB109 allowlist |
| Reporting Manager | Current direct team count; Unresolved team attendance exceptions; Assigned leave/expense tasks; Team confirmations/reviews due | Only granted source lists/tasks; confidential work requires selected eligible Admin/Manager assignment and DB109 allowlist |
| Payroll Operator | Open payroll periods; Input-validation exceptions; Assigned preparation tasks; Period calculation state | Only granted source lists/tasks; confidential work requires selected eligible Admin/Manager assignment and DB109 allowlist |
| Payroll Approver | Assigned payroll review tasks; Overdue review tasks; Approved/locked batch counts; Unresolved batch exception counts | Only granted source lists/tasks; confidential work requires selected eligible Admin/Manager assignment and DB109 allowlist |
| Finance Reviewer | Reconciliation task counts; Unreconciled outcome counts; Assigned expense review tasks; Operational expense states | Only granted source lists/tasks; confidential work requires selected eligible Admin/Manager assignment and DB109 allowlist |
| Expense Finance Approver | Assigned final expense decisions; Late/receipt exception counts; Returned claim counts; Decision due tasks | Only granted source lists/tasks; confidential work requires selected eligible Admin/Manager assignment and DB109 allowlist |
| Treasury Operator | Assigned payment preparation tasks; Pending outcome counts; Definitively failed outcome counts; Reservations needing reconciliation | Only granted source lists/tasks; confidential work requires selected eligible Admin/Manager assignment and DB109 allowlist |
| Treasury Approver | Assigned independent release tasks; Overdue release tasks; Confirmed/reversed operation counts; Unresolved outcome tasks | Only granted source lists/tasks; confidential work requires selected eligible Admin/Manager assignment and DB109 allowlist |
| Recruiter | Approved requisitions; Operational pipeline stage counts; Interview tasks due; Offers awaiting eligible Admin review | Only granted source lists/tasks; confidential work requires selected eligible Admin/Manager assignment and DB109 allowlist |
| Appraisal Reviewer | Assigned appraisal tasks; Submitted/reviewed counts; Overdue review tasks; Returned appraisal counts | Only granted source lists/tasks; confidential work requires selected eligible Admin/Manager assignment and DB109 allowlist |
| Training Coordinator | Current/future training sessions; Confirmed participation count; Completion/no-show counts; Feedback pending count without contents | Only granted source lists/tasks; confidential work requires selected eligible Admin/Manager assignment and DB109 allowlist |
| Auditor | Permitted redacted audit-event count; Operational exception counts; Review evidence tasks; Configuration revision count | Only granted source lists/tasks; confidential work requires selected eligible Admin/Manager assignment and DB109 allowlist |


Financial roles never show salary/bank/tax/receipt contents in their ordinary role dashboards. Assigned Admin financial context can show confidential task data only where explicitly granted. Leave balance visible to Employee is operational days, not medical reason or compensation value. Current company-configured entitlement is a prerequisite to a numeric balance; before configuration show “Policy not active”, not a fabricated zero balance.

#### F3 Worked acceptance fixtures

| Fixture | Expected result | Requirements/gates |
| --- | --- | --- |
| Manager M1 has current E1, former E2 and unrelated E3; Finance user has operational role only | M1 sees E1 operational details only; E2/E3 inaccessible; Finance role cannot fetch salary or confidential receipt | FR-094/095/098; ZT02/29 |
| Admin finance assignment allows expense final decision but lacks employee_edit and salary_read | Expense assigned review passes; employee change and salary requests fail; another role cannot supply missing grants | DF02; CI24; ZT03/30 |
| Confirmation starts 31 January, one calendar month; later extension one month | Due 28 February (non-leap); extension due 28 March; no automatic confirmation | FR-080/082; ZT22 |
| Annual leave entitlement synthetic 24 days; full month service; request 0.5 day | Monthly accrual 2.0000; submit reserves 0.5; approve consumes 0.5 once; rejected request releases reservation | DF05; ZT16 |
| Expense submitted lines 600 +400; approvals 500 +300; manual confirmed payment 600 | Approved obligation 800; net paid 600; outstanding 200; at most 200 further reservation | FR-070 to FR-079; ZT13/14/17 |
| Synthetic fixed monthly gross 30,000; 15 eligible paid calendar days in a 30-day month; no deductions | Prorated component 15,000.00; any required missing deduction rule pack blocks final calculation approval | FR-032/033; ZT16 |
| Increment 100,000 →110,000 →121,000, same currency and basis | Event changes 10.00%/10.00%; annual growth 21.00%; no summed-percent result | FR-089/090; ZT26 |
| Biometric response repeats event then returns altered payload with same key | Identical repeat deduplicated; altered payload quarantined; counters/checkpoint reconcile; no false absence | FR-086 to FR-088; ZT24 |
| Role revoked after confidential report queued | Subsequent dashboard/detail/export download denied; no sensitive payload delivered | FR-098; ZT05/30 |


#### F4 Remaining dependencies — distinct from chosen business rules

| Dependency | Needed before | Disposition |
| --- | --- | --- |
| Operating company configuration: activate selected leave/expense defaults or record a reviewed effective override; enter actual contractual notice values and reference masters | Activation of the affected paid-leave/expense/notice policy | Workflow and initial leave/expense values selected in DF05/06. Validate contractual/jurisdictional applicability and independently activate revisions; actual contractual notice/reference values remain operating inputs. Unset never means unlimited/zero entitlement. |
| Applicable dated statutory/tax/contribution/settlement rates and output templates | Real payroll/statutory/settlement calculation or submission | External factual input; must be obtained and validated for actual jurisdiction/period. No rate fabricated; synthetic fixtures do not authorize live calculation. |
| Actual biometric/notification/payment/accounting contracts and restricted configuration | Connecting the affected live integration | Provider-dependent technical evidence; business mapping/failure behavior selected. Real connection details stay outside shared files. |
| Authorised anonymised source schema/data extracts and role walkthroughs | Migration/source-parity certification | Source verification remains unperformed; not required to code the selected new-application workflow with synthetic data. |
| Platform-specific child schema, DDL, exact constraints, migrations, indexes and test implementations | Completion of the affected technical module | Senior developer deliverables; expand minimum form contracts and preserve business invariants. No source schema certification claimed. |
| Actual ZT01–ZT40 results and stakeholder acceptance | Production release of corresponding scope | Release evidence remains unexecuted; no fabricated approval or pass. Unknown external dependencies block affected activation, not independent target coding. |


#### F5 Decision completeness and handover status

All 18 HD topics and all 28 OQ topics have a target-policy, phasing or external-evidence disposition. The chosen business rules are sufficient for senior developer target architecture and incremental implementation. Required company/provider/statutory inputs and technical schema expansions remain visible in F4; therefore this is not an unconditional full-module production-release approval. Existing source Coverage Log is unchanged. No reference application action or external notification was performed during this revision.

#### F6 Parameter and boundary implementation notes

Daily work threshold examples for an 8-hour net shift: 360 minutes is PRESENT; 240 through 359 is HALF_DAY; below 240 is ABSENT only after exception/leave/calendar review. Grace controls the late flag independently of net-work status and does not automatically deduct salary. Working minutes covered by approved leave/holiday cannot also count as absent. Annual/sick/casual entitlements use the DF05 monthly accrual rule with minimum-service use restrictions; no annual entitlement is hard-coded into code or copied as a vendor rule.

High-value expense example: total submitted INR 50,000 uses manager plus independent financial Admin review; INR 50,000.01 requires the additional distinct high-value Admin approver. Determine this route from immutable submitted total, not reduced approved total, to prevent routing bypass. The last entitlement decision actor is excluded from payment release. Review threshold exceptions require reason and independent financial authority; no claimant may approve an exception. Source application remains unchanged.

### Appendix G Architecture and verification for ten million concurrent users

#### G1 Capacity definitions and arithmetic

Concurrency is the number of distinct authenticated people whose simulated or actual journeys are active at the same time. Each has its own correct role/assignment/company context. An active user generates one business request every 10 seconds on average, including think time and response time, giving 10,000,000 /10 =1,000,000 business requests/second. This is a selected load model, not observed traffic. Ten million requests arriving at one exact instant, or ten million requests/second, are different scenarios and are not claimed by this model. If actual journeys require more traffic, revise throughput and test it rather than silently reducing user activity.

| Quantity | Selected sizing value | Interpretation |
| --- | --- | --- |
| Concurrent active identities | 10,000,000 | All are individually authenticated and issue protected requests |
| Mean business-request interval | 10 seconds/user | Includes think and response time; not 10 million continuously in-flight requests |
| Nominal offered business throughput | 1,000,000 requests/second | Includes foreground dashboards/session polling; worker/provider calls counted separately |
| Burst offered business throughput | 1,500,000 requests/second for 15 minutes | Same concurrent identities with temporarily increased activity |
| Login storm | 10,000,000 identities over 600 seconds | 16,666.67 completions/second minimum; target provision 20,000 login flows/second |
| Payload planning assumption | Mean 2 KB request and 10 KB response | Payload distributions must include large-page/file outliers; size limits enforced |
| Illustrative ingress and response volume | 2 GB/second ingress; 10 GB/second response at nominal load | Derived before transport/replication overhead; not a price or actual measurement |
| Internal dependency traffic | Explicitly measured amplification per request | Cache misses, authorization, database, search, event and worker calls are not hidden behind the business RPS count |


The earlier 60-second dashboard polling pattern alone could produce about 166,667 refresh cycles/second if all 10 million users watch a dashboard; multiple widget calls multiply that number. Coalesce widgets, stagger refresh times and pause hidden tabs. The one-million-RPS model already includes foreground refresh traffic; do not double-count it. Authentication bootstrap is a separate test; ordinary session/refresh requests in the steady-state mix are measured separately from genuine login flows.

#### G2 Workload and data fixture

| Dimension | Initial representative fixture | Proof requirement |
| --- | --- | --- |
| Operation mix | 50% scoped dashboard/list reads; 20% own attendance/leave/profile reads; 10% team/task/report-status reads; 15% submissions/amendments/decisions; 5% session/notification metadata traffic | Totals 100%; vary 50% write-heavy stress separately. Approval and financial fixtures use distinct actors and valid states. |
| Role distribution | 90% Employee; 5% Reporting Manager; 2% HR Administrator; 1% System Administrator; 2% split across remaining ten baseline roles | All 14 roles issue positive and negative protected requests; test eligible financial work in the correct scoped Admin context. |
| Company skew | 10,000 companies; one company 10% of active users/traffic; nine companies 2% each; remaining 9,990 share 72% | Large-company and hot-record scenarios cannot be hidden by uniform random traffic. |
| History fixture | 50 million accounts, &gt;=10 million active employment records; 12 months attendance aggregates for active employees; representative punches, leave, task and effective history; 7-year history cohort of 100,000 employees | Materialize or generate indexed representative records and document actual counts; 12 months at 10 million employees implies billions of daily records. No claim that in-memory toy rows prove storage-scale capacity. |
| Documents and outputs | Metadata for &gt;=10 million synthetic documents, scanned-file sizes 100 KB/1 MB/10 MB, concurrent export/job workload | Do not put binaries in hot relational rows; expose only authorised metadata/downloads; generator and storage quotas measured. |
| Cache/session fixture | Cold/warm cache runs, independent per-user scope, expiry/revocation, session rotation and user changes | Caching must not substitute a shared Admin token or bypass current scope/field checks. |
| Special peaks | Shift-start attendance ingestion; payroll month end; policy changes; mass opt-in celebrations; login burst; synchronized dashboard refresh | Test bounded parallelism, idempotency and competing foreground/background traffic. |


#### G3 Architecture responsibilities

##### Traffic and application serving

Use geographically appropriate routing, balanced ingress and horizontal stateless request workers. Deliver public static assets through a content cache; confidential API/file responses are not public-cache entries. Request processing must not require a permanent database connection or dedicated process per user. A logged-in session is not automatically an open socket; notification connections are optional and separately capacity-tested.

##### Bounded deployment cells

Partition workloads into independently provisioned serving units with measured safe limits and isolated worker/cache/data capacity. Determine user/company-to-home-cell routing once from a controlled directory and keep authorization scoped. Cells grow by adding tested units; do not assume a single machine, one global write database or arbitrary microservice count achieves this target. If one large company exceeds a cell’s safe capacity, an explicitly designed intra-company partition plan is mandatory.

##### Data placement and relationships

Partition heavy attendance/history/notification/payroll records by approved company/employee/date boundaries with relevant indexes and bounded pagination. Place each transaction root, immutable revision, approval decision, obligation/outcome and audit write in a transactionally consistent owner partition. There must be one authoritative writer for a record and controlled fenced failover. Read replicas/search projections cannot decide stale approvals, expose revoked grants or become independent financial truth.

##### Foreign keys across partitions

Retain every Appendix B relationship and CI invariant. Colocated children use physical constraints. A relationship crossing physical partitions requires a documented alternative with authoritative reference validation, pinned reference revisions, deletion restrictions and reconciliation tests; ordinary event-driven eventual consistency alone does not prove zero-orphan or authorization correctness. Move partitions through a verified copy/catch-up/fenced cutover protocol with identity, company, count and monetary reconciliation. No physical sharding choice may silently remove the 201 relationships or same-company checks.

##### Authorization and cache safety

Intersect current role permission, DB109 assignment allowlist, eligible confidentiality class and row scope in one assignment. Cache keys bind company/user or safe scope group, selected assignment, permission/policy version, filters and field classification. Revocation must become effective on the next protected request; if current authority cannot be established during replication lag/partition/failover, fail closed. Check fresh workflow state and assignment in the authoritative decision transaction. Shared caches and generated output links are never an authorization grant.

##### Background processing

Use durable, bounded work queues for payroll runs, notifications, biometric pages, export/report jobs and file processing. Preserve transaction/outbox commit behavior, deduplication and backpressure. Admission acceptance must indicate whether work is queued or completed. Apply per-company fairness and separate critical decisions from bulk report/celebration traffic. Batch notification recipients and authorised history reads; avoid an all-employee scan per event.

##### Failure domains and observability

Plan multiple failure zones and regional recovery with independent backups, protected secrets, least-privilege operations, request identifiers and privacy-safe telemetry. Size the surviving deployment for the target traffic after declared failures; autoscaling cannot be assumed instantaneous. Monitor resource saturation, offered/completed rates, worker backlog, database lock/replication pressure, auth failures and cost per completed business transaction. Region/zone recovery targets require measured evidence, not a topology drawing.

##### Engineering deliverables

Senior developer and platform lead provide the service/data topology, routing/partition keys, transaction boundaries, capacity per serving unit, physical constraints, connection pools, timeout/retry budgets, dependency quotas, replica/failover design, observability plan and cost model. Framework and provider selection remain technical design decisions; a particular language, cache or orchestration product does not guarantee 10-million-user support.

#### G4 Measurement and test stages

Build a reusable workload harness that creates unique identities, scope fixtures and correct workflow states. Use distributed generators with verified network/CPU/memory capacity and provider quotas; if generators cannot produce the offered target or maintain correct identities, the test is blocked. Use open-loop arrival scheduling to reveal delays rather than lowering offered RPS when the application slows. Record both scheduled/offered and actually received requests, outcome/latency distributions and rejected/dropped attempts to avoid coordinated omission.

Test stages: single-unit saturation and safe limit; 10,000 users; 100,000; 1 million; 5 million; full 10 million. Each gate must pass before moving up. Intermediate passes guide tuning and funding but cannot be labelled a full ten-million-user pass. Prove cell limits and global directory/routing/auth/session/shared-service limits, including largest-company skew.

At full scale, hold 10 million users/1 million offered RPS for 2 hours, run a separate 15-minute 1.5 million-RPS burst, and run a 24-hour nominal soak. Nominal load for 24 hours implies 86.4 billion offered business requests; budget and test-data generation must account for that, including durable write/audit volume. Run cold cache, simultaneous login, mass refresh, representative worker jobs and failure/restore scenarios; retain cohort results rather than pooled averages.

Inject a zone loss at nominal traffic and verify the remaining capacity meets the nominal latency/error limits after a documented failover transition. Simulate regional loss and prove recovery within 15 minutes plus reconciliation of every acknowledged financial/approval/audit result with zero loss. Failover intervals count in monthly availability. Replica/session uncertainty must not produce successful unauthorised work. Run restore tests against sampled and complete critical ledgers.

Continuous failure/soak runs verify connection/memory growth, bounded retry behavior, idempotency, queue drain and signed-in revocation. Test two reviewers deciding the same item, provider duplicate callbacks, payment reservations, imports and shard movement under load. Integrity failures are zero tolerance regardless of aggregate response performance.

Test reports include exact build/schema/policy revisions, topology and instance counts, data counts/skew, role/action mix, arrival schedule, offered versus completed rates, generator health, per-operation/region p50/p95/p99, timeout/5xx/throttle counts, auth outcomes, DB pools/lock/lag, worker queues, failure windows, monetary/count reconciliation, resources and cost. State PASS/FAIL/BLOCKED for each applicable gate; no capacity certification from arithmetic or architecture prose alone.

#### G5 Capacity evidence and release conditions

Target user count is user-requested. The request intervals, throughput, mix, dataset and response/recovery objectives are initial declared sizing assumptions chosen for an actionable engineering plan. Compare them with real user journeys before procurement; revisions require recorded capacity-decision changes and repeated tests. Do not reinterpret concurrent users as total registered users or artificially lengthen user think time to claim success. User-count/request-rate/payload/storage dimensions remain independently tracked.

No benchmark, production topology, dependency quota agreement, monthly availability record or budget approval is supplied by this document. The senior developer can begin capacity-aware design; a system may be advertised or released for the ten-million-user target only after the corresponding G4 and ZT31–ZT35 evidence passes. A smaller funded deployment may be delivered only with an explicit smaller certified limit and a separate scope decision, never by marking the target gate passed.

Design references checked 8 October 2026: AWS Well Architected guidance on bounded cells and workload isolation; Microsoft Learn high-scale load-test guidance on independent user/request counts, parallel generators and generator health. These support general architecture/test patterns, not this HRMS capacity. Source titles only are retained here to preserve the document’s prohibition on technical addresses.

### Appendix H Payroll locking and Employee Self Service

#### H1 Scope decisions and precedence

These six additions are requested target scope dated 8 October 2026. H overrides conflicting earlier target statements for payroll locking and ESS own-record access only; F remains the selected business baseline elsewhere and G remains the scale specification. Earlier discovery requests for confirmation do not reopen selected F/H defaults. Vendor source behavior, unseen ESS tabs and live database enforcement remain unverified. No reference application changes were made.

Employees may access only their own issued payroll/tax outputs and permitted private ESS records through an explicit Employee OWN assignment. Admin/Manager eligibility and DB109 narrowing still govern access to other people’s confidential records. No role grants itself confidentiality merely by a title. Salary/rating/identity data about other people is not introduced into My Team or ordinary role dashboards.

#### H2 Payroll states and business journeys

| Dimension | States and rule |
| --- | --- |
| Calculation run | DRAFT → CALCULATED → IN_REVIEW → APPROVED → PROCESSED_LOCKED. Validation/review return goes to a new draft revision before processing. CANCELLED is allowed only before processing with authority and reason. Processing freezes input/rule/result/bank revisions and commits audit atomically. No processed unlock. |
| Payment per allocation | READY, HELD, RESERVED, SUBMITTED, UNKNOWN, CONFIRMED, FAILED, CANCELLED, REVERSED. State transitions preserve allocation ledger; no confirmed payment is erased. Calculation lock is independent of payment outcome. |
| Timesheet adjustment | DRAFT → SUBMITTED → APPROVED → APPLIED; RETURNED and REJECTED require revision/new request; VOID is permitted before application with approval; applied reversal is a new linked adjustment. |
| Sensitive change | DRAFT → SUBMITTED → IN_REVIEW → APPROVED → SCHEDULED/APPLIED; RETURNED, REJECTED, WITHDRAWN and CONFLICT. Approved application is atomic and effective-dated. Conflict needs rebase and renewed approval; no silent overwrite. |
| Hold case | PROPOSED → APPROVED_ACTIVE → RELEASED or EXPIRED_REVIEW. REJECTED never blocks an allocation. Review expiry alerts reviewers and does not automatically pay, forgive or delete liability. |


Payroll journey: select period → collect approved eligible input revisions → calculate and validate → independent review/return → approve → process and freeze → assess approved holds and payment safety blocks → validate bank template and current allocation ledger → create draft preview → independently authorize final manifest and reserved allocations → download restricted file → submit through separately authorized channel → reconcile explicit outcome evidence → publish permitted outputs. Failed validation has a recoverable exception list and no partial final file. Allocation preparation/release actors must differ, and users never approve their own results or salary holds.

Late-timesheet journey: missed submission produces reminder and pending exception; later submission identifies original service dates → eligible manager approves → compare corrected eligible units to frozen recognized units → create unique adjustment revision → independent payroll reviewer approves amount and explanation → apply to first eligible unprocessed period, including off-cycle/final-settlement run when no ordinary payroll remains → freeze once included. If the intended upcoming run has already processed, route to the next eligible open run and expose deferral reason. An unresolved policy/rate/currency question blocks adjustment approval, not a guessed deduction. Negative recovery requires an activated applicable recovery policy and authorization; default is review, with no automatic negative net salary.

| Hold criterion | Selected default and authority |
| --- | --- |
| Invalid/unverified/missing approved bank instruction | Automatic payment safety block with reason; eligible Admin verifies an approved bank revision and independently releases instruction. Earned salary remains payable. |
| Employee payroll-input discrepancy | Validation exception before processing; payroll approver records resolution. Not an automatic salary hold. |
| Missing timesheet | Reminder and unresolved exception only. Approved later timesheet produces next eligible payroll adjustment; no automatic hold, loss-of-pay or zero salary. |
| Specific business/contractual hold | Disabled until company activates a validated criterion with applicability, full/partial scope, evidence and maximum review interval. Maker proposes; independent authorized eligible Admin decides; beneficiary is never decision maker. |
| Legal/disciplinary direction | Disabled until applicable direction/policy evidence and eligible independent authority are supplied. Separate hold reason, amount and review/release conditions; no assumed legal right to withhold. |
| Separation/inactivity | Eligibility and final settlement follow effective service dates. Existing earned liability is retained and not automatically held or erased. |


Selected operational defaults: payroll calendar defines an explicit service period, cutoff and payment date; no dates are hard-coded. Hold review reminder is daily, first escalation after 2 business days and subsequent review every 5 business days while unresolved. Policy may narrow these values through approved versioning. Partial hold is disabled unless activated; when enabled hold amount must be &gt;0 and no greater than currently unpaid/unreserved entitlement. Release creates a new payment allocation for outstanding held liability and never recalculates or rewrites the original salary run.

#### H3 All requested Employee Self Service tabs

| Target ID and tab | Section | Employee scope and actions |
| --- | --- | --- |
| TN01 My Profile | Personal | Own approved profile and employment summary; permitted own private fields; salary changes only appear through issued outputs/history grants. |
| TN02 Personal details change request | Personal | Draft, attach evidence, submit, view return/rejection/approval and effective application; no direct master edit. |
| TN03 Bank change request | Personal | Own approved masked bank summary; submitted full fields limited to owner and eligible reviewers; evidence, approval and cutoff warning. |
| TN04 Address change | Personal | Own current address and proposed effective revision; independent approval required. |
| TN05 Document upload | Personal | Own categorized files, verification status and expiry; quarantine/scan/review states. |
| TN06 Payslip | Financial | Own published period/revision payslip; restricted preview/download; distinguish earned, held and paid amounts. |
| TN07 Form 16 | Financial | Own issued tax-year certificate and authorized replacement versions; format requires actual applicable statutory template. |
| TN08 Tax declaration | Financial | Own fiscal-period draft/submission/review and cutoff; selected regime/categories only from active rule pack. |
| TN09 Investment proof | Financial | Own declaration-linked categorized evidence, reviewer status and accepted/rejected amount; no automatic tax relief. |
| TN10 Leave | Time and Requests | Own balance, requests, calendar, decisions and cancellation under active policy. |
| TN11 Attendance | Time and Requests | Own reviewed attendance/punch summary and sync exception status; imported punches read-only. |
| TN12 Regularization | Time and Requests | Own attendance correction request with dates, reason/evidence and decisions. |
| TN13 Timesheet | Time and Requests | Own period entry/submission/approval, missed reminders and linked later-payroll adjustments. |
| TN14 Expense | Time and Requests | Own draft/submitted claims, operational approvals and payment status; existing two-step entitlement plus independent payout controls. |
| TN15 Loan/advance | Financial | Own request, terms, independent decisions, disbursement evidence and recovery schedule/balance; no self-approval or schedule edits. |
| TN16 Assets | Time and Requests | Own assigned items, issue/return history and acknowledgment; custody request only, no write-off/transfer approval. |
| TN17 Training | Development | Own enrollment, assigned sessions, attendance/completion and feedback entry as permitted; no falsified completion. |
| TN18 Appraisal | Development | Own goals, self-entry/submission and published employee-visible result where expressly authorized; private manager/reviewer notes and others’ ratings remain denied. |


Target tabs are specifications, not observed navigation evidence. Each tab has a loading/empty/error/unavailable state and an own-record context indicator. Approval status, pending owner and permitted decision history are shown without exposing private reviewer commentary. Module disabled state cannot link to an unauthorized admin screen. Payroll/finance staff use their Employee context for their own ESS tabs; their operational context retains prior restrictions.

#### H4 Fields and sensitive change workflow

| Field or group | Type requiredness default | Validation and dependency |
| --- | --- | --- |
| Change request type | Controlled code required; no default | PERSONAL, ADDRESS or BANK; selected immutable category after submission. |
| Employee and company | Required reference, server derived | Bound to current authenticated Employee OWN employment; ignore tampered supplied ownership. |
| Base revision and effective date | Required revision reference and DATE; proposed date defaults company-local today | Recheck current version on approval/application; past dates require authorized correction and cannot alter locked payroll; scheduled application must still have valid approval. |
| Proposed personal/address values | Typed field dictionary; at least one changed allowable field | Country-specific address fields use active reference formats; optional private values remain optional unless activated policy requires them; no arbitrary key/property updates. |
| Proposed bank values | Holder name, account identifier and country/bank-specific routing reference required as applicable; no default | Template/provider-specific length and checksum validation; identifiers stored as text preserving leading zeros; no real values in logs/tests. Approved evidence and reviewer grants required. |
| Reason and supporting evidence | Reason required bounded text; evidence conditionally required by activated change policy | Bank and identity-sensitive changes require verified evidence; attachments pass type/size/scan rules. Approval reason required; rejection/return include employee-visible explanation separately from private notes. |
| Bank upload template | Version, currency, required fields, column order, encoding, delimiter, date/amount precision, totals/control records required | Template activation requires bank-accepted specification and independent sample validation; no universal format presumed; no endpoints/credentials in shared files. |
| Upload category and file | Controlled category required, document required | Initial configured limit 10 MB/file; allow PDF/JPEG/PNG, scanned only; stricter category/provider override versioned. No executable/active upload content; failed scan quarantines. This is a target policy, not observed behavior. |
| Hold case | Reason code, employee, payroll record, currency, positive amount, effective/review dates, policy version and evidence required | Conditional linked approval transaction; full holds derive amount from outstanding eligible liability. Separate hold and release decision maker from beneficiary/preparer. |
| Adjustment case | Original period, source revision, prior/corrected units, signed difference, currency and rule snapshots required | Target run optional until allocation; positive/negative sign retained. Zero difference is recorded no-op with explanation, not duplicate payable line. |


Sensitive-change journey: Employee enters permitted proposed values → validates and uploads evidence → submits immutable revision → eligible independent HR reviewer verifies request/evidence → return/reject or approve → compare base master version and effective date → conflict/resubmit or atomically append master revision/history → notify employee of permitted outcome. Bank revisions after cutoff warn employee and cannot silently replace frozen instruction details. Sensitive employment/salary/role changes are restricted Admin workflows, with independent approvals, not employee change categories.

#### H5 Proposed database additions and relationships

All additions have stable id, company_id, created_at/by, updated_at/by, row version and applicable effective/audit metadata under existing conventions. Currency amounts use exact decimal rules from baseline; dates are date-only, event times retain timezone semantics; identifiers are text. References below are explicit business references, separate from common company/actor references. All parent-child joins enforce same-company identity and employee ownership where applicable. Delete is restricted for referenced financial/approval/evidence rows. Typed root additions PROFILE_CHANGE and PAYROLL_HOLD and TIMESHEET_ADJUSTMENT extend business_transaction.kind with one-to-one child/root matching; no polymorphic arbitrary strings.

##### DB 110 payroll_hold

reason_code required controlled; policy_revision required immutable; hold_amount MONEY &gt;0; currency required; state required default PROPOSED; proposed_at/review_due_at required; approved/released instants conditional; release_criterion/evidence required. Unique transaction_id; ledger allocation cannot exceed payable balance.

| Column | Type and requiredness | Relationship constraint |
| --- | --- | --- |
| employee_id | Reference; required | payroll_hold.employee_id → employee.id; same company; employee/run ownership checked |
| payroll_record_id | Reference; required | payroll_hold.payroll_record_id → payroll_record.id; same company; employee/run ownership checked |
| transaction_id | Reference; required | payroll_hold.transaction_id → business_transaction.id; same company; employee/run ownership checked |


##### DB 111 payroll_adjustment

source_revision and original period required; previous_recognized_units/corrected_units QTY; delta_amount MONEY signed; currency/rule_snapshot required; state default DRAFT; target/applied refs optional until application. Unique effective source revision/origin/adjustment kind; transaction unique; an applied case has exactly one target line, with reversal as new linked correction.

| Column | Type and requiredness | Relationship constraint |
| --- | --- | --- |
| employee_id | Reference; required | payroll_adjustment.employee_id → employee.id; same company; employee/run ownership checked |
| source_timesheet_id | Reference; required | payroll_adjustment.source_timesheet_id → timesheet.id; same company; employee/run ownership checked |
| origin_payroll_record_id | Reference; required | payroll_adjustment.origin_payroll_record_id → payroll_record.id; same company; employee/run ownership checked |
| target_run_id | Reference; optional until applicable lifecycle | payroll_adjustment.target_run_id → payroll_run.id; same company; employee/run ownership checked |
| transaction_id | Reference; required | payroll_adjustment.transaction_id → business_transaction.id; same company; employee/run ownership checked |
| applied_payroll_line_id | Reference; optional until applicable lifecycle | payroll_adjustment.applied_payroll_line_id → payroll_line.id; same company; employee/run ownership checked |


##### DB 112 bank_file_template_revision

template_code/version/currency/format definition required; state DRAFT/ACTIVE/RETIRED; active_at conditional; sample_validation evidence required for ACTIVE. Unique company/template/version. Immutable after activation; exact ordered mapping and control totals configured.

##### DB 113 payroll_bank_batch

batch_revision/currency/state/count/total_amount/content_hash/private_file_ref required when generated; state DRAFT/VALIDATED/AUTHORIZED/ISSUED/CANCELLED. Prior reference optional; same-run, no cycles; unique run/template/revision. Preparation and independent release audit required; issued content immutable.

| Column | Type and requiredness | Relationship constraint |
| --- | --- | --- |
| run_id | Reference; required | payroll_bank_batch.run_id → payroll_run.id; same company; employee/run ownership checked |
| template_revision_id | Reference; required | payroll_bank_batch.template_revision_id → bank_file_template_revision.id; same company; employee/run ownership checked |
| supersedes_batch_id | Reference; optional until applicable lifecycle | payroll_bank_batch.supersedes_batch_id → payroll_bank_batch.id; same company; employee/run ownership checked |


##### DB 114 payroll_bank_line

line_sequence and allocation_key unique in batch; payable_amount &gt;0/currency required; hold optional for release link only. bank snapshot frozen; reservation and external outcome linkage use controlled payment ledger, not mutable file status. A held allocation is never included before approved release.

| Column | Type and requiredness | Relationship constraint |
| --- | --- | --- |
| batch_id | Reference; required | payroll_bank_line.batch_id → payroll_bank_batch.id; same company; employee/run ownership checked |
| payroll_record_id | Reference; required | payroll_bank_line.payroll_record_id → payroll_record.id; same company; employee/run ownership checked |
| hold_id | Reference; optional until applicable lifecycle | payroll_bank_line.hold_id → payroll_hold.id; same company; employee/run ownership checked |
| bank_revision_id | Reference; required | payroll_bank_line.bank_revision_id → employee_private_profile_revision.id; same company; employee/run ownership checked |


##### DB 115 employee_sensitive_change_request

category required; base_revision required; proposed_effective_date required; typed proposed_payload required encrypted/protected per technical policy; reason/evidence/status required; status default DRAFT. Unique transaction; supersedes optional, same employee/category, no cycle; preserve immutable submitted revisions.

| Column | Type and requiredness | Relationship constraint |
| --- | --- | --- |
| employee_id | Reference; required | employee_sensitive_change_request.employee_id → employee.id; same company; employee/run ownership checked |
| transaction_id | Reference; required | employee_sensitive_change_request.transaction_id → business_transaction.id; same company; employee/run ownership checked |
| supersedes_request_id | Reference; optional until applicable lifecycle | employee_sensitive_change_request.supersedes_request_id → employee_sensitive_change_request.id; same company; employee/run ownership checked |


##### DB 116 employee_private_profile_revision

revision/category/effective_start required; effective_end optional; approved protected profile/address/bank payload; source request optional only for authorized audited initial migration. Unique employee/category/revision; non-overlap active approved intervals; bank records referenced by outputs are immutable.

| Column | Type and requiredness | Relationship constraint |
| --- | --- | --- |
| employee_id | Reference; required | employee_private_profile_revision.employee_id → employee.id; same company; employee/run ownership checked |
| source_request_id | Reference; optional until applicable lifecycle | employee_private_profile_revision.source_request_id → employee_sensitive_change_request.id; same company; employee/run ownership checked |


##### DB 117 employee_issued_output

kind PAYSLIP/FORM16; period/version/publication_state required; state default DRAFT; issued_at/authorized_publisher/content_hash required for ISSUED; payroll ref required for payslip, optional for annual tax output; document required. Unique employee/kind/period/version; replacements retain prior issued artifact and explicit supersession metadata.

| Column | Type and requiredness | Relationship constraint |
| --- | --- | --- |
| employee_id | Reference; required | employee_issued_output.employee_id → employee.id; same company; employee/run ownership checked |
| payroll_record_id | Reference; optional until applicable lifecycle | employee_issued_output.payroll_record_id → payroll_record.id; same company; employee/run ownership checked |
| document_id | Reference; required | employee_issued_output.document_id → employee_document.id; same company; employee/run ownership checked |


##### DB 118 payroll_payment_event

Append-only instruction events: RESERVED, SUBMITTED, UNKNOWN, CONFIRMED, FAILED, CANCELLED, REVERSED. event_key/company unique; amount/currency/event_time/evidence required; sequence unique per instruction. Reversal reference optional except REVERSED, must point to confirmed same-line/company/currency event, cannot exceed unreversed confirmation, no cycle. Independent outcome authorization required; duplicate evidence cannot add another confirmed amount.

| Column | Type and requiredness | Relationship constraint |
| --- | --- | --- |
| bank_line_id | Reference; required | payroll_payment_event.bank_line_id → payroll_bank_line.id; same company; employee/run ownership checked |
| reverses_event_id | Reference; optional until applicable lifecycle | payroll_payment_event.reverses_event_id → payroll_payment_event.id; same company; employee/run ownership checked |


Payroll payment events use DB118 and are separate from expense-claim outcome tables; expense-only foreign keys must not be reused for salary instructions. Authorizing an issued manifest creates RESERVED events atomically with its lines. Aggregate pending reservation plus net confirmed plus active held allocations cannot exceed each record payable amount. Definitive cancellation/failure releases reservation; UNKNOWN does not. Confirmed net paid is confirmations minus authorized reversals; file generation/download is not confirmation. All transitions compare current ledger version under the authoritative transaction; changed hold/bank/output state invalidates draft authorization. Retain canceled/replaced files and events, with no overwrite. Unique company-wide allocation keys bind the same logical instruction; new release allocation has a distinct reviewed key and bounded outstanding amount.

Existing DB036 payroll_run adds cutoff/policy/rule/approved-input snapshot identifiers, processed_at/by and lock_version, required once processed. DB037 payroll_record adds bank_revision_id → employee_private_profile_revision.id (conditional until valid bank revision; a payment without it is blocked), immutable bank snapshot, earned/payable totals and linked liability. Payment status/holds/paid totals are derived from the separate outcome/hold ledger, not overwritten calculation totals. DB070/071 timesheet revisions link service dates and approval evidence to adjustments. Existing payroll expense obligations continue to exclude double direct/payroll reimbursement under DF07.

Extension reference count: 26 business references in DB110–DB118 plus DB037.bank_revision_id =27. Combined logical total 201+27=228. Existing 109+9=118 tables. Output/form/loan/tax child contracts still require platform-specific expansion before implementation; these counts are not a claim of complete executed vendor DDL.

| Integrity ID | Area | Testable invariant |
| --- | --- | --- |
| CI25 | Payroll freeze | Atomic lock commit and immutable snapshot; unauthorized update/delete/reprocess fails; correction references original without rewriting it. |
| CI26 | Timesheet adjustment | Same employee/company/origin period; source revision unique; delta reconciles recognized difference; one applied line and no duplicate consumption across runs. |
| CI27 | Hold and payment balance | Held/reserved/confirmed allocations cannot overlap or exceed payable amount. Release decreases held allocation only with attributable decision; pending outcome cannot be repaid. |
| CI28 | Bank manifest | Same run/template/currency; every line references authorized approved employee bank revision; row count/control total equals included READY allocations; replacement cannot duplicate exposure. |
| CI29 | Sensitive revision application | Submitted payload immutable; independent reviewer; master base-version compare; effective dates non-overlap; apply exactly once or return CONFLICT with no master write. |
| CI30 | Own output and file authority | Issued owner/company/period/hash binding; no shared cache, download link or crafted identifier can bypass current OWN scope, classification, scan/publication rules. |


#### H6 Access and acceptance gates

| Actor context | Allowed scope | Denied |
| --- | --- | --- |
| Employee OWN | All H3 enabled own tabs; permitted own issued outputs/private entries; draft/submit allowable requests and upload own evidence | Other employee data; direct protected master writes; own approval; reviewer-private notes; salary/role edits; bulk other-person export; payroll/bank file generation. |
| Reporting Manager | Current direct-team operational timesheet/leave review and assigned regularization/expense decisions; confidential other-person values only if explicitly independently granted | Bank change approval by default, payroll payment approval, self decisions or inherited unrestricted private team fields. |
| Eligible HR Admin narrow assignment | Assigned personal/address/bank review and approved application with field/action allowlists | Own sensitive-change approval; financial duties without separate grants; arbitrary company scope. |
| Eligible payroll/treasury Admin assignments | Scoped payroll calculation/approval/process, hold decisions, bank preparation/release and reconciliation with independent actors | Self approval; processed result edit; unilateral hold waiver; payment success inferred from download; confidential access outside assigned duties. |


| Gate | Required evidence |
| --- | --- |
| ZT36 Processed payroll lock | Attempt edits/rerun/master backdating after processing: frozen amounts/inputs/bank snapshots unchanged; pre-processing return allowed; failed process leaves no partial lock. |
| ZT37 Late timesheet correction | Submit late revision twice and approve concurrently; correct original-period delta appears once in eligible future run; original run unchanged; missing timesheet alone never creates hold/deduction. |
| ZT38 Hold and bank output | Full/partial/safety hold cases, independent release, invalid row, duplicate generation/replacement, unknown outcome and confirmed payment fixtures reconcile liability/reservations; held/paid lines absent from final new file. |
| ZT39 ESS completeness and ownership | All 18 tab cases include own-record positive, unrelated-company/employee negative, unavailable module and issued-output tests; private reviewer data denied; cached/output links reauthorize. |
| ZT40 Sensitive change approval | Bank/address/personal edits cannot mutate master without independent approval; version conflicts, future dates, payroll cutoff, scan failures and replay tested; history remains attributable. |


These add five gates to ZT01–ZT35, giving 40. CI25–CI30 extend CI01–CI24, giving 30. FR099–FR110 extend 98 requirements, giving 110; BR047–BR055 extend 46 rules, giving 55. Existing 259 source CL entries, 28 OQ and 18 HD/DF topics remain historically identified; H contains selected extension decisions and explicit external dependencies rather than fabricated source validation.

#### H7 Reports notifications and reconciliation

| Output | Business purpose and consistency |
| --- | --- |
| Payroll freeze register | Company/period/run/revision, processing/approval actors/times, snapshot references, earned totals and lock state; confidential export eligible Admin only. |
| Held salary report | Earned liability, active hold reason/amount, age/review due, release evidence, reserved/confirmed/outstanding totals; employee sees own permitted reason/status, never internal private legal notes. |
| Later-period adjustment report | Original timesheet/service/run revision, recognized and corrected units, approved difference, upcoming run/application/reversal history; reconciles payroll lines without rewriting original output. |
| Bank output manifest | Template version, revision/hash, run, included count, currency total, excluded hold/error summary, release and outcome evidence; restricted file never placed in Employee or ordinary Manager dashboard. |
| ESS output register | Own issued payslip/Form16 period/version/publication and payment-state distinction. Replaced certificates/documents retained and clearly labeled. |
| Notifications | Missing timesheet reminder, approval return/decision, adjustment approval/application, employee-visible hold/release, bank change cutoff, payslip/Form16 publication, scan/request conflict. In-app committed-event messages with current recipient authority; email contains no bank values/salary/private documents. |


#### H8 Activation dependencies and handover

Before live payroll, supply activated company payroll calendar, service valuation/attendance policy, actual statutory packs and recovery/hold applicability. Before final bank output, supply accepted bank-format contract, independent validated sample and actual payment acknowledgment/cancellation/outcome semantics. Before Form 16 issue, validate actual applicable tax-year template and authorized publication. Prior F4 dependencies and full-scale G tests remain required. No live payroll, transfer, statutory submission, source migration or employee notification is authorized by this document update.

Ready for senior developer target design and incremental implementation. Production release requires implemented CI/ZT/FR evidence, business-owner acceptance, technical operating plan and separate deployment authorization; this revision does not assert passed tests or measured capacity.
