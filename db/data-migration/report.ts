// Reading an extract folder and writing the toolkit's reports: JSON for tools and Markdown for people. Reports identify rows by
// file, line and business key (employee code, master code, loan reference) and never carry a name, email, identity number or a
// single person's amount (CI16; DF09 "No genuine employee information belongs in shared documentation"). They do carry the
// extract's aggregate payroll totals, so they are marked confidential.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Analysis, ExtractInput } from './analyse.js';
import type { LoadResult, Stage, StageOutcome } from './load.js';
import { parseManifest } from './model.js';
import type { ReconcileReport } from './reconcile.js';

/** The extract: every .csv file at the top of the folder and the manifest (manifest.json in the folder unless given). */
export async function readExtract(dir: string, manifestPath = join(dir, 'manifest.json')): Promise<ExtractInput> {
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf-8')));
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && /\.csv$/i.test(entry.name)) files.set(entry.name, await readFile(join(dir, entry.name)));
  }
  return { manifest, files };
}

const CONFIDENTIAL = '> Confidential: aggregate payroll totals of the company. Rows are named by file, line and code only; no personal value is shown.';

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const at = (f: { file?: string; line?: number; key?: string; field?: string }) => [f.file, f.line !== undefined ? `line ${f.line}` : '', f.key ? `[${f.key}]` : '', f.field ? `\`${f.field}\`` : ''].filter(Boolean).join(' ');

/** The validation report without the load plan (which holds names, emails and amounts). */
export function validationJson(a: Analysis) {
  const { plan, ...rest } = a;
  return {
    ...rest,
    planned: {
      masters: Object.fromEntries(Object.entries(plan.masters).map(([k, v]) => [k, v.length])),
      employees: plan.employees.length,
      activated: plan.employees.filter((e) => e.activate).length,
      salaries: plan.salaries.length,
      leaveOpenings: plan.leaveOpenings.length,
      loans: plan.loans.length,
    },
  };
}

export function validationMarkdown(a: Analysis, generatedAt: Date): string {
  const out: string[] = [];
  out.push(`# Data migration validation: ${a.migrationId}`, '');
  out.push(`Source system: ${a.sourceSystem}. Cut-over date: ${a.cutoverDate}. Target: ${a.target ? `company ${a.target.companyCode} (read only)` : 'not checked (no database given)'}. Generated ${generatedAt.toISOString()}.`, '');
  out.push(CONFIDENTIAL, '');
  out.push(`**Result: ${a.failed ? 'FAIL - the load will refuse this extract' : 'no failures'}**`, '');
  out.push('| Check | Result | Findings | Sign-off |', '| --- | --- | --- | --- |');
  for (const c of a.checks) out.push(`| ${c.id} ${c.title} | ${c.status} | ${c.findings.length} | ${c.signOff ? `${esc(c.signOff.reviewer)}, ${c.signOff.date}` : c.status === 'MANUAL' ? 'awaiting' : ''} |`);
  out.push('', '## Source files', '', '| File | Entity | Rows | SHA-256 |', '| --- | --- | --- | --- |');
  for (const s of a.sources) out.push(`| ${esc(s.file)} | ${s.entity} | ${s.rows} | \`${s.sha256.slice(0, 16)}...\` |`);
  for (const c of a.checks) {
    out.push('', `## ${c.id} ${c.title}: ${c.status}`, '', 'Checked automatically:', ...c.automated.map((x) => `- ${x}`));
    if (c.findings.length) {
      out.push('', 'Findings:');
      for (const f of c.findings) out.push(`- ${f.severity === 'UNVERIFIED' ? '(unverified) ' : ''}${at(f) ? `${at(f)}: ` : ''}${esc(f.reason)}`);
    }
    if (c.checklist.length) {
      out.push('', 'For the reviewer to confirm:', ...c.checklist.map((x) => `- [ ] ${esc(x)}`));
      out.push('', `Reviewer: ${c.signOff ? esc(c.signOff.reviewer) : '______________________'}  Date: ${c.signOff?.date ?? '__________'}${c.signOff?.evidence ? `  Evidence: ${esc(c.signOff.evidence)}` : ''}`);
    }
  }
  out.push('', '## Rows not loaded', '');
  if (a.exclusions.length === 0) out.push('None.');
  else {
    out.push('| Row | Entity | Key | Why | Approved by | On |', '| --- | --- | --- | --- | --- | --- |');
    for (const x of a.exclusions) out.push(`| ${esc(x.ref.file)} line ${x.ref.line} | ${x.entity} | ${esc(x.key)} | ${esc(x.reason)} | ${esc(x.approvedBy ?? 'NOT APPROVED')} | ${x.approvedOn ?? ''} |`);
  }
  out.push('', '## Extract totals (DQ-11)', '');
  for (const [entity, t] of Object.entries(a.totals)) {
    out.push(`- ${entity}: ${t.rows} row(s)`);
    for (const [k, v] of Object.entries(t.byStatus ?? {})) out.push(`  - status "${esc(k)}": ${v}`);
    for (const [k, v] of Object.entries(t.byDepartment ?? {})) out.push(`  - department "${esc(k)}": ${v}`);
    for (const [field, byCat] of Object.entries(t.amounts ?? {})) for (const [k, v] of Object.entries(byCat)) out.push(`  - ${field} ${esc(k)}: ${v}`);
  }
  return `${out.join('\n')}\n`;
}

export function planMarkdown(stages: Stage[]): string {
  const size = (s: Stage) => (s.kind === 'masters' ? s.items.length : s.kind === 'import' ? s.rows.length : s.employees.length);
  return ['| Stage | Path | Rows |', '| --- | --- | --- |', ...stages.map((s) => `| ${s.name} | ${s.template} | ${size(s)} |`)].join('\n');
}

export function loadJson(r: LoadResult) {
  return { ok: r.ok, migrationId: r.migrationId, companyCode: r.companyCode, operator: r.operator, stages: r.stages, validation: validationJson(r.analysis) };
}

export function loadMarkdown(r: LoadResult, generatedAt: Date): string {
  const out = [`# Data migration load: ${r.migrationId}`, '', `Company ${r.companyCode}, operator ${r.operator}. Generated ${generatedAt.toISOString()}.`, '', `**Result: ${r.ok ? 'every stage committed or already committed' : 'stopped at a rejected or held stage; nothing of that stage was applied'}**`, ''];
  out.push('| Stage | Path | State | Rows | Accepted | Import job |', '| --- | --- | --- | --- | --- | --- |');
  for (const s of r.stages) out.push(`| ${s.stage} | ${s.template} | ${s.state} | ${s.rows} | ${s.accepted} | ${s.jobId ?? ''} |`);
  for (const s of r.stages.filter((x: StageOutcome) => x.errors.length || x.detail)) {
    out.push('', `## ${s.stage}`, '');
    if (s.detail) out.push(esc(s.detail), '');
    for (const e of s.errors) out.push(`- ${e.source ? `${e.source.file} line ${e.source.line} ` : ''}${e.row !== null ? `(batch row ${e.row}) ` : ''}${e.key ? `[${esc(e.key)}] ` : ''}${e.code}`);
  }
  return `${out.join('\n')}\n`;
}

export function reconcileMarkdown(r: ReconcileReport): string {
  const out = [`# Migration reconciliation (ZT19): ${r.migrationId}`, '', `Source system ${r.sourceSystem}, company ${r.companyCode}, cut-over ${r.cutoverDate}. Generated ${r.generatedAt}.`, '', CONFIDENTIAL, ''];
  out.push(`**ZT19: ${r.zt19}** - ${r.unexplained} unexplained record(s).${r.reasons.length ? ` ${r.reasons.map(esc).join('; ')}.` : ''}`, '');
  out.push('## Counts', '', '| Entity | Source rows | Not loaded (approved) | Expected | Matched | Missing | Mismatched | Extra | Duplicates | Orphans | Follow-ups |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const e of r.entities) out.push(`| ${e.entity} | ${e.sourceRows} | ${e.excluded} | ${e.expected} | ${e.matched} | ${e.missing.length} | ${e.mismatched.length} | ${e.extra.length} | ${e.duplicates.length} | ${e.orphans.length} | ${e.followUps.length} |`);
  out.push('', '## Money', '', '| Entity | Field | Category | Extract | Company | Difference |', '| --- | --- | --- | --- | --- | --- |');
  for (const x of r.money) out.push(`| ${x.entity} | ${x.field} | ${esc(x.category)} | ${x.source} | ${x.target} | ${x.matches ? '0' : `**${x.difference}**`} |`);
  for (const e of r.entities) {
    const lists = [['Missing', e.missing], ['Mismatched', e.mismatched], ['Extra', e.extra], ['Duplicates', e.duplicates], ['Orphans', e.orphans], ['Follow-ups (explained)', e.followUps]] as const;
    if (lists.every(([, l]) => l.length === 0)) continue;
    out.push('', `## ${e.entity}`);
    for (const [label, list] of lists) {
      if (!list.length) continue;
      out.push('', `${label}:`);
      for (const d of list) out.push(`- [${esc(d.key)}]${d.source ? ` ${d.source.file} line ${d.source.line}` : ''}: ${esc(d.reason)}`);
    }
  }
  out.push('', '## Rows not loaded and their dispositions', '');
  if (r.exclusions.length === 0) out.push('None.');
  else {
    out.push('| Row | Entity | Key | Disposition | Approved by | On |', '| --- | --- | --- | --- | --- | --- |');
    for (const x of r.exclusions) out.push(`| ${esc(x.ref.file)} line ${x.ref.line} | ${x.entity} | ${esc(x.key)} | ${esc(x.reason)} | ${x.approved ? esc(x.approvedBy!) : '**NOT APPROVED**'} | ${x.approvedOn ?? ''} |`);
  }
  out.push('', `## DQ-12 Reporting reconciliation: ${r.dq12.status}`, '', ...r.dq12.lines.map((l) => `- ${esc(l)}`));
  out.push('', '## Import batches of this migration', '', '| Job | Template | State | Accepted | Rejected |', '| --- | --- | --- | --- | --- |');
  for (const j of r.jobs) out.push(`| ${j.id} | ${j.template} | ${j.state} | ${j.accepted} | ${j.rejected} |`);
  out.push('', '## Sign-offs (data owner and senior developer)', '', '| Check | Reviewer | Date |', '| --- | --- | --- |');
  for (const s of r.signOffs) out.push(`| ${s.id} | ${esc(s.reviewer ?? '______________')} | ${s.date ?? '________'} |`);
  out.push('', `ZT19 accepted by (data owner): ______________________  Date: __________`, `ZT19 accepted by (senior developer): ______________________  Date: __________`);
  return `${out.join('\n')}\n`;
}

/** Writes `<name>.json` and `<name>.md` into the output folder. */
export async function writeReport(outDir: string, name: string, json: unknown, markdown: string): Promise<{ json: string; markdown: string }> {
  await mkdir(outDir, { recursive: true });
  const paths = { json: join(outDir, `${name}.json`), markdown: join(outDir, `${name}.md`) };
  await writeFile(paths.json, `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
  await writeFile(paths.markdown, markdown, 'utf-8');
  return paths;
}
