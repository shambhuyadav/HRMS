# 02 Completeness Inventory

Each identifier is counted once. Cross-references are not counted as new items.

| Item | BRD count | Ranges / basis | Notes |
|---|---|---|---|
| Functional requirements | 110 | FR-001–FR-079 (core + expense), FR-080–FR-093 (6 Oct additions), FR-094–FR-098 (My Team/dashboards/confidentiality), FR-099–FR-110 (v8.2 Appendix H: payroll locking, ESS) | FR-061–FR-063 are "Should"; all others "Must" |
| Business rules | 55 | BR-001–BR-028, BR-029–BR-041, BR-042–BR-046, BR-047–BR-055 (Appendix H) | BR-044 overrides earlier visibility except the explicit H1/BR-053 Employee OWN ESS exception |
| Data quality checks | 15 | DQ-01–DQ-15 | Applied to new entities as well (§9.5) |
| Open questions | 28 | OQ-01–OQ-25, OQ26–OQ28 | All dispositioned in Appendix F |
| Coverage Log entries | 259 | CL-001–CL-259 | 258 Documented / 0 Restricted / 1 Not reachable (CL-219) |
| Proposed tables | 118 | DB001–DB105 (B3), DB106–DB108 (B10), DB109 (B11), DB110–DB118 (H5) | See note A |
| Explicit FKs | 228 | B4 register (201) + H5 (26 in DB110–DB118 and DB037.bank_revision_id) | Plus common company_id / created_by / updated_by on every tenant table (not counted) |
| Baseline roles | 14 | §5 / C2 | Plus grant bundles: Integration Admin, Notification Admin, Assigned Confirmation Reviewer (not new baseline roles) |
| Zero-tolerance gates | 40 | ZT01–ZT40 | ZT22–26 new capabilities; ZT27–30 team/dashboard/confidentiality; ZT31–35 scale; ZT36–40 payroll lock, late timesheet, hold/bank output, ESS ownership, sensitive change (H6) |
| Consistency checks | 30 | CI01–CI30 | CI17–21 (B9), CI22–23 (B10), CI24 (B11), CI25–30 (H5) |
| Handover decisions | 18 | HD01–HD18 | Map 1:1 to DF01–DF18 |
| Important field entries | 155 | §9.2 | Master prompt cites 134; BRD E1 says 155. **Discrepancy logged (CR-001)** |
| NFRs (scale) | 12 | NFR-S01–S12 | Target, not observed |
| Evidence records | 17 | E01–E17 | |

## Note A – table count reconciliation
B3 numbers DB001–DB105 in sequence. Rows DB086–DB105 are the 20 tables added for the 6 Oct capabilities. B10 adds 106–108 and B11 adds 109. The B4 register also references `role.access_class` (a column, not a table). The 109-table total matches the BRD's own figure. B7 notes that payroll statutory, loan schedules, candidate personal data, competency masters, process steps, clearance tasks, letter templates and outdoor/work-on-holiday transactions **need extra child tables** that are not among the 109. These are tracked in the implementation plan as "schema extensions pending field dictionaries".

## Discrepancies found while reading (to the change record)
| ID | Finding | Proposed handling |
|---|---|---|
| CR-001 | Important-field count: 134 (prompt) vs 155 (BRD E1) | Use the actual §9.2 rows as the source of truth; recount during build |
| CR-002 | The BRD repeats the confidentiality paragraph under the label "version 7.1"; the prompt calls it the v8.1 rule | Same text, so treat it as one rule (BR-044) |
| CR-003 | C6 grants the Employee own salary/increment detail "where explicit field grant exists"; BR-044/DF02 deny all own confidential reads | BR-044 wins (stated precedence). C6 own-salary grant is void. **v8.2 update:** H1/BR-053 now permit a narrow Employee OWN ESS exception (own issued payslip/Form 16, permitted own private profile values, own change submissions/documents, own released receipts, own loan/tax records); own salary detail is still not directly readable (TN01: only through issued outputs/history grants) |
| CR-017 | Runs 1–24 used BRD v8.1 text; the owner-designated baseline is `HRMS_AI_Developer_Master_Prompt (3).md` = v8.2 | v8.2 adopted on 25 Oct 2026; delta reconciled from run 25 (see 00_README version note) |
| CR-018 | H5 names the sensitive-change typed root PROFILE_CHANGE, but `profile_change` is already the kind of the earlier operational profile requests (FR-059, I-11) | The DB115 root uses kind `sensitive_change` (I-18); both request types stay distinct |
| CR-019 | §3 lists "asset issue/return" among optional areas requiring a scope decision, while v8.2 FR-110 (Must) and H3 TN16 ask for own assigned assets, history and acknowledgment | A minimal asset register serves TN16 only (custody, acknowledgment, custody requests; no valuation, depreciation or write-off by employees); wider asset management still needs the owner's scope decision |
| CR-004 | C6 lets Payroll Approver approve increments; DF15 requires an eligible scoped Admin with increment financial grant | DF15 wins. Payroll Approver role context cannot approve; work runs in an eligible Admin assignment |
| CR-005 | B3 says the attendance_punch key "replaces the narrower source_kind-only key" | Implement the profile/namespace-scoped key only |
| CR-006 | DB083 notification has `channel` and `idempotency_key` as required, but pre-existing legacy notifications have none | Legacy path must also supply a channel and key; there is no legacy data in the new system, so enforce NOT NULL |
| CR-007 | BR-044 lists "increment amounts/percentages" as confidential, while DF12 notifies "increment decision" | The notification must carry only the state, never an amount or percentage |
| CR-008 | DB016 `approved_by` is "required", but FR-067 needs a PENDING proposal stored before its independent decision | `approved_by` is nullable only while PENDING; ACTIVE requires it; approver ≠ beneficiary ≠ requester (migration 0001) |
| CR-011 | DF05 states attendance thresholds as % of scheduled net minutes; B3 DB023 has present_minutes/half_day_minutes; B3 DB024 requires ≥1 mapping dimension | `present_percent`/`half_day_percent` columns; a company-wide mapping (no dimensions) allowed with lowest specificity (migration 0008) |
| CR-012 | DF05 leave eligibility is by employment type; B3 DB030 maps grade/location only | `employment_type_id` added as a mapping dimension (migration 0007) |
| CR-013 | Half-day leave + partial presence has no BRD rule | ≥ half-day % worked → HALF_DAY_LEAVE; otherwise EXCEPTION for review (never ABSENT) |
| CR-014 | DF11 lists EXTENDED/RETURNED/REJECTED_RECOMMENDATION as case states | Recorded as confirmation actions + `last_outcome`; case returns to OPEN with its due date (migration 0009) |
| CR-015 | DF11 precedence uses employee type; DB086 has grade/location only | `employment_type_id` added to confirmation_policy |
| CR-016 | DF14 primary basis is monthly gross; B3 DB034 holds annual_ctc only; DF05 forbids deriving CTC as gross × 12 | `salary_arrangement.monthly_gross` added; increment proposals state the counterpart figure explicitly (`proposed_counterpart`) (migration 0011) |
| CR-010 | A rejected grant proposal needs a terminal state; DB016 defines only PENDING/ACTIVE/REVOKED | Rejection sets REVOKED with a mandatory decision reason; audit action REJECT distinguishes it from a revocation (migration 0005) |
| CR-009 | BR-044 limits ADMIN to System/HR Administrator and MANAGER to Reporting Manager | Enforced as a CHECK on `role.code`; widening needs a new migration, which serves as the recorded owner decision |
