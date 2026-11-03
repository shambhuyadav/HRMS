// Payroll outputs (FR-102, FR-107; H7 notifications): notification events. Identifiers, period and version only:
// never amounts, bank values or document content (DF12; H7 "email contains no bank values/salary/private
// documents"). A describer never throws and returns null when the event should produce nothing (for example an
// output that has been superseded before the notice was dispatched).
import type { EventDescriber } from '../events-registry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const payslipPublished: EventDescriber = async (tx, ev) => {
  const outputId = typeof ev.payload.outputId === 'string' && UUID.test(ev.payload.outputId) ? ev.payload.outputId : null;
  if (!outputId) return null;
  try {
    const o = (
      await tx.query<{ employee_id: string; period_code: string; output_version: number; publication_state: string }>(
        `select employee_id, period_code, output_version, publication_state from employee_issued_output where company_id = $1 and id = $2 and kind = 'PAYSLIP'`,
        [ev.companyId, outputId],
      )
    ).rows[0];
    if (!o || o.publication_state !== 'ISSUED') return null;
    return {
      eventType: 'PAYSLIP_PUBLISHED',
      subjectEmployeeId: o.employee_id,
      transactionId: null,
      transactionRevision: null,
      taskId: null,
      beneficiaryUserId: null,
      data: { periodCode: o.period_code, version: String(o.output_version) },
    };
  } catch {
    return null;
  }
};

export const PAYROLL_OUTPUTS_EVENTS: Readonly<Record<string, EventDescriber>> = {
  'payroll_output.published': payslipPublished,
};
