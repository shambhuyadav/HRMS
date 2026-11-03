# 09 Capacity Plan (Appendix G3 engineering deliverables)

Status: **PROPOSED**, for review by the platform lead and senior developers. Prepared 25 Oct 2026.
Baseline: BRD v8.2 Appendix G (G1–G5), NFR-S01–S12, ZT31–ZT35; decisions P-04, ADR-00–ADR-14 and T-02–T-05 (docs 03 and 05).
Code facts describe the tree on 25 Oct 2026: the 37 non-draft migrations 0001–0049, plus the drafts 0035, 0037, 0043 and 0050 where noted. Code paths are relative to `apps/api/src/` unless they start with `apps/`, `db/` or `docs/`.

> **This document certifies no capacity.** G5: a capacity gate is PASS only with full-scale G4 evidence. The arithmetic below is a load model, the architecture is a design, and neither (nor any smaller run) proves anything. ZT31–ZT35 are **BLOCKED (not run)**. P-04 records that no smaller certified limit is accepted. No server count, price, benchmark result or provider guarantee appears here.

Status key: **BUILT** exists in the code today (file named) · **PROPOSED** design, not built · **MEASURE** only a G4 stage can supply the value · **DECISION** the owner or platform lead decides.

## 1 Target and load arithmetic

### 1.1 G1 load model
| Quantity | Value | Derivation and notes |
|---|---|---|
| Concurrent active identities | 10,000,000 | Distinct authenticated people, each in their own company/role/assignment context (NFR-S01). Stored accounts, stored sessions or reused tokens are not proof (BRD §12.1) |
| Mean request interval | 10 s per user | Includes think and response time; not 10 M requests in flight |
| Nominal offered load | 1,000,000 business requests/s | 10,000,000 ÷ 10 s. Includes foreground dashboard and session polling; worker and provider calls are counted separately |
| Burst | 1,500,000 requests/s for 15 min | 1.35 billion requests in the window |
| 2-hour nominal hold (ZT31) | 7.2 billion requests | 1,000,000 × 7,200 s |
| 24-hour nominal soak (ZT34) | 86.4 billion requests | 1,000,000 × 86,400 s |
| Login storm (NFR-S04) | 16,666.67 completed flows/s minimum; provision 20,000/s | 10,000,000 ÷ 600 s; 20,000 is 1.2 × the minimum |
| MFA share of the storm | ≥ 800,000 flows (8 %) | DF10: MFA for Admin/Manager contexts with no remembered-device bypass. Reporting Manager 5 % + HR Administrator 2 % + System Administrator 1 %, plus finance-authority contexts among the other roles. ≥ 1,333 MFA completions/s averaged over 600 s |
| Payload | 2 KB request, 10 KB response (means) | 2 GB/s in and 10 GB/s out at nominal (≈ 16 and 80 Gbit/s) before transport and replication overhead; 172.8 TB in and 864 TB out per nominal day. Not a price or a measurement |
| Dashboard polling | ≤ 166,667 refresh cycles/s | If all 10 M users watch a dashboard refreshed every 60 s; already inside the 1 M/s, not added to it. BUILT: the web client refreshes `/v1/dashboard` every 60–75 s (random per tab), not in hidden tabs, one coalesced call per refresh (`apps/web/src/pages/home.tsx`), so ≤ 148,148/s at the 67.5 s mean |
| Error budget (NFR-S03) | ≤ 0.05 % of offered valid requests | ≤ 500 failed requests/s at nominal, ≤ 750/s in the burst; dropped requests count as failures |

### 1.2 Operation mix (G2), requests/s
| Class | Share | Nominal | Burst |
|---|---|---|---|
| Scoped dashboard and list reads | 50 % | 500,000 | 750,000 |
| Own attendance, leave and profile reads | 20 % | 200,000 | 300,000 |
| Team, task and report-status reads | 10 % | 100,000 | 150,000 |
| Submissions, amendments, decisions | 15 % | 150,000 | 225,000 |
| Session and notification metadata | 5 % | 50,000 | 75,000 |

A separate write-heavy stress run uses 50 % writes (500,000 writes/s at nominal).

### 1.3 Company and role skew (G2)
| Group | Share | Identities | Nominal req/s | Burst req/s | Writes/s at 15 % (nominal / burst) |
|---|---|---|---|---|---|
| Hot company (1) | 10 % | 1,000,000 | 100,000 | 150,000 | 15,000 / 22,500 |
| Large companies (9) | 2 % each | 200,000 each | 20,000 each | 30,000 each | 3,000 / 4,500 each |
| Other companies (9,990) | 72 % | 7,200,000 (mean ≈ 721 each) | 720,000 (mean ≈ 72 each) | 1,080,000 | 108,000 / 162,000 together |

Roles: 9,000,000 Employee, 500,000 Reporting Manager, 200,000 HR Administrator, 100,000 System Administrator, 200,000 across the other ten baseline roles. All 14 roles issue positive and negative protected requests. G2 does not fix the size distribution inside the 9,990 group; the fixture must state the one it uses.

### 1.4 Data fixture and durable write volume
- Accounts and employment: 50,000,000 accounts, ≥ 10,000,000 active employment records, 10,000 companies with the skew above (NFR-S06).
- Attendance: `attendance_record` holds one row per employee and work date (unique `(company_id, employee_id, work_date)`, 0008), so 12 months for 10 M employees is up to 3.65 billion rows and the 7-year cohort of 100,000 employees up to 255.5 million more. `attendance_punch` multiplies by punches per day (a fixture parameter).
- Documents: ≥ 10,000,000 metadata rows; files of 100 KB, 1 MB and 10 MB (the mix is a fixture parameter); bytes outside the database (ADR-07).
- Durable writes at 15 %: 1.08 billion in the 2-hour hold, 202.5 million in the burst, 12.96 billion in the 24-hour soak. Each business write in today's code commits at least one `audit_event` row, and for notifiable events an `outbox_event` row, in the same transaction (`audit/audit.ts`), so the soak alone writes ≥ 12.96 billion audit rows. Bytes per row: MEASURE.

### 1.5 Internal amplification in today's code
G1 requires measured amplification per request. These counts come from reading the code; they are the starting hypothesis for Stage 0, not measurements.

| Request | DB statements | Composition |
|---|---|---|
| Any `/v1` request | 1 | Session check (`auth/sessions.ts`) after token verification on CPU (`auth/tokens.ts`) |
| Simple protected read | ≈ 5–6 | Session 1 + `resolveAccess` 3 (context, field groups, scope filters; `modules/access/authorize.ts`) + 1–2 business statements |
| Employee dashboard `/v1/dashboard` | 22 | Session 1 + route guard 3 + dashboard and widget rows 2 + `resolveAccess` 3 for each of 4 widgets + 4 metric queries (`modules/dashboard/service.ts`) |
| Notification inbox `/v1/me/notifications` | 2 | Session 1 + one query (no assignment guard) |
| Leave submission | ≈ 28 | 4 before the transaction; ≈ 24 inside it: checks, two advisory locks, transaction root, request, revision, reservation movement, reviewer selection, approval instance and task, audit, outbox, begin/commit. More when routing falls back to the HR list (`modules/leave/service.ts`, `modules/workflow/engine.ts`) |
| Session touch | ≤ 1 write per session per 60 s | Up to 166,667 `user_session` updates/s with 10 M active sessions |

Illustration only: the session-and-guard prefix is about 4 million statements/s at 1,000,000 requests/s, and 500,000 dashboard requests/s at 22 statements would be 11 million/s. This is why the session store and the access cache (§6) are needed from the first scaled stage, and why every stage reports statements, cache calls and provider calls per business request (`pg_stat_statements` and client counters).

## 2 Service and data topology

### 2.1 Components: built today and still to build
| Component | BUILT today | To build (PROPOSED unless stated) |
|---|---|---|
| Edge and static content | The web app is a static bundle (`apps/web/dist`). Every `/v1` request names its company in `x-hrms-company` and its assignment in `x-hrms-assignment` (`http/context.ts`) | Geographic routing, TLS ingress, a content cache for the web bundle only, routing of `/v1` by company to its home cell (§3). Every `/v1` answer already carries `cache-control: no-store` (`app.ts`), so no edge cache may store it |
| API workers | Stateless Fastify 5 app (`app.ts` `buildApp`); the actor is the bearer token + server-side session + company/assignment headers, checked on every `/v1` request; per-process pool (`db/pool.ts`); request ids; `/health`, `/ready`; graceful shutdown. `server.ts` is the development entry point and refuses `NODE_ENV=production` | Production entry point (OIDC verifier, S3 file store, scanner, field keys). Admission control: in-flight limit per process, per-company and per-user rate limits, explicit 429/503 with `Retry-After` (none exist today). Request deadlines |
| Background workers | `worker.ts` runs `worker/scheduler.ts` every 30 s: claims in `scheduled_job_run`, outbox dispatch, report generation, reminders, celebrations, biometric fetches, upload rescans, module daily jobs. Development entry point only | Separate pools per work class with per-company fairness (§7); production entry point and supervision |
| PostgreSQL | One database. Composite same-company FKs throughout; transaction-scoped advisory locks only; budgets from ADR-14. Tests use embedded PostgreSQL 17; `docker-compose.yml` has postgres:16 (ADR-03: 16+) | One primary per cell with synchronous standbys (§9); a transaction-mode pooler per cell; time partitioning of append-heavy tables (§4.3); intra-company partitions for the hot company (T-05, §3.5) |
| File store | `FileStore` interface (`storage/files.ts`) with memory (tests) and local-directory (development) stores, keyed by SHA-256 alone and therefore shared across companies; production refuses to start without a store. Uploads are base64 inside JSON, ≤ 10 MB (route body limit ≈ 14 MB). Report CSVs are stored in `report_output.content` (0015) | S3-compatible store (ADR-07) with company-prefixed object keys per cell; streaming uploads; report outputs moved to the store |
| Upload scanning | `ScanProvider` interface (`storage/scan.ts`); a synthetic EICAR scanner for development and tests; production refuses to start without a scanner. Employee documents and expense receipts are scanned inside the upload request; candidate and lifecycle uploads wait for the worker. Pending files are rescanned every tick (≤ 200 per company), with no backoff | Real scanner (contract). All scanning on a bounded worker pool (the PENDING_SCAN state already exists); backoff and a circuit breaker |
| Session store | `SessionStore` interface with the PostgreSQL `user_session` table (global: no `company_id`). Idle 30 min, absolute 12 h, revocation effective on the next request (DF10); `last_seen` written at most once a minute | ADR-05 session store (Redis or equivalent) as the authoritative store for sessions and access epochs (§6.3), replicated across zones and regions (§9.4) |
| Cache | None: every request reads the primary | ADR-05 cache for access contexts and safe-scope results with versioned keys (§6.2) |
| Identity provider | `TokenVerifier` interface; HS256 development tokens bound to a server-side session (`sid`), lifetime ≤ 12 h; development sign-in only (`modules/access/me.ts`, refused in production); no MFA | ADR-06 OIDC provider with MFA (T-03). After sign-in the API keeps verifying an HRMS session-bound token, so the provider is called per login and refresh, not per request. Token-verification CPU per request: MEASURE |
| Queue | Transactional outbox table, polled by the worker (ADR-04 development mode); retries 1/5/15 min (ADR-13) | Durable queue or log at scale (ADR-04: Kafka or managed equivalent) fed from each cell's outbox, partitioned by company (§7.4) |
| Home-cell directory | None (one database) | Company → cell, user → companies (§3.2) |
| Observability | Request ids, Fastify/pino request logs with `authorization` and `cookie` redaction, audit and attempt ledgers | Metrics, traces, dashboards, alerts (§10) |
| Load harness and infrastructure code | None: there is no `load/` or `infra/` directory (ADR-09) | k6 open-loop harness, fixture generator, infrastructure code (§11, T-02) |

### 2.2 Proposed shape
```
users -> edge (geo routing, TLS, static bundle cache)
           |  route /v1 by x-hrms-company via the directory
           v
   +--------------- region A ----------------+          +---- region B ----+
   | cell: API processes, worker pools       |          | standbys of the  |
   |       pooler -> PostgreSQL primary      |--sync--> | region A cells,  |
   |                  + standby (other zone) |          | plus own cells   |
   |       cache shard, object-store prefix  |          |                  |
   +-----------------------------------------+          +------------------+
 global: directory, identity provider + MFA, session/epoch store,
         object storage, queue/log, telemetry
```
Independent scaling (NFR-S05): request handlers, worker pools, cell databases and the session/epoch store scale separately, each with its own measured limit. Authorization stays an in-process library (`resolveAccess` is parameterised SQL against the cell database); its data tier (cache, epoch store, cell database) scales on its own. DECISION: the platform lead confirms that this meets NFR-S05's "independently scaled authorization/session services", or asks for a separate service (one more network hop per request).

## 3 Bounded deployment cells

### 3.1 What a cell is (PROPOSED)
A cell is an independently provisioned serving unit: an API process pool, worker pools, a connection pooler, one PostgreSQL primary with a synchronous standby in another zone and a standby in the recovery region (§9), a cache shard and an object-store prefix. It is tested as a unit and carries a measured safe limit. Cells share only global services: directory, identity provider, session/epoch store, object storage, queue service, telemetry and the static content cache. Capacity grows by adding tested cells, never by enlarging one beyond its measured limit (G3).

### 3.2 Home-cell directory (PROPOSED)
| Entry | Content | Used by |
|---|---|---|
| company → cell | cell id, serving state (SERVING, MOVING, FENCED), epoch | Edge routing; a cell refuses a company it does not currently serve |
| user → companies | the companies where the user holds an active assignment, with their cells | The sign-in company list. Today `devLoginRoutes` (`modules/access/me.ts`) finds them with one cross-company query, which a cell cannot answer |
| user → account | account key, active flag, account version | The identity projection in each cell (§5, pattern P2) |

- Routing needs no token parsing: the edge routes on `x-hrms-company`, which every `/v1` request already carries (`http/context.ts` answers 400 without it). The header grants nothing; the cell re-checks everything. A request sent to a cell that does not hold the company already fails closed: `resolveAccess` finds no company row and denies with `UNKNOWN_CONTEXT` (403), and assignment-optional routes such as `/v1/me/notifications` filter by company and return nothing.
- The home cell is set once at company provisioning and changed only by the move protocol (§3.4), as G3 requires. Edges cache entries with their epoch. A stale entry costs a retry, never a wrong answer, because a fenced cell refuses the company (PROPOSED: a serving-state check next to the existing `company.active` check in `resolveAccess`, answering 503 with `Retry-After`).

### 3.3 Placement and sizing (MEASURE)
- Cell safe limit (Stage 0): the highest offered load at which one cell meets NFR-S03 by operation, measured for the G2 read/write mix and the write-heavy variant, with the binding resource named (primary CPU, WAL rate or IOPS, connections, lock waits, replication lag, API CPU or event-loop delay, cache).
- Provisioning per cell is the larger of the burst (1.5 × nominal) and nominal after losing one of Z zones (nominal × Z/(Z−1)). With three zones both come to 1.5 × nominal, provided throughput scales with instances, which Stages 1–3 must show.
- Cells for a group of companies = ceil(nominal load of the group × 1.5 ÷ cell safe limit), evaluated on the binding resource for each operation class.
- Placement: the 9,990 smaller companies are bin-packed by measured load and by user geography (G3 routing). Each 2 % company (20,000 req/s nominal, 3,000 writes/s) is placed once Stage 0 shows whether it fits a shared cell, needs a dedicated one or needs partitioning. The hot company gets a dedicated cell group (§3.5).
- The directory, session/epoch store and identity provider are global and get their own Stage 0 limits (G4: "prove … global directory/routing/auth/session/shared-service limits").

### 3.4 Moving a company between cells (PROPOSED)
The key groundwork is BUILT (0071, 2 Nov 2026): outbox keys are UUIDs, permission ids derive from the natural key, and new object keys start with the company id. The move protocol itself is not built.
G3 copy, catch-up, fenced cutover:
1. Directory: mark the company MOVING. Copy its rows (every table with `company_id`, plus the identity projection rows they reference) to the target from one consistent snapshot.
2. Catch up with logical replication filtered by `company_id` (publication row filters, PostgreSQL 15+) until the lag is small.
3. Fence: directory epoch + 1 and FENCED at the source. The source refuses the company (503, `Retry-After`), its workers skip it, and its outbox is drained.
4. Final catch-up, then reconcile source against target: row counts per table, id-set hashes, unit and money sums (`leave_movement`, `expense_obligation`, `payment_instruction`, `payment_allocation`, `payment_event`, payroll records once built), physical FK validation and the CI checks in the target.
5. Directory: SERVING at the target with the new epoch. The source copy stays read-only for a rollback window, then is archived. The fenced interval counts against availability (G4).

Prerequisites found in the code:
| Finding | Where | Consequence | PROPOSED |
|---|---|---|---|
| Tenant ids are UUIDs and `company_id` is immutable (`hrms_touch()`) | 0001 onwards | Rows copy with their keys unchanged | — |
| `permission.id` is `gen_random_uuid()` in each database; the natural key is `(resource, action, field_group)`; rows are inserted by 30 migrations | 0001 and later | `role_permission`, `role_assignment_permission`, `workflow_step`, `delegation` and `role_dashboard_widget` point at ids that differ per cell | Deterministic ids (for example UUID v5 of the natural key) in a new migration, or remapping by natural key during the copy |
| `outbox_event.id` and `outbox_event_attempt.id` are bigint identities; `outbox_event_attempt.event_id` references `outbox_event (id)` without `company_id` | 0002, 0047 | Ids collide across cells | Drain before cutover and keep the history at the source, or move to UUID keys |
| File objects are keyed by SHA-256 alone (`local:<sha256>`), so identical content is shared across companies | `storage/files.ts` | A company's objects cannot be copied, retained or deleted on their own | Company-prefixed object keys |
| Report outputs live in `report_output.content` | 0015 | Large text moves with the database | Object store (ADR-07) |

### 3.5 The hot company: intra-company partition plan (T-05)
At 10 % of the target the hot company is 1,000,000 concurrent identities, 100,000 req/s nominal (150,000 burst) and 15,000 business writes/s (22,500 burst), all into one company's data. Whether that exceeds one cell is a Stage 0 measurement; the binding number is probably the write ceiling of a single primary. G3 makes an explicit intra-company plan mandatory if it does. The plan assumes it may, because the choice changes keys and constraints and cannot be retrofitted cheaply. T-05 is due before Stage 3.

| Option | Shape | New crossings (§5.3) | Main risks |
|---|---|---|---|
| A. Scale up, offload reads | One large primary for the company; replicas serve list and report reads only, with a freshness bound | None | The single-primary write ceiling (MEASURE); replicas may decide nothing (G3) |
| B. Employee-hash shards + control partition | Employee-owned rows (attendance, leave, requests, ledgers, documents, notifications by recipient) spread over N shards by `employee_id`. Company configuration, organisation masters, the access model, payment batches and payroll run headers sit in a control partition and are replicated to the shards as pinned revisions | Manager and team links, reviewer tasks, acting assignments, company-wide unique keys, batch and run roots; company-scope lists become fan-outs across shards | The largest change; needs patterns P3–P7 |
| C. Organisation-unit shards + control partition | Shards by owner-approved units (legal entity, location or department subtree) | As B, but most manager, team and approval links stay inside one unit | The owner must define units that stay balanced; a transfer between units is an employee move (copy, catch-up, fence) |
| D. Functional split | Ingestion and derived families (punches, biometric ingest events, notifications) move to their own databases; transaction roots, ledgers and audit stay on one primary | Punch → attendance evaluation, notification → transaction | Relieves only part of the load; audit cannot move because it commits with the change (CI16) |

PROPOSED: measure A in Stage 0 with the hot company's write mix; design B now (or C, if the owner can name stable units); add the time partitioning of §4.3 under every option. DECISION: T-05 (owner and platform lead).

## 4 Partition keys and transaction boundaries

### 4.1 Rules that hold today (BUILT)
- A business change, its `audit_event` row and its `outbox_event` row commit in one PostgreSQL transaction (`audit/audit.ts`: "both run inside the business transaction"; `db/transaction.ts` `withTransaction`). Denial audits are written outside business transactions (`http/guard.ts`).
- Every relationship between company-owned rows is a composite `(company_id, …)` FK. `company_id` cannot change after insert (`hrms_touch()`). Employees, user–employee links, employment and manager assignments, role assignments, DB109 rows, delegations and confidential-field policies cannot be deleted (`hrms_no_delete()`). Decisions, ledgers and history are append-only (`hrms_append_only()`): among others `approval_decision`, `audit_event`, `leave_movement`, `leave_request_revision`, `attendance_punch`, `attendance_amendment`, `expense_line_decision`, `expense_obligation`, `payment_allocation`, `payment_event`, `increment_history`, `notification_event`, `notification_delivery_attempt`, `outbox_event_attempt`.
- Serialization uses row locks and transaction-scoped advisory locks (`pg_advisory_xact_lock`): `'bt:' || transaction id` for every state change of one business transaction (`lockTransaction`, `modules/workflow/engine.ts`); the leave balance per employee and type, and the employee's days (`modules/leave/service.ts`); expense duplicate checks per employee and per receipt checksum (`modules/expense/service.ts`). These locks serialize only inside one primary. That is why every record has exactly one writable home, partitions move only behind a fence (§3.4), and failover must be fenced (§9).
- Replays return the recorded outcome through unique keys: `approval_decision` (one decision per task; idempotency key unique per company), `leave_movement`, `payment_instruction` and `import_job` (idempotency keys), `notification` (event/recipient/channel/rule-revision key), `notification_event` and `payment_event` (event keys), `outbox_event` (dedupe key), `attendance_punch_event_uq`, `scheduled_job_run` (run key).

### 4.2 By data family
Key column: the cell key for every company / the key inside the hot company under option B. All keys PROPOSED; single-writer rules BUILT unless marked.

| Family and tables (migrations) | Key | Transaction root and single writer | Notes |
|---|---|---|---|
| **Access and assignments**: `user_account`, `permission`, `user_session` (global, no `company_id`); `role`, `role_permission`, `role_assignment`, `role_assignment_permission` (DB109), `role_scope_filter`, `delegation`, `confidential_field_policy`, `user_employee_link` (0001, 0005, 0016) | company / control partition | `role_assignment` row, locked for update by the grant workflow (`modules/access/admin.ts`); approved by an independent user | Read on every protected request (3 statements). PROPOSED access epoch (§6.3). `user_session` moves to the session store |
| **Employee master and history**: `employee`, `employment_assignment`, `manager_assignment`, `salary_arrangement`, `salary_component`, `increment_history`, `employee_private_profile_revision`, `employee_sensitive_change_request`, `employee_sensitive_change_evidence`, `profile_change_request`, `employee_note`, `employee_confirmation`, `exit_case`, `settlement` (0001, 0009, 0011, 0023, 0033, 0038, 0039) | company / employee shard | The `employee` row, locked for update by changes (`modules/employee/changes.ts`, `service.ts`); EXCLUDE on `(company, employee, interval)` for dated assignments | `manager_assignment` links two employees (crosses in B); `employee_code` and `work_email` are unique per company |
| **Attendance**: `attendance_punch`, `attendance_record`, `attendance_amendment`, `attendance_correction_request`, `attendance_policy`, `attendance_policy_mapping`, `shift`, `shift_assignment`, `shift_break`, `holiday`, `outdoor_duty_request`, `holiday_work_request`, `biometric_*` (0006, 0008, 0014, 0019, 0023, 0025) | company / employee shard, monthly sub-partitions (§4.3) | One `attendance_record` per employee and date, locked for update on amendment; one running sync run per biometric profile (`biometric_one_running_run`); ingestion idempotent per profile and source event | Shift-start peak (G2). The punch key is unique per company source, which crosses in B unless the key gains the employee |
| **Leave ledger**: `leave_type`, `leave_policy`, `leave_policy_mapping`, `leave_request`, `leave_request_revision`, `leave_cancellation`, `leave_movement`, `workflow_fallback_reviewer` (0007, 0018) | company / employee shard | Advisory locks `leave_balance:(employee, type)` and `employee_days:(employee)`; decisions under `lockTransaction` | The balance is the sum of movements (no stored balance); time partitioning would not help it. Movement idempotency key unique per company |
| **Workflow transactions and decisions**: `business_transaction`, `approval_instance`, `approval_task`, `approval_decision`, `workflow_definition`, `workflow_step`, `transaction_evidence`; global catalogues `transaction_kind`, `transaction_state`, `transaction_transition` (0002, 0048) | company / shard of the owner employee (`owner_employee_id`); control partition for kinds with no owner (`payment_batch`, `payroll_run`) | `lockTransaction`, then `for update of t, bt`, then the `approval_decision_guard` trigger (open task, current revision, expected version, live acting assignment, no self decision), plus the decision idempotency key | The reviewer (`assignee_user_id`, `acting_assignment_id`) lives elsewhere under B |
| **Expense and payment ledgers**: `expense_category`, `expense_policy`, `expense_policy_rule`, `expense_claim`, `expense_revision`, `expense_line`, `expense_line_decision`, `expense_receipt`, `expense_obligation`, `payment_batch`, `payment_instruction`, `payment_allocation`, `payment_event`, view `expense_obligation_ledger` (0012) | company / employee shard for claims, obligations, instructions, allocations and events; control partition for `payment_batch` | Claim row lock; duplicate-check advisory locks; `payment_instruction` idempotency key; `payment_event` unique event key (duplicate provider callbacks); one obligation per claim | Batch → instruction crosses in B |
| **Payroll runs and payment events** (active since 26–28 Oct 2026): `0043_payroll.sql`: `payroll_calendar`, `payroll_period`, `payroll_run`, `payroll_run_member`, `payroll_record` and its children, `payroll_input`, `payroll_input_batch`, `payroll_hold`, `payroll_salary_stop`; `0045_payroll_outputs.sql` and `0046_payroll_loans.sql`: bank templates, manifests and lines, payment events (H5 DB112–DB114, DB118), payslips (DB117), loans | company / run header in the control partition, members and records in employee shards | Run state machine (DRAFT … PROCESSED_LOCKED), enforced in the database; one live run per employee and service month (`payroll_member_one_live_run`). BUILT: calculation and processing run in bounded chunks, each committing its records' freeze and audit; the lock commits only once every record is frozen. Manifest authorisation and hold proposals take the same per-record advisory lock | Run preview and creation still confirm the whole scope in one transaction (fine at tens of thousands of members). PROPOSED: chunked scope confirmation for the hot company, or run segments per shard under a coordinator (P5) |
| **Notifications and outbox**: `outbox_event`, `outbox_event_attempt`, `notification_event`, `notification`, `notification_delivery_attempt`, `notification_rule`, `notification_template`, `notification_preference`, `scheduled_job_run` (0002, 0010, 0016, 0028, 0047) | company / outbox in the writer's partition (it commits with the change); notifications with the recipient | Outbox row claimed with `for update skip locked`, one transaction per event; notification idempotency key | Inbox read through the `(company_id, recipient_user_id, state, occurred_at)` index; celebrations fan out to every active user (§7.2) |
| **Audit**: `audit_event`, `retention_rule`, `retention_hold` (0002, 0022) | the partition of the audited record, monthly sub-partitions | Written inside the business transaction; append-only | ≥ 12.96 billion rows per 24-hour soak; viewer and export ≤ 31 days per request (I-08); no purge enabled (DF08) |
| **Documents and outputs**: `attachment`, `employee_document`, `expense_receipt`, `transaction_evidence`, `employee_sensitive_change_evidence`, `candidate_document`, `hiring_handover_document`, `letter_output`, `import_job`, `import_row`, `report_execution`, `report_output` (0002, 0012, 0015, 0017, 0033, 0034, 0038, 0040, 0048) | company / the owner employee's shard for employee files; control partition for imports and reports | Bytes are stored before the metadata row commits (`modules/employee/documents.ts`); a scan verdict applies only while PENDING_SCAN | Bytes in the object store; report CSVs still in `report_output` (§3.4) |

### 4.3 Time partitioning (PROPOSED)
Range-partition the append-heavy tables by month inside each cell: `audit_event` (`occurred_at`), `attendance_punch` (`occurred_at`), `attendance_record` (`work_date`), `notification`, `notification_delivery_attempt`, `notification_event`, `outbox_event`, `outbox_event_attempt`, `biometric_ingest_event`, and `payroll_line` once built. PostgreSQL requires the partition key in every primary key and unique constraint of a partitioned table, so each table's `(company_id, id)` key and every FK into it gain the date column. Tables nothing references (`audit_event`, `notification_delivery_attempt`, `outbox_event_attempt`) are the easy first step. `attendance_record` (referenced by `attendance_amendment` and `attendance_correction_request`) and `attendance_punch` (referenced by `biometric_ingest_event`) need those FKs widened in the same migration. Partition keys must be immutable: `company_id` is (`hrms_touch()`) and so is `business_transaction.owner_employee_id` (transaction guard), but other `employee_id` columns have no generic check. PROPOSED: an immutability trigger for whichever intra-company key T-05 picks.

### 4.4 Query shapes that grow with company size
| Pattern (BUILT) | Where | Cost in the hot company | PROPOSED |
|---|---|---|---|
| Offset paging with `count(*) over ()` and no maximum page number | Employee list (`modules/employee/service.ts`), team list, audit viewer, company users (`modules/access/admin.ts`); since 29 Oct also the wave-2 lists through `db/paging.ts` `pageOf` (exits, settlements, processes, letters, notes, payroll runs, input batches, stops, holds, loans, timesheets, exceptions, allocations, masters) and the timesheet utilisation report, whose totals recompute the whole scoped population on every request (cache or move to async generation later) | Deep pages and totals scan the whole scoped set (≈ 1 M employees) on every request | Keyset paging. Exact totals stay (BR-026 and BR-045 require reconciliation), computed from narrow indexes and cached per safe scope group (§6.2) |
| Leading-wildcard `ilike` on code, name and email | Employee, team and user lists | A full scan per search | Trigram index, or a search projection filtered by the same scope predicate at query time that never decides access |
| Company-wide `count(*)` metrics | `ACTIVE_EMPLOYEES`, `ACTIVE_ACCOUNTS`, `PENDING_ACCESS_GRANTS`, payment counts (`modules/dashboard/service.ts`) | 20,000 HR Administrators in the hot company (2 %), refreshing every ≈ 67 s, run ≈ 300 company-wide counts/s for one widget | Cache per safe scope group keyed by a data version; reconciliation tests against list totals |
| Unpaged task list | `myOpenTasks` (`modules/workflow/engine.ts`) | Fallback reviewers can hold very large queues | Paging |
| Whole-company work in one transaction | Reminders and document expiry (`modules/notification/reminders.ts`), celebrations (`runCelebrations`), report generation (`modules/report/service.ts`), and three interactive routes (§7.2) | Long transactions, memory growth, vacuum and lock pressure | Bounded chunks; the existing occurrence and event keys already make reruns idempotent |

## 5 Foreign keys across partitions (T-04)

G3 keeps every Appendix B relationship and CI invariant: colocated children keep physical constraints, and each crossing relationship needs authoritative validation, pinned reference revisions, deletion restrictions and reconciliation tests. Event-driven eventual consistency alone is not enough.

Counted in the 37 non-draft migrations (the two tables created by dynamic SQL in 0019 not included): 254 composite same-company FKs, 135 `company_id → company`, about 250 `created_by`/`updated_by → user_account` in company tables, 78 other company-table references to `user_account`, 9 company-table references to the global catalogues, and 1 non-composite technical FK (`outbox_event_attempt.event_id`). Under company-keyed cells the 254 composite FKs and the 135 company references stay physical, because the company row lives in its home cell. What crosses are the B1 global roots ("user_account and permission are global roots", with the transaction catalogues alongside) and, inside the hot company, the relationships in §5.3. The schema-constraint register (doc 07) should map each explicit relationship (201 in B4 + 27 in H5 = 228) to its enforcement and, where it crosses, to one of the patterns below.

### 5.1 Patterns (PROPOSED)
| ID | Pattern | Authoritative validation | Pinned revision | Deletion restriction | Reconciliation test |
|---|---|---|---|---|---|
| P1 | Release-pinned catalogue: the same migrations install identical catalogue rows in every cell, so physical FKs stay local | The migration set (`schema_migration` checksums, `db/migrate.ts`) | Catalogue revision = release | No delete path; FKs RESTRICT | Per-cell fingerprint of `permission`, `transaction_kind`, `transaction_state`, `transaction_transition` equals the release fingerprint; ids deterministic (§3.4) |
| P2 | Identity projection: the global directory owns accounts; each cell holds a projection row for every account it references, inserted before the first referencing row. Business references (assignment holder, reviewer, recipient) are validated against the directory at write time | Directory primary, not a replica | Account version on the projection row | Accounts are deactivated, never deleted (FK RESTRICT; PROPOSED no-delete trigger on `user_account`) | Every user id referenced in a cell exists in the directory with the same account key. Deactivation also revokes all of the user's sessions, so it is effective on the next request |
| P3 | Pinned configuration replica: company configuration (reference values, organisation masters, policies, workflow definitions and steps, notification rules and templates, roles and role permissions) is written in the control partition and replicated in order to every shard. A shard write records the configuration revision it validated against and is refused while the shard's replica is older than the revision the request needs | Control-partition revision counter | Revision recorded on the row (many tables already carry a policy id and revision) | Configuration is deactivated or end-dated, never deleted | Per-shard fingerprint equals the control partition's; no row references a revision the control partition lacks |
| P4 | Immutable-target check: a reference to a row in another shard is validated against that row's authoritative primary when written; the target can never be deleted | Synchronous primary read | Target version at validation | `hrms_no_delete()` already protects employees, assignments and business transactions | Scheduled and on-move scans: zero unresolved cross-shard references (ZT33) |
| P5 | Coordinator root with shard segments: a company-level root (payment batch, payroll run, import job) lives in the control partition; each shard holds a segment root whose children keep physical FKs; the root advances only when every segment reports reconciled counts and amounts | Root–segment registry | Segment revision | Roots and segments are state-machine or append-only rows | Sum of segment totals = root totals; no segment without a root, no child without a segment |
| P6 | Key namespacing or registry: a company-wide unique key either gains the partition key (when the rule only needs uniqueness per record, as decision keys per task) or is reserved in a control-partition registry before the shard write (`employee_code`, `work_email`) | Registry unique index | — | Reservations are never reused (DF04: codes are permanent) | Registry keys = shard keys, no duplicates |
| P7 | Access replica with epoch: `role_assignment`, DB109 rows, scope filters, `user_employee_link` and the manager graph are authoritative in the control partition and replicated to every shard. A grant change bumps the user's access epoch before and after commit (§6.3) and is acknowledged only once every shard has applied it; a shard whose applied version is behind the epoch denies the request | Epoch store + control partition | Access version recorded on decisions and audit rows (new column) | Assignments are never deleted | No decision or audit row carries an access version older than its assignment's revocation (ZT32, ZT33) |

### 5.2 Crossings under company cells (every company)
| Relationship (child → parent) | From the migrations | Pattern |
|---|---|---|
| `created_by`, `updated_by` → `user_account` | About 250, two per company table (B1 common columns) | P2 |
| Business references → `user_account` | 78, for example `role_assignment.user_id` and `.approved_by`, `user_employee_link.user_id`, `approval_task.assignee_user_id`, `approval_decision.actor_user_id`, `delegation.delegator_user_id` and `.delegate_user_id`, `notification.recipient_user_id`, `notification_preference.user_id`, `workflow_fallback_reviewer.user_id`, `audit_event.actor_user_id`, `attachment.owner_user_id`, `report_execution.requested_by`, `payment_event.recorded_by` | P2 |
| → `permission` | `role_permission`, `role_assignment_permission`, `workflow_step`, `delegation`, `role_dashboard_widget` | P1 |
| → `transaction_kind`, `transaction_state` | `business_transaction.kind` and `(kind, state)`, `workflow_definition.kind`, `workflow_fallback_reviewer.kind` | P1 |
| `user_session.user_id` → `user_account` | Global table; becomes the session store keyed by user | P2 |

### 5.3 Additional crossings inside the hot company (option B; option C keeps most of rows 1–4 inside one unit)
| # | Relationship (migration) | Why it crosses | Pattern |
|---|---|---|---|
| 1 | `manager_assignment (company_id, manager_employee_id) → employee` (0001) | Manager and report in different shards; TEAM scope (`employeeScopePredicate`), direct-manager routing (`directManagerUser`) and the CI13 cycle check read across shards | P4 on write; manager graph in the access replica (P7) for reads |
| 2 | `role_scope_filter (company_id, employee_id) → employee`; `user_employee_link (company_id, employee_id) → employee` and its one-employee-per-user EXCLUDE (0001) | Access model in the control partition, employees in shards | P7 + P4 |
| 3 | `approval_task.assignee_user_id`, `approval_task (company_id, delegation_id, assignee_user_id) → delegation`, `approval_decision (company_id, acting_assignment_id) → role_assignment`; the decision guard reads the reviewer's assignment, delegation and links (0002) | The transaction lives in the owner's shard, the reviewer's access in the control partition | P7 |
| 4 | `audit_event`, `report_execution`, `hiring_handover (company_id, acting_assignment_id) → role_assignment`; `settlement (company_id, release_eligible_assignment_id) → role_assignment` (0002, 0034, 0039) | As row 3 | P7 |
| 5 | FKs to company configuration: `reference_value` (19 FKs), `department`, `location`, `designation`, `grade`, `leave_type`, `leave_policy`, `attendance_policy`, `shift`, `expense_category`, `expense_policy`, `workflow_definition`, `workflow_step`, `notification_rule`, `notification_template`, `role`, `pay_component`, `increment_cycle`, `biometric_profile` and mapping revisions | Configuration in the control partition | P3 |
| 6 | `payment_instruction (company_id, batch_id, currency_code) → payment_batch` (0012); `payroll_run_member`, `payroll_record (company_id, run_id) → payroll_run` (draft 0043); later `payroll_bank_line → payroll_bank_batch` (H5, not yet in migrations) | A batch or run spans employees | P5 |
| 7 | `notification (company_id, transaction_id) → business_transaction`; `notification_event (company_id, subject_employee_id) → employee` and `(company_id, transaction_id) → business_transaction` (0010) | Notifications live with the recipient | P4 (transactions are never deleted) |
| 8 | `requisition (company_id, requesting_employee_id)` and `(company_id, hiring_manager_id) → employee`; `hiring_handover (company_id, employee_id) → employee` (0034) | Hiring is company-level | P4 |
| 9 | `import_row (company_id, applied_transaction_id) → business_transaction`; `import_job → attachment` (0002) | One import creates rows in many shards | P5 (the import job is the coordinator) |
| 10 | Company-wide unique keys: `employee (employee_code)` and `(work_email)`; idempotency keys of `approval_decision`, `leave_movement`, `payment_instruction`, `import_job`, `notification`; event keys of `notification_event`, `payment_event`; `outbox_event` dedupe key; `attendance_punch_event_uq`; `mobile_app_link_one_active_account`; `asset_custody` issue and return keys | Uniqueness across shards | P6 |

## 6 Authorization and cache safety

### 6.1 Today (BUILT)
- There is no cache. On every `/v1` request the token is verified and the server-side session is checked (idle, absolute, revoked). Each protected handler then calls `requireAccess` → `resolveAccess` against the primary, inside the one selected assignment: user active, company active, the assignment is the caller's, ACTIVE and effective, role active; per field group, role ALLOW intersected with an active DB109 entry; confidential groups only for the ADMIN or MANAGER class or the H1 own-ESS exception; row scope (OWN, TEAM, ASSIGNED, COMPANY) intersected with the assignment's filters. A revocation is effective on the next request because nothing is cached.
- Dashboard widgets are each re-authorized in the same assignment. Report generation re-checks access in the worker, and the download re-checks it under the same assignment. Every `/v1` answer, file and report downloads included, is sent with `cache-control: no-store`. Notifications re-check the recipient at delivery (`stillEligible`). Denials are audited with the request id and no payload.

### 6.2 Cache keys (PROPOSED)
| Cached item | Key binds | Shared between users? | Invalidated by |
|---|---|---|---|
| Session | session id → user, expiry, last seen, revoked | No | Revocation, expiry. Authoritative store, not a cache |
| Access context (the output of `resolveAccess`) | company, user, assignment, the user's access epoch, the company's policy version (role permissions, confidential-field policies, catalogue revision), business date, requested resource, action and field groups | No | Epoch or version change; business-date change |
| Scoped list and count results | company; safe scope group (scope kind + filter set + linked employee for OWN and TEAM, user for ASSIGNED); allowed field groups and their classification; query filters and paging cursor; business date; data version of the source tables; policy version | Only between users with an identical safe scope group and identical field eligibility | Data version, policy version, any change in scope membership |
| Company configuration | company, table, revision | Yes, operational configuration only | Revision |
| Static web bundle | content hash | Public content cache | Release |

Never cached: confidential payloads (salary, private profile, bank, reasons), file bytes, report outputs, decision and payment paths, and anything served to a denied request. A cached entry never stands in for a check: a hit only replaces the database read of the same decision under the same epochs.

### 6.3 Revocation on the next protected request (PROPOSED)
1. Every change that can narrow access (assignment state or dates, DB109 row, scope filter, role permission, confidential-field policy, user deactivation, user–employee link) bumps the affected access epoch in the epoch store before its database commit and again after it. Deactivation also revokes all of the user's sessions.
2. Each request reads the user's epoch and the company's policy version in the same round trip as the session check.
3. A cached access context is used only when its epochs equal the current ones. A cache fill stores the epoch read before its database read and is discarded if the epoch moved in between (compare-and-set), so a fill that raced a revocation is never served.
4. Between the two bumps, requests miss the cache and read the primary, which is correct by construction.

The result is that revocation stays effective on the next protected request with caches in place (DF10, G3). ZT05 and ZT32 test it under load, including cached and failed-authority cases.

### 6.4 Fail closed
If the session/epoch store, the cell primary or (under option B) the shard's access replica cannot establish current authority (lag beyond its bound, network partition, failover, fenced cell), protected work is refused with a retryable 503. It is never served from a stale cache, and never answered with less checking. Load shedding rejects requests; it never skips checks (NFR-S08).

### 6.5 Decision transactions
The route guard resolves the grant on the pool just before the decision transaction opens. Inside the transaction the `approval_decision_guard` trigger re-checks the open task, current revision, expected version, the acting assignment's state and dates, and self-decision, and the leave path re-checks row scope with `canAccessEmployee` on the transaction.
BUILT (26 Oct 2026): `decideTask` (`modules/workflow/engine.ts`) share-locks the acting `role_assignment` row and resolves the step's permission again with `resolveAccess` on the transaction, after the transaction and task locks; a narrowing committed since the guard (assignment state or dates, role permission, DB109 entry, user or company deactivation, classification) refuses the decision with 403 and records nothing (`workflow/decision-recheck.api.test.ts`). Grant approval and revocation (`access/admin.ts`) lock the same row for update, so they are ordered strictly before or after a decision. Role-level changes (role permissions, role deactivation) and user or company deactivation are read fresh but not serialized by that lock. This becomes mandatory once the guard can use a cached context (G3: "check fresh workflow state and assignment in the authoritative decision transaction"). BUILT since (27–28 Oct 2026): the same re-check (`reassertAccess` in `http/guard.ts`) on the decision and money paths outside `decideTask`: expense payments, payroll calculation, processing, holds and inputs, bank manifests and outcomes, loans, and the module decisions found by the reviews (assets, timesheet, lifecycle, increment, hiring).

### 6.6 Replicas, projections and output links
- Read replicas and search projections may serve list and report reads only when authorization comes from the authoritative path and the data carries a freshness bound (a read-your-writes token after the caller's own writes). They never decide approvals, grants, balances used by a decision, or payment state (G3).
- A generated output is never an authorization grant. Report downloads already require the requester's session, the same assignment and a fresh access check. With object storage, downloads either keep streaming through the API or use a single-object, short-lived link issued after that check and never cached or shared. DECISION, with ADR-07.

## 7 Background processing

### 7.1 Today (BUILT)
- `worker.ts` calls `runScheduledJobs` every 30 s. Each tick first runs up to 20 bulk-job chunks (`BULK_CHUNKS_PER_TICK`; bulk jobs are described below). It then walks every active company in turn. It rescans up to 200 pending uploads, then applies due private-profile changes (≤ 1,000 per company-day, one transaction each). It runs module daily jobs (lifecycle exits, ≤ 1,000). From 08:00 it runs reminders and document expiry (one transaction per company each) and from 09:00 celebrations (one transaction per company). It fetches biometrics per profile every 15 minutes plus a nightly 7-day lookback (no provider adapter is configured, DF13). Only then does it dispatch up to 500 outbox events and generate up to 50 reports.
- Each daily run is claimed once in `scheduled_job_run`, so any number of workers can tick at once without duplicating work.
- Outbox: each event in its own transaction, claimed oldest-first with `for update skip locked` and processed in a savepoint. A failure is retried after 1, 5 and 15 minutes, then marked FAILED (ADR-13). In-app delivery re-checks the recipient.
- Reports: QUEUED → worker → COMPLETED or FAILED. The API answers QUEUED and offers a status route, so admission says whether work is queued or done (G3).
- Bulk jobs (ADR-15, `modules/bulk/`, table `bulk_job`, migration 0053): `POST /v1/attendance/processing` and `POST /v1/leave/accruals` authorise as before, record a QUEUED job and answer 202 `{ jobId, state }`. An optional `idempotencyKey` returns the same job to the same requester with the same parameters; any other use of the key gets 409 `IDEMPOTENCY_KEY_REUSED`. The worker (`runBulkJobs`) claims a ready job with `for update skip locked`, least recently advanced first, and runs ONE chunk per transaction: at most `BULK_CHUNK_SIZE` = 100 employees in a stable keyset order (employee code for processing, employee id for accrual). Each chunk first re-resolves the requester's stored user, company, assignment and permission with `resolveAccess`, share-locking the assignment. A lost grant ends the job FAILED `ACCESS_REVOKED` and nothing more runs. The cursor, the running counts and the chunk's effects commit together, so a crash or a retry resumes without double effects. A failing chunk rolls back alone (savepoint) and is retried after 1, 5 and 15 minutes, then the job is FAILED with an error class. The audit record the synchronous run wrote is written once, with the last chunk. `GET /v1/bulk-jobs/:id` and `GET /v1/bulk-jobs` serve only the requester under the same assignment, re-checking the job's permission. Both numbers are starting values: MEASURE per G4.

### 7.2 Gaps against G3 and NFR-S09
| Gap | Where | Effect at scale |
|---|---|---|
| Outbox and report queues drain only after the whole company loop of a tick | `worker/scheduler.ts` | Notification latency grows with the slowest company's daily jobs; one long celebration transaction delays every company |
| No per-company fairness: outbox and report claims are global oldest-first | `dispatchOutbox`, `processReportQueue` | A burst from the hot company starves the other 9,999 |
| Celebrations fan out on write: one notification row and several eligibility queries per active user of the company, in one transaction per company-day | `runCelebrations`, selector `COMPANY_CELEBRATION_AUDIENCE` (`modules/notification/dispatcher.ts`) | In the hot company every celebrant writes ≈ 1 M notification rows. G3: "avoid an all-employee scan per event" |
| Whole-company transactions | Reminders, document expiry, celebrations, report generation (all rows in memory; CSV stored in the database) | Long transactions, memory growth, vacuum and lock pressure |
| Company-wide loops on interactive requests, each in one request transaction. BUILT (ADR-15, §7.1): `POST /v1/attendance/processing` (every in-scope active employee for a date) and `POST /v1/leave/accruals` (every active employee and paid leave type for a month) are queued bulk jobs, answered 202 and run by the worker in bounded chunks. BUILT 29 Oct (0055, 0057): `POST /v1/increment-cycles/:id/reviews` is kind INCREMENT_REVIEW_OPENING; its result holds counts only, and cases and exclusions are rows written per chunk, read through paged routes. Import commits are synchronous, but bounded by the DF09 limit of 10,000 rows | `modules/increment/roster.ts`, `modules/bulk/kinds.ts` | BUILT 29 Oct (0058): attendance processing keeps only counts in its result; each chunk writes its employees without a policy as rows of the job, read by the requester through `GET /v1/attendance/processing/:id/no-policy-employees`. Remaining: the paging of a very large opening (sorted by employee code through a join) is not measured: MEASURE per G4 |
| Bounded batches with a once-per-day claim | `applyDueChanges`, `separateDueExits` (≤ 1,000 per company-day) | A backlog above 1,000 waits until the next day |
| Scans in the upload request; pending scans retried every tick without backoff or limit | `modules/employee/documents.ts`, `modules/expense/routes.ts`, `storage/scan.ts` | Scanner latency becomes foreground latency (NFR-S09); an outage turns into a retry storm when the scanner recovers |
| A claim insert per company and job on every tick (conflicting no-ops) | `claim` in `worker/scheduler.ts` | O(companies × jobs) statements every 30 s per worker |

### 7.3 Work classes (PROPOSED)
| Class | Work | Pool and database budget | Ordering and fairness |
|---|---|---|---|
| Critical | Outbox relay for decisions and security or access-change events, epoch propagation, payment outcome callbacks | Own pool, never shared with bulk; short statement timeouts | Ordered per company and aggregate; deadline-based |
| Scheduled | Per-company daily jobs (reminders, private-profile changes, exits, document expiry, accruals) as queued work items | Own pool | One item per company and job; weighted round-robin across companies |
| Bulk | Reports and exports, import commits, celebrations, payroll calculation and processing, attendance daily evaluation | Own pool; chunked transactions | Per-company concurrency caps and quotas; the hot company gets a bounded share |
| Ingestion | Biometric pages, punch imports | Own pool; paced to provider quotas | Per profile; the shift-start peak is absorbed by the queue, not by foreground capacity |
| Files | Malware scans, later document processing | Own pool sized to the scanner quota | Per company; backoff and circuit breaker |

Celebrations (PROPOSED; the DF12 owner confirms the outcome is unchanged): publish one company celebration entry per event and let eligible users read it, with the recipient check at read time, instead of writing one row per recipient; or build per-user digests in bounded batches. Either way the opt-in, content and 09:00 timing rules stay.

### 7.4 Queues, admission and backpressure
- The outbox stays the transactional source in every cell. At scale a relay publishes to a durable log partitioned by company, and consumers stay idempotent through the existing dedupe and event keys. DECISION: the ADR-04 product. Note for the polling path: the ready index `outbox_event_ready_idx` does not include `next_attempt_at`, so delayed retries at the head are rescanned by every claim.
- Per class and per company, thresholds on queue depth and oldest-item age. Above them, new bulk requests (reports, imports) get an explicit retryable 429 or 503; critical work is never shed.
- Drain rule (NFR-S02): after the burst every queue returns to nominal within 15 minutes, so backlog ÷ (drain rate − arrival rate) ≤ 900 s for every class. Drain rate per pool: MEASURE.
- NFR-S09 allows no all-user loop on an interactive request. Attendance processing and monthly accrual are BUILT as bulk jobs (ADR-15): the request records a job and answers 202, and its state is explicit (QUEUED → RUNNING → COMPLETED or FAILED). The increment review opening is BUILT as a third kind (§7.2). The celebration fan-out already runs in the worker but still needs the change in §7.3.
- Bulk jobs today: every worker runs at most `BULK_CHUNKS_PER_TICK` = 20 chunks per tick, each at most `BULK_CHUNK_SIZE` = 100 employees in one transaction. Ready jobs take turns, least recently advanced first. There is no per-company cap or admission threshold yet. MEASURE: chunk duration, drain rate and the hot company's share.

## 8 Budgets

### 8.1 Connection pools
- BUILT: each API or worker process has a pool of `DB_POOL_MAX` (default 10). A statement outside a transaction borrows a connection for that statement only (`pool.query`); a transaction holds one connection for its whole duration (`withTransaction`). Nothing holds a connection per user or session (G3).
- Connections at a primary = Σ processes × pool size. At the default of 10, 100 processes would open up to 1,000 server connections to one primary, so each cell gets a transaction-mode pooler and per-class pools sized by Little's law: busy connections ≈ Σ (transactions/s × hold time), where hold time ≈ statements × round trip + execution time (MEASURE). Illustration with assumed numbers: 15,000 write transactions/s held 30 ms each keep 450 connections busy.
- Pooler compatibility: the code keeps no session state (only `pg_advisory_xact_lock`; no LISTEN/NOTIFY, no session `SET`). node-postgres sends `statement_timeout` and `idle_in_transaction_session_timeout` as connection startup parameters, which a transaction-mode pooler may refuse or drop. Behind a pooler, set them as role or database defaults (`ALTER ROLE … SET`); verify in Stage 0.

### 8.2 Timeouts
BUILT 2 Nov 2026 (`http/deadline.ts`, `db/budget.ts`, `db/transaction.ts`): read, write and batch request deadlines; `set local` statement and lock timeouts per transaction; whole-run routes declare the batch budget; worker chunks keep their own budget. The "Today" column below predates this; see `HTTP_*_DEADLINE_MS`, `DB_*_STATEMENT_TIMEOUT_MS` and `DB_*_LOCK_TIMEOUT_MS` in `.env.example` for current defaults. No value is measured yet.
| Budget | Today (ADR-14, `db/pool.ts`) | PROPOSED starting budget for Stage 0 | Why |
|---|---|---|---|
| Read request deadline | None | 3 s end to end | NFR-S03 read p99 ≤ 3 s |
| Mutation request deadline | None | 5 s | Mutation p99 ≤ 5 s |
| Connection wait | 10 s | ≤ 1 s, then 503 with `Retry-After` | A 10 s wait has already missed the target; fail fast instead |
| Foreground statement timeout | 15 s | 2 s for reads, 4 s inside mutations | Below the deadline, so the request can still answer |
| Lock wait | Bounded only by the statement timeout (`lock_timeout` is not set; advisory-lock waits included) | `lock_timeout` below the statement timeout | Lock pressure becomes visible on its own |
| Idle in transaction | 30 s | 10 s | The API never pauses inside a transaction |
| Worker statements | 15 s, same as API | Per class: longer for bulk chunks, shorter for critical work | Separate pools |
| Request body | 1 MB; uploads ≤ 10 MB as base64 JSON (route limit ≈ 14 MB) | Streaming uploads to the file store | Memory per in-flight upload |

Error mapping, BUILT (26 Oct 2026, `http/errors.ts`): a pool-wait timeout, a statement (57014), lock (55P03) or idle-in-transaction (25P03) timeout, a connection limit (53300), a shutdown (57P01–57P03), a connection failure (08xxx) or a dropped connection answers 503 `UNAVAILABLE` with `Retry-After: 5` and no cause, instead of 500, so overload is explicit and clients back off (NFR-S10). PROPOSED: count them as throttles in the metrics (§10.2); at nominal load they still count against the 0.05 % budget (NFR-S03).

### 8.3 Retries and idempotency
| Path | Today (BUILT) | PROPOSED |
|---|---|---|
| Outbox events (DF12) | Retried after 1, 5 and 15 minutes, then FAILED; each attempt recorded with an error class only (ADR-13) | Unchanged; FAILED events alerted (§10) |
| Decisions | `approval_decision` idempotency key, unique per company; a replay returns the recorded outcome; reusing a key for another task returns 409 | Unchanged; clients reuse the key on retry. Under B the key is namespaced (P6) |
| Payments | `payment_instruction` idempotency key; `payment_event` unique event key absorbs duplicate provider callbacks | Unchanged |
| Leave movements, imports, notifications | Unique keys per movement, job, and event/recipient/channel/rule revision | Unchanged (P6 under B) |
| Deadlocks and serialization | 40P01 → 409 RETRY; 40001 → 409 STALE_VERSION | The client retries once, with backoff and the same idempotency key |
| Web client | TanStack Query default `retry: 1` for every failed query (`apps/web/src/main.tsx`); several pages retry transient errors only, once | Auto-retry only idempotent reads, only after 5xx or network errors, once, with jitter, honouring `Retry-After`; mutations retry only with the same idempotency key; a retry budget per client so retries cannot multiply load during an incident |
| Upload scans | Every tick, no backoff, no limit | Exponential backoff with jitter, an attempt cap, a circuit breaker on the scanner |
| Biometric fetches | Per 15-minute slot, plus the nightly 7-day lookback (DF09) | Paced to the provider quota |

### 8.4 Admission limits (PROPOSED; none exist today)
Per process: a maximum of in-flight requests and of in-flight uploads. Per company and per user: request-rate quotas derived from the selected journeys (NFR-S10, fair company/user admission), plus rate control on manual dashboard refresh (DF17). Above the declared safe capacity, explicit retryable throttles (429 or 503 with `Retry-After`) preserve correctness and isolation. At the nominal target, legitimate journeys must not be throttled.

### 8.5 Dependency quotas to obtain
ADR-00 keeps procurement with humans.
| Dependency | Quota to obtain | Basis |
|---|---|---|
| Identity provider (T-03) | 20,000 completed login flows/s; token refresh rate; metadata and key-set fetch limits; 50 M accounts | NFR-S04, G2 |
| MFA factor | ≥ 1,333 completions/s averaged over the storm, with a higher peak; per-message limits if the factor sends messages | DF10, §1.1 |
| Session/epoch store | 1 M checks/s, ≥ 20,000 session creations/s, 10 M resident sessions, ≤ 166,667 touches/s | §1.5 |
| Object storage | PUT/GET rate per prefix, bandwidth, multi-region durability for evidence files | G2, §9.3 |
| Malware scanner | Files/s and MB/s at 100 KB, 1 MB and 10 MB | FR-106, G2 |
| Email, if enabled for non-confidential templates | Messages/s and per day | DF12 |
| Biometric providers | Pages/s per profile, lookback limits | DF09, DF13 |
| Bank and payment channels (wave 2) | File submission and callback rates | H8 |
| Cloud account (T-02) | Instances per region, managed database instances and IOPS, load-balancer connections, cross-region bandwidth, address space | §3, §9 |
| Queue or log (ADR-04) | Partitions, throughput, retention | §7 |
| Key management (ADR-11) | Data-key operations/s for field envelopes | ADR-11 |
| Telemetry | Metric series, log and trace ingestion | §10 |
| Load generators | Instances, egress bandwidth and connections for 1.5 M req/s with TLS | G4 |

## 9 Failure domains and recovery

### 9.1 Targets
| Target | Value | Source |
|---|---|---|
| Monthly availability of login, scoped viewing and request/decision services | 99.95 % = 21.6 minutes per 30-day month; failover intervals count | NFR-S07, G4 |
| One-zone loss | Nominal traffic stays within NFR-S03 after a documented failover transition | NFR-S07, ZT34 |
| Regional recovery | ≤ 15 minutes. One such failover uses 69 % of the month's 21.6-minute budget | NFR-S07, ZT34 |
| RPO, acknowledged financial, approval and audit writes | 0 | NFR-S07 |
| RPO, other reconstructible data | ≤ 5 minutes | NFR-S07 |
| Headroom | Tested, provisioned headroom; autoscaling is not assumed instantaneous | NFR-S05, G3 |

These are selected objectives, not existing SLAs.

### 9.2 Zones (PROPOSED)
Each cell spans three zones. API and worker processes spread across them; the primary sits in one zone with a synchronous standby in another; the pooler and cache shard are replicated across zones. On zone loss the standby is promoted with fencing (the old primary must not accept writes) and the cell keeps serving nominal load from the surviving zones, using the Z/(Z−1) headroom of §3.3.

### 9.3 Regions and RPO 0 (PROPOSED)
- Every business change commits together with its audit row (§4.1), so RPO 0 for audit means RPO 0 for the whole cell database: a commit may be acknowledged only once it is durable outside the failed region. That requires synchronous replication with a quorum that includes a standby in the recovery region for every cell primary. It adds the cross-region round trip to every commit: MEASURE against mutation p95 ≤ 2 s and against throughput.
- A commit whose synchronous-replication wait is cancelled (for example by `statement_timeout`) stays committed locally, and PostgreSQL reports it with a warning, not an error. `withTransaction` ignores warnings today. PROPOSED: treat that warning as not acknowledged (fail the request as retryable and reconcile), and include it in Stage 0 fault injection.
- With a synchronous quorum an isolated old primary cannot acknowledge new commits except through that cancelled-wait path. Fencing (the HA manager's lease plus the directory epoch) keeps it from serving after promotion (G3 "controlled fenced failover").
- Regions are sized so that the survivors carry nominal load after losing one: R regions need R/(R−1) × nominal, which is 2 × for two regions.
- Reconstructible data (RPO ≤ 5 min): caches, search projections, report outputs (they can be regenerated), session last-seen times, biometric fetches (the 7-day lookback refetches them), telemetry.
- Files: evidence and receipts referenced by financial or approval records must be durable in two regions before their attachment row commits. The upload path already stores bytes before inserting the row. DECISION with T-02, depending on provider capability.
- Regional failover sequence: detect; fence the failed region (directory epoch, writer endpoints); promote the standbys of each cell; switch routing; restart workers (the outbox resumes and consumers are idempotent); reconcile; reopen. ZT34 times each step.

### 9.4 Sessions, directory and identity
- A revocation is a security write: losing it would reopen a revoked session. Either the session/epoch store replicates revocations synchronously across regions, or, after a regional failover, every session whose revocation state cannot be proven is refused and its user signs in again. The second option turns a regional failover into a login storm in the surviving region, so NFR-S04 capacity must exist there. DECISION.
- The directory and the identity projection are read-mostly and replicated to every region. Routing keeps working from cached entries during a directory outage; a stale entry fails closed at the cell (§3.2).
- Sessions created in a 10-minute login storm all reach the 12-hour absolute limit (DF10) in the same 10 minutes, 12 hours later. That makes a second storm at hour 12 of the soak, and in production after any mass sign-in (a failover, a shift start).

### 9.5 Backups, restore and reconciliation
- Backups: physical base backups plus a continuous WAL archive per cell, kept in a separate account and region with immutable retention. Field keys (ADR-11 `HRMS_FIELD_KEYS`; custody still open under T-02/T-03) and other secrets are backed up separately under least-privilege access. Restores are tested, never assumed.
- Restore tests (G4): point-in-time restore of a cell, then reconciliation of sampled and complete critical ledgers (`leave_movement`, `approval_decision`, `expense_obligation`, `payment_instruction`, `payment_allocation`, `payment_event`, `increment_history`, `audit_event`, and payroll records and lines once built): row counts, id-set hashes, unit and money sums per company, physical FK validation, CI checks.
- Acknowledged-outcome reconciliation (ZT34): the load generator journals every acknowledged write (request id, business key, outcome). After a failover or restore, every journal entry must be found in the database.

## 10 Observability

### 10.1 Today (BUILT)
- Metrics (2 Nov 2026): `/internal/metrics` in Prometheus text format, off by default and guarded by a configured token (`HRMS_METRICS_TOKEN`): pool counters, request counts and latency per route pattern and status class, per-request statement counts; never URLs with ids, never user or company ids.
- Request ids: a well-formed inbound `x-request-id` is kept, otherwise a new UUID is issued; the id is returned on every response and included in denial audits.
- Logs: Fastify/pino request logs when enabled (`server.ts` enables them), with `authorization` and `cookie` redaction.
- Health: `/health` (liveness) and `/ready` (database check) reveal no detail.
- Ledgers: `audit_event`, `outbox_event_attempt` (error class only), `scheduled_job_run` outcomes, `report_execution` states.
- There is no metrics endpoint, latency histogram or tracing.

### 10.2 Metric catalogue (PROPOSED, NFR-S11)
| Metric | Dimensions | Source |
|---|---|---|
| Offered, received and completed requests; rejected and dropped attempts | Operation, role, region, cell, company tier | Generator schedule, edge, API |
| Edge-to-response latency histograms (p50/p95/p99), including authorization, cache, database and queue-admission time | Operation, region, cell | Edge, API |
| Outcomes: 2xx, 4xx by code, 5xx, timeouts, throttles (429/503) | Operation, cell | API |
| Saturation: CPU, event-loop delay, heap, in-flight requests | Process, cell | API, workers |
| Pools: in use, waiting, wait time, timeouts | Process, pool class | node-postgres pool counters |
| Database: connections, CPU, IOPS, WAL rate, checkpoints, statements per business request | Cell | PostgreSQL statistics views |
| Lock pressure: lock and advisory-lock waits, deadlocks (40P01), serialization failures (40001), statement timeouts (57014) | Cell, operation | PostgreSQL, API error mapping |
| Replication: lag in bytes and time, synchronous standby state | Cell, standby | PostgreSQL |
| Worker backlog: queue depth, oldest-item age, drain rate, retries, FAILED | Class, cell, company tier | Outbox, `report_execution`, `scheduled_job_run`, attachment scan state |
| Authentication: login flows started, completed and failed; MFA latency; token-verification failures; session outcomes (UNKNOWN, REVOKED, EXPIRED, IDLE, WRONG_USER); access denials by reason; fail-closed refusals | Region, cell, role | API, identity provider |
| Cache: hit and miss, fills discarded by epoch, invalidation delay | Cache | Cache client |
| Isolation tests under load (ZT01–ZT05, ZT29, ZT30) | Run | Harness |
| Cost per completed business transaction | Cell, region | Cost export ÷ completed requests |

Dimensions stay bounded: company tier (hot, large, other), never a company or user id as a metric label.

### 10.3 Privacy-safe telemetry
- No tokens, cookies, request bodies, confidential values, reasons, amounts, names or personal identifiers in logs, metrics or traces (NFR-S11). Audit and outbox rows already carry field names rather than values (ADR-11, ADR-13).
- BUILT (26 Oct 2026, `http/logging.ts`): request log lines record the method, the route pattern, the status, the response time and the request id; never the raw URL (query strings carry name, code and email searches such as the employee list `search`), the client address, tokens or cookies. Unhandled errors log their class, code, message and stack, never driver detail (which can hold row values). DECISION: IP retention (CP-05); until it is decided, no address is logged.
- At 1 M requests/s the default two log lines per request make 2 M lines/s. Sample successful requests and keep every error with its request id. DECISION: sampling and retention policy.
- The request id should travel from edge to API to worker (PROPOSED: outbox payloads carry the originating request id), so one business action can be followed without personal data.

## 11 G4 test plan and gate status

### 11.1 Harness (PROPOSED; not started)
- k6 open-loop arrival executors (ADR-09) on distributed generators whose CPU, memory, network and connection limits are measured in every run. If the generators cannot sustain the schedule or keep identities correct, the run is BLOCKED, not FAIL (G4).
- Coordinated omission: record the scheduled and the actual send time of every request. Requests the generator could not send count as failures (k6 dropped iterations); the offered rate is never lowered when the system slows.
- Fixture generator: 50 M accounts; ≥ 10 M active employments with role assignments, DB109 allowlists and scope filters; 10,000 companies with the G2 skew; history (12 months of attendance, the 7-year cohort); ≥ 10 M document metadata rows with real objects in the three sizes; workflow items in valid states with distinct actors for approval and financial fixtures. It reuses the provisioning paths of `test/harness.ts` (`provisionCompany`, approved assignments with DB109 rows, server-side sessions), or bulk-loads equivalent rows through the same constraints, and reports actual counts.
- Distinct identities: every simulated user has its own account, session and token; reusing tokens is not active-user proof. The login storm runs real login flows with MFA against the identity provider, or a contracted equivalent with the same quotas.
- Results are kept by cohort (operation, region, role, company tier), not only as pooled averages.

### 11.2 Stages
Each stage must pass before the next. Intermediate passes guide tuning and funding; none of them is a ten-million pass (G4). At Stages 1–4 the number of companies shrinks while the shares (10 %, 9 × 2 %, 72 %) stay.

| Stage | Identities | Nominal req/s | Burst req/s | Login flows/s | Hot company (users / req/s) | Purpose | Status |
|---|---|---|---|---|---|---|---|
| 0 Single unit | Ramp to saturation | Ramp | — | Ramp | — | Safe limit of an API process, a cell primary (read, write and write-heavy mixes, including the hot company's write ceiling for T-05), the session/epoch store and each worker class; amplification per request; pool, pooler and timeout settings | NOT RUN |
| 1 | 10,000 | 1,000 | 1,500 | 16.7 | 1,000 / 100 | End-to-end harness, fixtures, telemetry, isolation tests under load | NOT RUN |
| 2 | 100,000 | 10,000 | 15,000 | 166.7 | 10,000 / 1,000 | Several cells, directory routing, placement | NOT RUN |
| 3 | 1,000,000 | 100,000 | 150,000 | 1,666.7 | 100,000 / 10,000 | T-05 decided and built; company moves under load | NOT RUN |
| 4 | 5,000,000 | 500,000 | 750,000 | 8,333.3 | 500,000 / 50,000 | Regional layout, shared-service limits | NOT RUN |
| 5 Full scale | 10,000,000 | 1,000,000 for 2 h | 1,500,000 for 15 min | 16,666.7 (20,000 provisioned) | 1,000,000 / 100,000 | ZT31–ZT35 | NOT RUN |

### 11.3 Full-scale scenarios (Stage 5)
- Load runs: 2-hour nominal hold; a separate 15-minute 1.5 M burst after nominal, with queues back to nominal within 15 minutes; 24-hour nominal soak (86.4 billion requests, ≥ 12.96 billion durable writes, including the hour-12 session-expiry wave).
- Cold-start and peak cases: cold cache; 10 M simultaneous logins within 10 minutes; a ten-million-view synchronized refresh (NFR-S10); representative worker jobs (payroll month end, shift-start ingestion, a policy change, mass celebrations, exports).
- Failures: zone loss at nominal load; regional loss with ≤ 15-minute recovery and acknowledged-outcome reconciliation; restore of sampled and complete ledgers.
- Integrity under load: two reviewers deciding the same item, duplicate provider callbacks, payment reservations, imports, company and shard moves, revocation while signed in (G4).

### 11.4 Gates
| Gate | Requirements | Evidence required | Status |
|---|---|---|---|
| ZT31 Concurrent capacity and burst | NFR-S01, S02, S03, S06 | Stage 5 report: 10 M distinct authenticated identities; 1 M offered req/s for 2 h and 1.5 M for 15 min after nominal; NFR-S03 met by operation and region; ≤ 0.05 % unexpected errors; no lost acknowledged write; queues back to nominal within 15 min; generator health; G2 fixture counts | BLOCKED (not run) |
| ZT32 Login and permission correctness at scale | NFR-S04, S08 | 10 M distinct login flows in 10 min with MFA, ≥ 20,000 flows/s provisioned; expiry, revocation, scope, field and DB109 negative tests passing under load, including cached and failed-authority cases; identity provider and MFA quotas and latency measured | BLOCKED (not run) |
| ZT33 Partition and transaction integrity | NFR-S06, S08; CI01–CI24 | Hot-company skew, company and shard moves with reconciliation, injected replica lag, concurrent decisions; zero orphans, duplicate entitlements or payments, self decisions, stale-grant leaks or lost acknowledged writes; CI checks on the full dataset | BLOCKED (not run) |
| ZT34 Failure recovery and soak | NFR-S05, S07, S09, S11 | Zone loss at nominal within limits; regional failover ≤ 15 min; RPO 0 reconciliation of every acknowledged financial, approval and audit result, RPO ≤ 5 min for the rest; restore reconciliation; 24-hour soak with flat connection and memory use, bounded retries and queue recovery | BLOCKED (not run) |
| ZT35 Capacity evidence and safe rollout | NFR-S10, S11, S12 | Measured per-unit and global capacity, signed dependency quotas, full workload evidence, saturation and queue metrics, topology and cost plan, staged rollout and rollback, reviewed by sponsor, platform lead, senior developer and QA. Untested or generator-limited capacity stays blocked | BLOCKED (not run) |

What blocks them all today:
- Nothing to run with: no load harness and no infrastructure code (no `load/` or `infra/` directory).
- Production pieces missing: no production entry points (`server.ts` and `worker.ts` are development-only), and no OIDC verifier, MFA, S3 file store, real scanner, session store, cache or directory.
- Open decisions: T-02 to T-05, ADR-04, ADR-05.
- No budget, quotas or test environment yet. ADR-00 leaves procuring these to humans.

### 11.5 Test report contents (G4)
Each test report records:
- Revisions and setup: build, schema (`schema_migration` checksums), policy and configuration revisions, topology and instance counts.
- Workload: data counts and skew, role and action mix, arrival schedule, offered versus completed rates, generator health.
- Results: p50/p95/p99 per operation and region; timeout, 5xx and throttle counts; authentication outcomes; pools, locks and replication lag; worker queues; failure windows.
- Reconciliation and cost: money and count reconciliation, resources used and cost.
- Verdict: PASS, FAIL or BLOCKED for each gate.

## 12 Cost model inputs to collect
No prices here (NFR-S12). The sponsor reviews the resulting plan before procurement.

| Input | Unit | Source |
|---|---|---|
| Per-unit capacity | req/s per API process by operation mix within NFR-S03 | Stage 0 |
| API and worker process cost | Per instance-hour | Provider quote (T-02) |
| Cells and partitions | Count from the §3.3 formulas | Stages 0–3 |
| Database instances per cell | Primary, zone standby, regional standby, replicas; instance class | Stage 0, §9 |
| Storage growth | GB/day per family = rows/day × bytes/row × (1 + index share) × copies | Bytes/row from Stage 0; row rates from §1.4 |
| Retention | Months per family (the owner's retention schedule; DF08 enables no purge) | Owner |
| Backups | Base-backup and WAL GB/day, retention, restore-test runs | §9.5 |
| Network | Egress (≈ 864 TB/day of responses at the payload assumption), inter-zone and inter-region replication (WAL × standbys), content cache | Measured payloads, WAL rate |
| Session/epoch store and cache | Memory per session × 10 M; operations/s | Stage 0 |
| Identity and MFA | Per active user or per authentication; per MFA message if applicable | Provider quote (T-03) |
| Object storage and scanning | GB stored by size class, requests, cost per scanned file | G2 mix, scanner quote |
| Queue or log | Throughput, partitions, retention | ADR-04 |
| Telemetry | Metric series, log GB/day after sampling, trace sampling | §10 |
| Load testing | Generator instance-hours per stage (Stage 5: 2-hour hold, burst, 24-hour soak, failover runs), fixture generation and storage, the soak's durable write volume | §11 |
| Contingency | Zone headroom (1.5 × with three zones), burst headroom, regional headroom R/(R−1) | §3.3, §9.3 |
| Operations | On-call and platform staffing | Owner |
| Result | Cost per completed business transaction = total cost per hour ÷ completed business requests per hour, per cell and in total | NFR-S12, G3 |

## 13 Decisions needed and next engineering steps

### 13.1 Decisions
| ID | Decision | Owner | Needed by |
|---|---|---|---|
| T-02 | Cloud provider and regions, including synchronous cross-region replication, dual-region object durability and key management | Owner | Before infrastructure code |
| T-03 | Identity provider and MFA factor, with a quota for 20,000 login flows/s | Owner, access owner | Before production authentication and ZT32 |
| T-04 | Cross-partition patterns P1–P7 (§5) | Platform lead, data owner | Before partitioning attendance or history |
| T-05 | Hot-company option A–D (§3.5); organisation units if C | Owner, platform lead, HR owner | Before Stage 3 |
| ADR-04 | Durable queue or log product and relay design | Platform lead | Before Stage 2 |
| ADR-05 | Session/epoch store and cache product | Platform lead, access owner | Before Stage 1 |
| CP-01 | RPO 0 through synchronous cross-region commit for every cell (latency and cost, §9.3) | Platform lead, sponsor | Before the regional layout |
| CP-02 | Session failover policy: synchronous revocation replication, or forced re-authentication after a regional failover (§9.4) | Access owner, platform lead | Before Stage 4 |
| CP-03 | Celebration delivery without per-recipient rows (§7.3) | HR and notification owners (DF12) | Before Stage 2 |
| CP-04 | In-process access engine as the NFR-S05 authorization service (§2.2) | Platform lead | Before Stage 1 |
| CP-05 | Request-log content (route pattern instead of raw URL), IP retention, log sampling (§10.3) | Security and privacy owner | Before Stage 1 |
| CP-06 | Per-company and per-user admission quotas derived from the selected journeys (§8.4) | Owner, platform lead | Before Stage 2 |
| CP-07 | Download links: API streaming only, or short-lived single-object links (§6.6) | Security owner (ADR-07) | Before the S3 store |
| CP-08 | Payroll run processing for very large companies: segments or bounded batches (§4.2) | Payroll module owner | Before payroll activation for a large company |

### 13.2 Next engineering steps (PROPOSED)
None of these is a capacity claim. Most touch files owned by module builders, so each is a proposal to them, not a change made by this document.
1. Stage 0 environment and harness skeleton: k6 open-loop scripts, generator-health metrics, a fixture generator built on the harness provisioning paths.
2. Measurement in the code: BUILT 2 Nov 2026: token-guarded `/internal/metrics`, off by default (pool counters, request counts and latency per route pattern and status class, per-request statement counts; no ids in labels); route-pattern request logs. `pg_stat_statements` belongs to the Stage 0 environment.
3. Overload behaviour: BUILT 2 Nov 2026: read, write and batch request deadlines; `statement_timeout` and `lock_timeout` set with `set local` per transaction; whole-run routes declare the batch budget; pool-wait, statement, lock, deadline and socket errors answer 503 with `Retry-After`; `cache-control: no-store` on every `/v1` answer. Open (low): statements outside a transaction can outlive the deadline up to the 15 s pool default; the §8.2 1 s connection wait and 10 s idle values are not applied; the disbursement and comparison reports keep the 3 s read budget. No value here is measured: MEASURE per G4.
4. Decision paths outside `decideTask` (payment release, payroll approval and release) re-resolve the permission inside their transaction as `decideTask` does (§6.5). BUILT and reviewed 2 Nov 2026: every mutating payroll path re-checks.
5. Worker: a critical outbox relay that runs outside the company loop, per-company fairness in claims, chunked reminders and celebrations, all scanning moved to the worker with backoff (attendance processing, monthly accrual and increment review opening are BUILT as bulk jobs with counts-only results and per-employee rows, ADR-15).
6. Schema: deterministic permission ids, company-prefixed object keys, UUID outbox keys and a generic immutability check for the intra-company key are BUILT and reviewed (0071, 2 Nov 2026; the check is attached to nothing until T-05 picks the key). Open: monthly partitions starting with `audit_event`, `notification_delivery_attempt` and `outbox_event_attempt`.
7. Session/epoch store behind `SessionStore`, and the access cache behind `resolveAccess`, following the §6.3 protocol.
8. Directory, edge routing and the company move protocol with reconciliation tooling.
9. A T-05 prototype on Stage 0 hardware.
