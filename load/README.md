# HRMS workload harness (BRD v8.2 Appendix G4)

The reusable workload harness that G4 asks for (ADR-09 reserves `load/` for it). It has three parts:

| File | What it does |
| --- | --- |
| `load/fixtures.ts` | Writes a synthetic G2 fixture straight into a **dedicated load-test PostgreSQL database**: companies provisioned with the application's own `provisionCompany`, people, assignments, managers, user links, role grants, balances, attendance history, workflow states created through the application's own services, and server-side sessions with tokens for every identity. It writes a manifest (`manifest.json` + `identities.ndjson`). |
| `load/generator.ts` | An **open-loop** generator. It sends the G2 operation mix to real routes of this API, each request as a distinct fixture identity with its own token and context headers. It measures latency from the **scheduled** time and checks its own health. It writes a JSON report and a short text summary. |
| `load/smoke.test.ts` | Checks the mechanics only: an embedded database, the app in-process, a tiny fixture and about 3 seconds at about 5 requests/second. It asserts no capacity number. |

Synthetic data only. TypeScript run with `tsx`; no extra npm packages.

> **G5 applies to everything this harness produces.** No capacity is claimed from arithmetic, architecture prose or a small run. ZT31-ZT35 are PASS only with full-scale G4 evidence reviewed by the platform lead, senior developer and QA. Otherwise they are BLOCKED or FAIL. A tiny local run, the smoke test included, proves **only that the harness works**. Every report ends with this statement, and the generator never marks a gate PASS.

## 1. Smoke test (harness mechanics)

```sh
npx vitest run load/            # from D:\HRMS; about 45 s, most of it embedded-database start-up
npx tsc -p load/tsconfig.json --noEmit
```

The root `vitest.config.ts` includes `load/`, so `npm test` runs the smoke test too. It uses the shared test harness (`apps/api/src/test/harness.ts`): an embedded PostgreSQL, the real app bound to `127.0.0.1:0`, and a 2-company, 50-identity fixture. It checks:

- the fixture shape (G2 skew, all 14 roles, distinct users, sessions, tokens and contexts) and the actual row counts;
- open-loop scheduling, with latency measured from the scheduled time;
- the operation mix within one request per category;
- distinct identities. A raw server listener confirms that no request carried another identity's token or headers;
- every report field;
- a route sweep. Every scripted operation must be accepted and every negative probe denied;
- a simulated generator fall-behind, which must make the run BLOCKED;
- distributed shards and merging;
- fixture sizing, and the G4-fixed holds of the full-scale stages.

## 2. Fixture generator

The fixture refuses the development database. It refuses port `54329` and the database `hrms_dev`, any database holding the development seed (company `DEMO`), and whatever `DATABASE_URL` points at in its own environment. So never export `DATABASE_URL` in the shell that runs `fixtures.ts`. Give it to the API process only (see section 3). Nothing defaults to a database: pass `--database-url` or set `LOAD_DATABASE_URL`.

```sh
export LOAD_DATABASE_URL=postgres://load:...@127.0.0.1:55432/hrms_load   # a separate, disposable database
export LOAD_TOKEN_SECRET=...        # the DEV_TOKEN_SECRET of the API under test; never on the command line
npx tsx load/fixtures.ts generate --migrate --out load/out/tiny          # default: 2 companies, 50 identities
npx tsx load/fixtures.ts generate --out load/out/10k --companies 50 --identities 10000 --pending-leave 32 --opening ANNUAL=48,CASUAL=6,SICK=6 --concurrency 6
npx tsx load/fixtures.ts rotate-sessions --manifest load/out/10k --out load/out/10k --revoke-old
```

What it creates:

- **Company skew (G2).** With at least 46 companies the shares are exactly G2: one company with 10% of identities, nine with 2% each, and the rest sharing 72%. With fewer companies the hot and large shares are scaled up by one common factor, so the order hot > large >= tail holds and the shares sum to 1. For example, 2 companies split 83.3% / 16.7%.
- **Role distribution (G2).** 90% Employee, 5% Reporting Manager, 2% HR Administrator, 1% System Administrator, and 2% split over the other ten baseline roles. Rounding error is carried across companies. `--no-cover-all-roles` turns off the default, which converts a few Employees so that every role has an identity. Deviations from the target are reported as warnings, never hidden.
- **People.** Each person gets an employee, an employment, shift, manager and user-employee link (DF16 hierarchy), a primary role context, and an Employee OWN context for own ESS work. Each role assignment gets its role's default duties, approved by a fixture approver and never by the beneficiary. Policies are activated by an HR Administrator who did not author them.
- **History.** `--attendance-days` working days of attendance results with punches, opening leave balances, and `--approved-history` past leave requests approved by the reviewer the rules select.
- **Workflow inventory**, all in valid states:
  - `--pending-leave` SUBMITTED requests per identity. Each becomes a decision for the reviewer the rules route it to, never the requester.
  - `--returned-per-identity` RETURNED requests (mean per identity) that the owner amends.
  - `--withdraw-per-identity` SUBMITTED requests (mean per identity) that the owner withdraws.
  - Correction candidates: absent and half days, set by `--absent-share` and `--half-day-share`.
  - Report jobs: `--reports-per-hr` per HR Administrator.
- **Sessions.** One live server-side session and token per identity, valid for `--session-hours` (at most 12, DF10). For `--dead-session-share` of identities it also adds a revoked and a server-expired session, used by the negative probes.

Bulk rows go in batches (`--batch-size`, default 1000). Workflow states go through the services, with `--concurrency` running in parallel. The CLI prints the **actual counts** read back from the database, the role totals against the G2 targets, the workflow inventory and warnings. The manifest records all of these, plus the applied migrations and a schema fingerprint.

**Handling the manifest.** `identities.ndjson` holds live bearer tokens of synthetic accounts. Keep it out of version control and out of shared logs, and let the sessions expire.

**Session lifetime.** Sessions go idle after 30 minutes without requests. Run `rotate-sessions` shortly before a run, which issues new tokens for every identity. A run also consumes workflow states. Restore a database snapshot before repeating a run. If you can't, pass the earlier runs' `records.ndjson` with `--consumed-from` and a later `--leave-from` date.

## 3. Generator

### The API under test

For local harness checks only:

```sh
DATABASE_URL=$LOAD_DATABASE_URL DEV_TOKEN_SECRET=$LOAD_TOKEN_SECRET FILE_STORE_DIR=load/out/files PORT=4100 npx tsx apps/api/src/server.ts
```

Use any free port except 3000 and 5173, and a file store of the load run's own, not `.dev-files`. The fixture's token issuer and audience (`hrms-dev` / `hrms-api` by default) must match the API's. A stage run targets the deployed topology under test, recorded with `--build` and `--topology`, never a development process.

### Commands

```sh
# Size the fixture inventory against a schedule (sends nothing; exit 3 if the fixture is too small)
npx tsx load/generator.ts plan  --manifest load/out/10k --phases 200:600,1000:7200 [--profile write-heavy] [--shard i/n]
# One request per operation and per negative probe: shows that the workload still matches the API (not load)
npx tsx load/generator.ts sweep --target http://127.0.0.1:4100 --manifest load/out/tiny --out load/out/sweep
# A run
npx tsx load/generator.ts run   --target http://127.0.0.1:4100 --manifest load/out/tiny --rate 5 --duration 30 \
     --consumed-from load/out/sweep/sweep-records.ndjson --out load/out/runs/tiny-1 --records
# Merge the shard reports of a distributed run
npx tsx load/generator.ts merge --out load/out/runs/10k-1/merged load/out/runs/10k-1/gen-*/report.json
```

Main `run` options:

| Option | Meaning |
| --- | --- |
| `--rate N --duration S` | One phase. |
| `--phases r:s,...` | Step-up or ramp phases. |
| `--profile nominal\|write-heavy` | The nominal mix is G2. Write-heavy is the separate 50%-write stress mix, with the other shares scaled proportionally. |
| `--arrival poisson\|uniform` | Arrival pattern. |
| `--mix deficit\|random` | How the mix is picked. `deficit` keeps every prefix of the arrivals within one request per category of the mix. |
| `--negative-share` | Share of negative probes (default 0.02). |
| `--timeout-ms` | Per-request timeout (default 10000). |
| `--max-in-flight` | In-flight limit. The default is peak rate x timeout x 1.2, at least 1000. An arrival beyond it is dropped and blocks the run. |
| `--stage NAME` | The G4 stage (see section 5). |
| `--stage-hold-seconds` | Declares a hold for an intermediate stage. The full-scale holds cannot be shortened. |
| `--shard i/n`, `--start-at`, `--generator-id`, `--region` | Distributed runs (see section 5). |
| `--build`, `--topology`, `--notes` | Labels recorded in the report. |
| `--out DIR` | Writes `report.json` and `summary.txt` here. |
| `--records` | Also writes `records.ndjson`, one line per request. |
| `--late-threshold-ms`, `--max-late-fraction`, `--max-loop-p99-ms`, `--max-loop-busy`, `--max-cpu` | Generator health limits (defaults: 50 ms, 1%, 100 ms, 90%, 90%). |

Exit codes: `0` PASS, `2` FAIL, `3` BLOCKED, `1` usage or error. A PASS here is the **run** verdict only (see section 4).

### How it schedules

All arrival times come from the schedule, whatever the latency of earlier requests (open loop). A late scheduler sends overdue arrivals immediately and records how late they were. It never skips or postpones arrivals, and it never lowers the offered rate when the system slows.

Each request records:

- its scheduled time, dispatch time, actual send time (socket assigned) and completion time;
- its status and error code;
- the identity and the token fingerprint it used.

Latency is completion minus **scheduled** time, so a stall in the system or the generator shows up as latency; it can't disappear (no coordinated omission). Service time (completion minus send) is reported separately.

### Workload

Each arrival gets a G2 category, then an operation inside it by weight, then the least recently used eligible identity. Eligibility follows the identity's default duties and fixture inventory.

| Category (G2 share) | Operations (routes under `/v1`) |
| --- | --- |
| 50% scoped dashboard/list reads | `GET /dashboard`, `GET /employees?page=1&pageSize=25` |
| 20% own attendance/leave/profile reads (OWN context) | `GET /me/ess`, `/employees/:own/leave-balances`, `/employees/:own/attendance?from&to`, `/employees/:own/leave-requests`, `/employees/:own`, `/me/requests` |
| 10% team/task/report-status reads | `GET /my-team`, `/my-team/:report`, `/leave/tasks`, `/attendance-corrections/tasks/mine`, `/work-requests/tasks/mine`, `/profile-changes/tasks/mine`, `/reports/:id` |
| 15% submissions/amendments/decisions | `POST /leave/requests`, `POST /leave/tasks/:id/decision` (approve, or reject every fifth, with idempotency keys), `PUT /leave/requests/:id` (resubmit RETURNED), `POST /leave/requests/:id/withdraw`, `POST /me/attendance-corrections` |
| 5% session/notification metadata | `GET /me/notifications`, `/me/context`, `/me/assignments`, `/me/permissions` |

Negative probes must be denied; a 2xx answer is an integrity failure. They cover:

- a missing duty for the employee list;
- a missing duty for a task queue, so every role issues negative requests in its own context;
- another company's records, in the role context and in the OWN context;
- a colleague's record in OWN scope;
- someone outside the reviewer's team;
- another reviewer's task;
- a revoked session and a server-side expired session.

`/me/context` and `/employees/:own` answers are checked against the requesting identity, which catches cache or session mix-ups.

## 4. What the report means

`report.json` (schema `hrms-load-report/2`) holds the following sections:

| Section | Contents |
| --- | --- |
| `run`, `environment` | Schedule, phases, seed, shards, harness version, and the build/topology labels. |
| `fixture` | Fixture id, schema migrations and fingerprint, actual counts, skew, roles, and inventory against the schedule. |
| `totals` | Offered, valid offered, sent, completed, not sent, OK, denied as expected, unexpectedly allowed, identity mismatches, 4xx, 429, 5xx, timeouts, network errors, dropped, S03 failures and their rate. |
| `rates` | Offered, sent and completed per second inside the schedule window, plus sends and completions after it (drain). |
| `latency` | p50/p95/p99/max from the scheduled time: overall, reads, mutations, per category, per operation, per role, per company tier and per region. |
| `serviceTime` | The same from the actual send time. |
| `statusCounts`, `errorCodes`, `operations` | Per-status counts, per-error-code counts, and per-operation outcomes. |
| `mix` | Target against actual. Also lists operations the fixture could not cover, inventory that ran out, and arrivals that could not be planned. |
| `identities` | Distinct identities used, requests per identity, active identities per minute, and role coverage (positive and negative). |
| `negative` | Probe results by kind and denial code. |
| `phases` | Per-phase results with S03. |
| `timeline` | Per-second offered, sent, completed and failures. |
| `generator` | Health per generator: late sends, lateness and dispatch lag, dropped arrivals, event-loop delay and utilisation, CPU, memory, preflight. |
| `s03` | Every NFR-S03 check. |
| `verdict` | The verdicts described below. |
| `raw` | Mergeable aggregates. |

The text summary (`summary.txt`) condenses the same information.

**Run verdict.** It is decided in this order:

1. **FAIL** on any integrity failure: a probe was allowed, or a response belonged to another identity.
2. **BLOCKED** if the generator was unhealthy, the fixture was insufficient, or a probe was answered with an unexpected status. A generator that fell behind (more than 1% of sends over 50 ms late), dropped arrivals, or ran short of CPU, event-loop time or memory measured itself, not the system. A blocked run is never passed.
3. **FAIL** on an S03 miss: read p95/p99 1/3 s, mutation p95/p99 2/5 s, per operation and per region; failure rate 0.05% of valid requests; any valid scripted request refused.
4. **PASS** otherwise. PASS means only that S03 held at **this run's own offered load**. It is not stage or gate evidence.

**Stage verdict.** It is judged on the hold, the longest run of phases at the stage rate (ramps are allowed):

- `harness-check` is always BLOCKED.
- One shard of a distributed run is BLOCKED until merged.
- A G4 stage is BLOCKED until the run reached all of these:
  - the stage's distinct identities, active in every full minute of the hold;
  - its offered valid rate, for its hold;
  - positive and negative requests from every fixture role.
- `single-unit` reports a safe-limit candidate. That is the last step that met S03 before the first one that missed it, for the recorded topology only, and it needs review.

**Gates ZT31-ZT35** are never PASS from a run. They are FAIL when the run shows a failure the gate covers, and otherwise BLOCKED, with what each still needs listed.

**Outside the report.** G4 report contents that a load generator cannot measure must come from the system side:

- database pools, locks and replica lag;
- worker queues;
- failure windows;
- monetary and count reconciliation;
- resources and cost;
- real login and MFA flows (ZT32). Pre-issued development tokens are not authentication proof.

## 5. G4 stages and distributed generators

Rates follow G1: one business request per active identity every 10 s. Negative probes come on top. The full-scale holds come from G4. G4 sets no hold for the intermediate stages, so they default to 2 h; a test plan may declare another, and the report records it.

| `--stage` | Identities in the fixture and active | Offered valid RPS (sum of all generators) | Hold |
| --- | --- | --- | --- |
| `single-unit` | as the unit needs | step-up phases, e.g. `50:300,100:300,200:300,400:300,800:300` | until S03 is missed |
| `10k` | 10,000 | 1,000 | 2 h (declarable) |
| `100k` | 100,000 | 10,000 | 2 h (declarable) |
| `1m` | 1,000,000 | 100,000 | 2 h (declarable) |
| `5m` | 5,000,000 | 500,000 | 2 h (declarable) |
| `10m` | 10,000,000 | 1,000,000 | 2 h (fixed by G4) |
| `10m-burst` | 10,000,000 | 1,500,000 | 15 min (fixed by G4) |
| `10m-soak` | 10,000,000 | 1,000,000 | 24 h (fixed by G4) |

G4 requires each stage to pass before the next. Intermediate passes guide tuning and funding, but they are never a ten-million-user pass. G4 also needs cold-cache, simultaneous-login, mass-refresh, zone-loss and regional-failover runs. Those are separate test runs with system-side evidence.

**Distributed run.** Each of N generator hosts loads the same manifest with `--shard i/N` and keeps the identities with `index % N == i`, so no two generators ever act as the same person. Every host uses the same `--phases` with **per-generator** rates (total / N), the same `--stage` and `--seed`, a common `--start-at` (ISO time or epoch ms), its own `--generator-id`, and its serving `--region`. Example for the 10k stage on 4 hosts:

```sh
# host i (0..3)
npx tsx load/generator.ts run --target https://<api-under-test> --manifest load/out/10k --stage 10k \
  --phases 50:600,250:7200,50:300 --shard i/4 --start-at 2026-11-02T10:00:00Z --generator-id gen-i --region <region> \
  --build <build-id> --topology <topology-id> --out runs/10k-1/gen-i --records
# afterwards, anywhere
npx tsx load/generator.ts merge --out runs/10k-1/merged runs/10k-1/gen-*/report.json
```

The merged report sums counts and histograms exactly and judges S03 per region once more than one region reports. Its run is BLOCKED if any generator was unhealthy, and its stage is BLOCKED if any shard report is missing. Merging refuses reports with different fixtures, phase durations, profiles, stages, shard counts or report schemas, and refuses a shard that appears twice. Before a stage run:

1. Run `plan` for every shard: the fixture inventory must cover the schedule.
2. Run `sweep`: every operation is accepted and every probe denied on the deployed build.
3. Run `rotate-sessions`.
4. Size each generator so that it stays healthy at its share of the rate. Generator capacity and provider quotas are verified, not assumed (G4).

**Sizing.** In the nominal profile the consumable operations take these shares of arrivals: decisions 4.41%, resubmissions 1.47%, withdrawals 0.735%, corrections 1.47%. The write-heavy profile takes about 3.3 times as much. `plan` computes the exact numbers for a schedule. For example, the 10k stage holds 1,000 RPS for 2 h, about 7.2 million arrivals. That needs about 318,000 pending decisions, so `--pending-leave 32` on 10,000 identities. Pending requests are ANNUAL leave, so raise `--opening ANNUAL=...` above the pending count plus `--approved-history`. The services refuse any request the leave policy does not allow, and the fixture skips it and lists it in its warnings. Read the warnings and the actual inventory before a run.

## 6. Not covered yet (open)

These items are known gaps. Each blocks the G4 evidence it concerns, and none is claimed as covered.

- **G2 rows the mix does not cover yet:**
  - financial work (expense, payroll) in the scoped Admin context;
  - the documents/outputs fixture (10 million document metadata rows, file sizes, concurrent exports);
  - the special peaks (shift-start ingestion, payroll month end, login burst, synchronized refresh);
  - cold and warm cache runs;
  - the 12-month and 7-year history cohorts.
- **Large fixtures are slow to build.** Workflow states are created through the application services one by one, bounded by `--concurrency`. That is correct, but slow for million-scale fixtures. Generate once and restore a snapshot.
- **The 24-hour soak outlives its sessions.** Sessions last at most 12 hours (DF10), and the generator cannot rotate tokens during a run. So the `10m-soak` stage cannot complete with this generator yet.
- **Logins are not tested.** Identities use pre-issued development tokens; real login and MFA flows (ZT32) are not exercised.
