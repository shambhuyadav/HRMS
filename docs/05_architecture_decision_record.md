# 05 Architecture Decision Record

Status key: **APPROVED** = chosen by the project owner (24 Oct 2026). **PROPOSED** = recommendation pending approval.

## ADR-00 Delivery model – APPROVED: Claude-driven development
Claude writes the code, migrations, tests and documents in supervised sessions. The project owner runs and reviews.
Things Claude cannot do, which stay with humans (BRD-mandated):
- Business-owner acceptance and sign-offs (HR, Payroll, Finance, Access, QA, Sponsor).
- Procuring cloud accounts, infrastructure budget, provider quotas and contracts.
- Running the distributed 10M-user load test on real infrastructure (Claude writes the harness and the infrastructure-as-code).
- Supplying statutory rate packs, biometric/email/bank provider contracts and source-data extracts.
- Production deployment (separately authorised).
**Recommendation:** have at least one human engineer review security-critical code (RBAC, payments, migrations) before any release.

## ADR-01 Backend – APPROVED: Node.js (v24 LTS line) + TypeScript (strict)
- HTTP framework: **Fastify** (PROPOSED). High throughput, schema-validated routes, low overhead per request, which matters for 1M RPS (NFR-S01).
- Structure: modular monolith (`apps/api/src/modules/*`), stateless, deployed as many identical cells (G3). Modules: access, org, employee, attendance, leave, workflow, notification, biometric, confirmation, increment, expense, payment, reporting, audit, then wave 2 modules.
- Data access: **Kysely** (typed SQL builder) over `pg` (PROPOSED). Hand-written SQL migrations, because the constraints (composite FKs, EXCLUDE, deferred) must be explicit.
- Money: integers or `decimal.js` only. Never JS `number` for money or quantities (B1 MONEY/QTY).
- Validation: TypeBox/JSON Schema on every route.
- Background workers: separate Node processes reading the outbox and queue.

## ADR-02 Frontend – APPROVED: React + TypeScript
- Vite build, React Router, TanStack Query (PROPOSED).
- The client shows only server-supplied permitted actions. All authorization is enforced on the server.
- Dashboard refresh: ≥60 s with jitter, paused in hidden tabs, coalesced (DF17, NFR-S10).

## ADR-03 Database – PROPOSED: PostgreSQL 16+
Reason: composite same-company FKs, `EXCLUDE USING gist` for non-overlapping effective intervals, deferrable constraints for typed-transaction roots, `NUMERIC(19,4)`, partitioning, row-level security as a second layer.
Scale: one PostgreSQL cluster per cell (company-partitioned), not one global database (G3).

## ADR-04 Async – PROPOSED: transactional outbox table + durable queue (Kafka or managed equivalent at scale; outbox polling in dev)

## ADR-05 Cache/session – PROPOSED: Redis. Keys bound to assignment, permission version and field class. Fail closed.

## ADR-06 Identity – PROPOSED: external OIDC provider with MFA in production. Dev uses a local signed-token issuer with synthetic users only.

## ADR-07 Files – PROPOSED: S3-compatible object storage with opaque references. Downloads go through the parent-record authorization check.

## ADR-08 Hosting – PROPOSED: Kubernetes on a major cloud, multi-zone, multi-region, cell-based. Provider to be chosen by the owner (T-02).

## ADR-09 Repository & tooling – PROPOSED
- npm workspaces monorepo: `apps/api`, `apps/web`, `apps/worker`, `packages/shared`, `db/migrations`, `load/` (k6 harness), `infra/`.
- Tests: Vitest; integration and constraint tests against a real PostgreSQL. Uses `TEST_DATABASE_URL` when set (CI/Docker), otherwise embedded PostgreSQL 17 binaries (no Docker needed). Direct-SQL constraint tests (ZT06); concurrency tests (ZT11).
- Data access in security-critical code (access engine, decisions, ledgers) uses explicit parameterised SQL, so predicates can be reviewed directly. Kysely remains an option for ordinary CRUD.
- Load: k6 (distributed, open-loop arrival executors) for NFR-S01–S04.

## ADR-10 Business modules – APPROVED (25 Oct 2026): data-only module registrations
- Each business module added after the core declares, as plain data in `apps/api/src/modules/<module>/registration.ts`, what it adds to the baseline: role grants (ceilings and default duties), operational field groups, approval routes, notification templates, reference values, the dashboard classification of its transaction kinds and its My ESS tabs. `access/baseline.ts`, company provisioning, the dashboard, the outbox dispatcher and the ESS index read the registrations, so a module never edits those shared files. Routes and event describers are listed in `routes-registry.ts` and `events-registry.ts`.
- A module under construction is `active: false` and invisible to every run except those that name it in `HRMS_DRAFT_MODULES`. Its migration is `NNNN_name.draft.sql`, applied only where named in `HRMS_DRAFT_MIGRATIONS`. Both are refused in production. Activation (rename the migration, set `active: true`) is one step, taken when the module's tests pass. Tests of an inactive module are wrapped in `describe.runIf(isModuleActive(...))`.
- Why: several builders work in one tree at once; a half-written module or migration must not break anyone else's runs, and shared files must not become merge hot spots.

## ADR-11 Protected private values – APPROVED (25 Oct 2026): application-level envelopes
- Proposed and approved private profile values (personal, address, bank; H4, DB115/DB116) are stored as AES-256-GCM envelopes (`apps/api/src/security/field-crypto.ts`), each bound by additional authenticated data to its purpose, company, owner and row, so a ciphertext moved elsewhere fails to open. Keys come from `HRMS_FIELD_KEYS` (first key seals; others open older envelopes for rotation). Production refuses to start without keys; development uses a fixed development key. Audit records and events carry field names only.
- Open: key custody and rotation schedule (KMS/HSM) belong to the deployment decision T-02/T-03.

## ADR-12 Upload quarantine – APPROVED (25 Oct 2026)
- Every user upload is stored as PENDING_SCAN and served only after a malware scanner releases it (CLEAN); a finding quarantines it for good. The scanner is an injected `ScanProvider`; production refuses to start without one; development and tests use a synthetic scanner that flags only the EICAR test string. The worker retries pending files after an outage. Evidence on requests is readable by the owner and the reviewers assigned to that transaction, released files only, each read audited (I-21, I-22).

## ADR-13 Outbox delivery – APPROVED (25 Oct 2026)
- Each outbox event is processed in its own savepoint; a failure is retried after 1, 5 and 15 minutes (DF12) and then marked FAILED, with each attempt recorded (error class only, never payload values). A failing event never holds back the events behind it.

## ADR-14 Serving budgets – PROPOSED (25 Oct 2026; to be measured per G4)
- Per API process: database pool 10 connections, statement timeout 15 s, idle-in-transaction timeout 30 s, connection wait 10 s (all overridable through `DB_*` environment variables). Every request carries an `x-request-id` (a well-formed inbound id is kept) that is logged and returned. `/health` is liveness; `/ready` checks the database and reveals no detail. The API and worker shut down gracefully on SIGTERM. These are starting budgets for the single-unit saturation test, not capacity claims (Appendix G5).
- Overload is explicit (26 Oct 2026; docs/09 §8.2, NFR-S10): a statement, lock or idle-in-transaction timeout, a connection limit or shutdown, a dropped connection and the pool's own wait timeout answer 503 `UNAVAILABLE` with `Retry-After: 5`, never 500, and name no cause. Every `/v1` answer carries `cache-control: no-store`. Request logs record the method, route pattern, status and request id; never the raw URL (query strings hold searches), the client address (IP retention is decision CP-05), tokens, cookies or driver error detail (NFR-S11, docs/09 §10.3).
- Deadlines (2 Nov 2026): every `/v1` request runs under a read, write or batch deadline with matching `set local` statement and lock timeouts, configured by `HTTP_*_DEADLINE_MS`, `DB_*_STATEMENT_TIMEOUT_MS` and `DB_*_LOCK_TIMEOUT_MS`; metrics are token-guarded by `HRMS_METRICS_TOKEN` and off by default. Still starting budgets, not measurements.

## ADR-15 Bulk jobs – PROPOSED (28 Oct 2026; built; chunk sizes to be measured per G4)
- No request runs a company-wide loop (NFR-S09). Such a request validates and authorises as before, records a `bulk_job` (migration 0053) and answers 202 `{ jobId, state: 'QUEUED' }`. Today the two kinds are attendance processing (FR-022) and monthly leave accrual (DF05). The job stores its requester, acting assignment and permission. An optional idempotency key returns the same job to the same requester with the same parameters; any other use of the key gets 409.
- The worker (`modules/bulk/service.ts` `runBulkJobs`, called on every scheduler tick before the company loop) claims ready jobs with `for update skip locked` and runs one chunk per transaction, with at most `BULK_CHUNK_SIZE` employees in a stable keyset order. The employee set, row scope and per-employee rules are those of the synchronous code. Every chunk re-resolves the stored authority with `resolveAccess`; a lost grant ends the job FAILED `ACCESS_REVOKED`. The cursor and running counts commit with the chunk's effects, so a crash or retry resumes without double effects. A failing chunk rolls back alone and is retried after 1, 5 and 15 minutes (ADR-13), then the job is FAILED with an error class. The module's audit record is written once, with the last chunk.
- Status (`GET /v1/bulk-jobs/:id`, `GET /v1/bulk-jobs`) is for the requester under the same assignment only, and only while the job's permission still holds. A new kind adds its code to the `bulk_job` kind check (a migration) and an entry in `modules/bulk/kinds.ts` (permission, chunk step, completion record). The increment review opening is the next one.

## Open technical decisions
| ID | Decision | Needed by |
|---|---|---|
| T-02 | Cloud provider | Before infra-as-code (Phase 1 end) |
| T-03 | Identity provider | Before production auth |
| T-04 | Cross-partition FK enforcement pattern | Before partitioning attendance/history |
| T-05 | Intra-company partitioning for the 10% hot company | Before the 1M-scale test |
