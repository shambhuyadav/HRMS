# Data migration toolkit

Moves a company's records from its old HR system into this one, with the BRD's data checks (§9.4 DQ-01 to DQ-15) before
anything is written and the migration reconciliation (ZT19) after. The old system's Excel exports are saved as **CSV UTF-8**
into one folder (the *extract*) next to a `manifest.json` that says what each file and column means.

```
npx tsx db/migrate-data.ts validate  --extract <folder> [--company ACME] [--out <folder>]
npx tsx db/migrate-data.ts load      --extract <folder> --company ACME --operator hr.admin@acme.example            (dry run)
npx tsx db/migrate-data.ts load      --extract <folder> --company ACME --operator hr.admin@acme.example --commit --confirm ACME
npx tsx db/migrate-data.ts reconcile --extract <folder> --company ACME [--operator hr.admin@acme.example]
```

Environment: `DATABASE_URL` (for `--company`, load and reconcile); `FILE_STORE_DIR` for load (the API's upload directory: the
generated import files are kept with their batches); with `NODE_ENV=production` the ClamAV scanner (`CLAMD_SOCKET` or
`CLAMD_HOST`/`CLAMD_PORT`). Reports go to `<extract>/reports` unless `--out` is given. Exit code 0 success, 1 failure, 2 refused.

| Step | Writes to the company | Report |
| --- | --- | --- |
| validate | nothing (the company, when named, is read in a read-only transaction) | `validation.json`, `validation.md` |
| load without `--commit` | nothing: validates against the company and prints the stages | `validation.*` |
| load `--commit --confirm <code>` | the records, through the import pipelines, as the operator | `load.json`, `load.md` |
| reconcile | nothing | `reconcile.json`, `reconcile.md` (ZT19) |

## Steps

1. **validate** runs every DQ check and lists, per check, PASS, FAIL or MANUAL, what was checked automatically, every failing
   row (file, spreadsheet line, employee or master code or loan reference, field, reason) and, for the sign-off items, a
   checklist with a place for the reviewer's name and date. Rows are never shown with a name, email, identity number or a
   person's amount. Without `--company`, values only the company holds (shifts, a department that is in no master file) are
   *unverified* (MANUAL), never passed.
2. **load** validates again against the company and refuses on any FAIL, on a missing grant of the operator, or without
   `--commit --confirm <company code>`. It then runs, in order, each stage all or nothing:

   | Stage | Path (the same code as the screens) |
   | --- | --- |
   | masters | org master create, only for codes the company lacks |
   | employees | `EMPLOYEE_ONBOARDING_V1`: drafts with their joining placement |
   | assignments-N | `EMPLOYEE_UPDATE_V1`: the N-th dated placement change |
   | shifts | `SHIFT_PLAN_V1` |
   | activation-0 | employee activation of the top of the reporting chain (declared no-manager reason) |
   | managers-D, activation-D | `EMPLOYEE_UPDATE_V1` reporting lines of depth D, then activation (a manager must be active) |
   | salary | `SALARY_MASTER_V1`: the arrangement in force at cut-over |
   | leave-opening | `LEAVE_OPENING_V1` |
   | loans | `LOAN_REQUESTS_V1`: requests that wait for their independent decision |

   Each import batch is an ordinary import job of the operator (malware-scanned file, preview, commit, row outcomes) under the
   idempotency key `data-migration:<migrationId>:<stage>:<file hash>`; each stage is also recorded on the audit trail as
   `data_migration` / `LOAD_STAGE` with the manifest and source-file checksums and the source lines (CI16). A repeat run skips
   what is committed and duplicates nothing; a rejected stage stops the run with its row codes and can be retried after a fix.
   The operator acts under their own active role assignments (the first that allows each stage), exactly as on the screen.
3. **reconcile** compares the extract with the company: counts per entity (source rows, not loaded with their approved reason,
   expected, matched), missing, mismatched, extra, duplicate and orphan records, money totals per salary field and currency,
   per loan kind and currency and leave units per type, explained follow-ups (confirmations and loan decisions that a workflow
   in the system completes), the import batches, and DQ-12 (the salary master report run as `--operator`, and headcount per
   department, against the records). **ZT19 is PASS only with zero unexplained records and zero money difference.**

## The manifest

See `sample/manifest.json` (a synthetic extract used by the tests). Keys:

| Key | Meaning |
| --- | --- |
| `manifestVersion` | `1` |
| `migrationId` | identifies the migration (letters, digits, `-`, `_`); part of every batch key |
| `sourceSystem`, `company` | the old system's name; the target company code (optional; must match `--company`) |
| `cutoverDate` | `YYYY-MM-DD`; balances and the salary in force are as of this day |
| `formats` | `date` pattern of the extract (`DD-MM-YYYY`, `DD/MM/YYYY`, `DD-MMM-YYYY`, `YYYY-MM-DD`...), `thousandsSeparator`, `trueValues`/`falseValues` |
| `files[]` | `file`, `entity`, `owner` (DQ-01), `columns` (legacy column -> field), `ignoredColumns` (deliberately not migrated) |
| `ignoredFiles` | other `.csv` files in the folder that are not migrated |
| `codeMaps` | per reference kind (`department`, `location`, `designation`, `grade`, `employmentType`, `leaveType`, `shift`, `loanKind`, `currency`): legacy code -> code (DQ-05). A legacy code that already is a valid code needs no entry |
| `statusMaps` | `employee`: legacy label -> `DRAFT`, `ACTIVE_PROBATION`, `ACTIVE_CONFIRMED`, `NOTICE`, `INACTIVE_SEPARATED`, `ARCHIVED`; `loan`: legacy label -> `REQUESTED`, `APPROVED`, `DISBURSED`, `REJECTED`, `WITHDRAWN`, `CANCELLED`, `CLOSED` (DQ-07) |
| `exclusionPolicies` | for each kind of row not loaded, `{ reason, approvedBy, approvedOn }` (DQ-09, ZT19): `INACTIVE_EMPLOYEE`, `CLOSED_LOAN`, `INACTIVE_MASTER`, `SALARY_HISTORY`, `ZERO_LEAVE_BALANCE` |
| `policies` | `noManagerReason` (activation of the top of the chain), `loanAmountBasis`: `PRINCIPAL` or `OUTSTANDING` |
| `amountClassification` | `"entity.field"` -> `CAPTURED`, `DERIVED` or `AGGREGATED` for every amount (DQ-11) |
| `controlTotals` | per entity, the old system's own report totals: `rows`, `byStatus`, `byDepartment`, `amounts.<field>.<currency or leave code>` (DQ-11) |
| `dispositions[]` | one row set aside: `{ file, line, action: "EXCLUDE", reason, approvedBy, approvedOn }` (ZT19) |
| `signOffs` | per DQ check, `{ reviewer, date, evidence }` once a named person has confirmed its checklist |

Entities and fields (`*` required; `+` required for an employee who will be active):

| Entity | Fields |
| --- | --- |
| `department`, `location`, `designation`, `grade` | `code*`, `name*`, `active` (flag) |
| `employee` | `employeeCode*`, `displayName*`, `workEmail+`, `joiningDate*`, `employmentType*`, `status*`, `departmentCode*`, `locationCode*`, `designationCode*`, `gradeCode`, `managerEmployeeCode`, `managerFrom`, `shiftCode+`, `shiftFrom`, `identityNumber` (duplicate check only; never loaded or reported) |
| `assignment_history` | `employeeCode*`, `effectiveFrom*`, `departmentCode*`, `locationCode*`, `designationCode*`, `gradeCode`; the first row is the joining placement, the last the employee file's |
| `salary` | `employeeCode*`, `effectiveFrom*`, `annualCtc*`, `monthlyGross*`, `currency*` |
| `leave_opening` | `employeeCode*`, `leaveType*`, `units*`, `effectiveDate` (default: cut-over) |
| `loan` | `loanReference*`, `employeeCode*`, `loanKind*`, `currency*`, `principal*`, `outstanding` (* with basis `OUTSTANDING`), `status*`, `purpose*`, `sanctionDate` |

## What is not migrated, and why

- **Separated or archived employees** (and their salary, leave and loan rows): the onboarding import creates employments, not
  ended ones. They must be excluded under an approved `INACTIVE_EMPLOYEE` policy and stay in the archived extract.
- **Confirmation, notice and exit**: loaded employees are activated (on probation) through the ordinary activation; a confirmed
  or notice status is completed through its workflow and is listed by reconcile as a follow-up, not a difference.
- **Salary history**: `SALARY_MASTER_V1` records one initial arrangement; earlier revisions are excluded under `SALARY_HISTORY`
  and later ones go through increment cases. Salary components are not in the template.
- **Loan decisions, disbursement and recoveries**: each open loan is a request (at its principal or outstanding amount, as
  declared) that an eligible Admin other than the operator decides in the system.
- **Documents**: binary files follow the existing bulk document upload and `DOCUMENT_MAPPING_V1` on the screen.
- **Personal values** (birth date, personal contact, bank, identity numbers): never imported by these templates; they come
  through the sensitive-change workflow.
- **The old system's change history**: archived outside this system (DQ-08 sign-off).
