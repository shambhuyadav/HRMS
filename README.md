# HRMS (BRD v8.2 target implementation)

Synthetic data only. Not deployed anywhere. Planning and evidence live in [docs/](docs/00_README.md).

## Run locally (no Docker needed)

```powershell
npm install
npm run db:dev                      # terminal 1: embedded PostgreSQL on 127.0.0.1:54329 (data in .dev-pg/)

$env:DATABASE_URL = 'postgres://hrms:hrms_local_only@127.0.0.1:54329/hrms_dev'
$env:DEV_TOKEN_SECRET = 'replace-with-a-local-random-string-of-32-plus-chars'
npm run db:seed                     # migrate + seed the synthetic DEMO company (idempotent)
npm run dev:api                     # terminal 2: API on http://127.0.0.1:3000
npm run dev:web                     # terminal 3: web app on http://localhost:5173
```

The seed prints the accounts. Sign in with an account key (development sign-in only):

| Account | What to try |
|---|---|
| `employee@demo.test` | Dashboard, leave balances and requests, expense claims, notifications |
| `manager@demo.test` | Choose *Reporting Manager*: My Team, team dashboard, leave decisions; or *Employee* for own requests |
| `hr.admin@demo.test` | Employees, reports, confirmation decisions (HR fallback reviewer) |
| `finance@demo.test` | Finance-duty Admin context: expense decisions and payments |
| `sys.admin@demo.test` | Access administration, delivery log |

Optional: `npm run dev:worker` (with `SYSTEM_USER_ID` set to a user id) runs the scheduler: notifications, reports, reminders, celebrations, effective-dated private profile changes, upload rescans and the daily jobs of active modules (`apps/api/src/modules/jobs-registry.ts`).

## Configuration (development defaults; production must set its own)

| Variable | Purpose | Development | Production |
|---|---|---|---|
| `HRMS_FIELD_KEYS` | `id:base64key[,id:key]` for sealing private profile values (ADR-11); the first key seals | built-in development key | required (start-up fails without it) |
| scanner (code: `AppDependencies.scanner`) | malware scanner for uploads (ADR-12) | synthetic scanner (flags the EICAR test string only) | required |
| `FILE_STORE_DIR` | local file store for uploads | `.dev-files` | an S3-compatible store (ADR-07) |
| `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, `DB_CONNECTION_TIMEOUT_MS` | per-process database budgets (ADR-14) | 10, 15000, 30000, 10000 | sized per serving unit after measurement |

`/health` is liveness, `/ready` checks the database; every response carries `x-request-id`.

## Building a module alongside others (ADR-10)

A business module declares its grants, routes, notifications and dashboard classification in `apps/api/src/modules/<module>/registration.ts`. While it is being built it stays `active: false` and its migration is `NNNN_name.draft.sql`; run its tests with both switches, for example:

```powershell
$env:HRMS_DRAFT_MIGRATIONS = '0049_assets.draft.sql'; $env:HRMS_DRAFT_MODULES = 'assets'; npx vitest run apps/api/src/modules/assets/
```

Rename the migration to `.sql` and set `active: true` in one step once its tests pass. Both switches are refused in production.

## Tests

```powershell
npm test            # API + database suite (embedded PostgreSQL, cloned per test file) and web tests
npm run typecheck   # API and web
```
