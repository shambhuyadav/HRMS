// Shared by the payroll extras screens: permission keys, the fiscal year of a day, how figures are shown, and layout classes.

export const CHALLAN_READ = 'payroll_challan.read.operational';
export const CHALLAN_MANAGE = 'payroll_challan.manage.operational';
export const TAX_READ = 'payroll_tax_input.read.amount';
export const TAX_IMPORT = 'payroll_tax_input.import.amount';
export const MAPPING_READ = 'payroll_gl_mapping.read.operational';
export const MAPPING_MANAGE = 'payroll_gl_mapping.manage.operational';
export const REPORT_READ = 'payroll_report.read.amount';
/** The liability provisions are worked from salaries (the server also needs the salary history duty for an earlier date). */
export const SALARY_READ = 'salary.read.salary';
/** GET /v1/payroll/runs needs both groups of the run read duty. */
export const RUN_LIST = 'payroll_run.read.amount';
export const REPORT_EXPORT = 'payroll_report.export.amount';
export const EDOC_EXPORT = 'payroll_output.export.amount';
export const MEDICAL_READ = 'expense.read.operational';

/** The financial year (April to March) of a day, written 2026-27. */
export function fiscalYearOf(day: string): string {
  const y = Number(day.slice(0, 4));
  const start = Number(day.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** A folded part (`<details>`: the earlier revisions), set apart from the table above it; its summary names it. */
export const FOLD = 'group/fold mt-4';
/** The summary of a FOLD, in the accent colour, with room under it while the part is open; a 44px target on a phone. */
export const FOLD_SUMMARY = 'w-max cursor-pointer text-[0.86rem] font-semibold text-[var(--accent)] group-open/fold:mb-[0.6rem] phone:py-3';

export const plain = (code: string) => code.replace(/_/g, ' ').toLowerCase();
export const amount = (value: string | null | undefined) => (value === null || value === undefined || value === '' ? '—' : Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
