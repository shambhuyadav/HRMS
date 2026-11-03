# HRMS – Project Planning Pack (First Response)

Baseline: **HRMS BRD v8.2 (8 Oct 2026)** — `HRMS_AI_Developer_Master_Prompt (3).md`, versioned in the project as `docs/source/HRMS_AI_Developer_Master_Prompt_v8.2.md` (SHA-256 prefix ac183bea8a3bac93). This is the only requirements source.
Prepared: 24 Oct 2026; baseline corrected 25 Oct 2026. Planning items below were written as **PROPOSED**; implementation status is in 04/06/08.

> Version note (CR-017): runs 1–24 were built from BRD v8.1 text supplied in the first session message. On 25 Oct 2026 the owner confirmed `HRMS_AI_Developer_Master_Prompt (3).md` (v8.2) as the sole baseline. v8.2 adds Appendix H (payroll locking, holds, bank files, 18 ESS tabs, sensitive changes), FR-099–FR-110, BR-047–BR-055, DB110–DB118 (+DB037.bank_revision_id), CI25–CI30, ZT36–ZT40, and the H1/BR-053 Employee OWN ESS exception; everything else is unchanged in substance. Run 25 onward reconciles the build to v8.2.

| File | Content |
|---|---|
| 01_scope_and_evidence.md | Observed vs proposed vs excluded vs blocked |
| 02_completeness_inventory.md | Counts of FR/BR/DQ/OQ/CL/tables/FKs/roles/ZT/CI/HD, reconciled |
| 03_decision_register.md | OQ01–OQ28 and HD01–HD18 → DF, module, owner, build dependency |
| 04_implementation_plan.md | Module order, deliverables, test evidence, timeline |
| 05_architecture_decision_record.md | Proposed stack and platform choices (pending approval) |
| 06_traceability_register.md | FR-001–FR-098, BR-001–BR-046 → module, tables, permissions, gates |
| 07_register_templates.md | Empty templates: schema constraint, access matrix, verification, navigation coverage, change record |
| 09_capacity_plan.md | Capacity plan (Appendix G3 deliverables): cells, partition keys, cross-partition FKs, cache safety, budgets, failure domains, G4 stages, cost inputs; ZT31–ZT35 BLOCKED (not run) |

## Ground rules carried from the BRD
- Source app observed under the Administrator role only. Proposed schema/RBAC are **not** extracted source facts.
- Appendix F (DF01–DF18) is the controlling target decision baseline. Do not reopen it.
- Synthetic fixtures only. No reference-app access, no real data, no live payroll/payment/notifications, no deployment.
- No gate (ZT/CI) is reported as passed until working software is tested with retained evidence.
- Coverage Log statuses remain only Documented / Restricted / Not reachable.
