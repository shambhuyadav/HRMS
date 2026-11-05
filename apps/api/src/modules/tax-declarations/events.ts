// Notices of tax declarations and proofs (DF12; H7 "approval return/decision"): the kind of item, the employee's identity, the
// fiscal period and the outcome only; never amounts, regime, categories, explanations or reasons.
import type { Queryable } from '../../db/queryable.js';
import type { EventDescriber } from '../events-registry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTCOMES: Record<string, string> = { ACCEPTED: 'accepted', RETURNED: 'returned for correction', REJECTED: 'rejected' };
const ITEMS = { declaration: 'tax declaration', proof: 'investment proof' } as const;

const uuidOf = (value: unknown) => (typeof value === 'string' && UUID.test(value) ? value : null);

type Facts = { employee_id: string; transaction_id: string; revision: number; fiscal_period_code: string; code: string; name: string };

const facts = async (tx: Queryable, companyId: string, item: keyof typeof ITEMS, id: string): Promise<Facts | undefined> =>
  (
    await tx.query<Facts>(
      item === 'declaration'
        ? `select d.employee_id, d.transaction_id, bt.revision, d.fiscal_period_code, e.employee_code as code, e.display_name as name
             from tax_declaration d join business_transaction bt on bt.company_id = d.company_id and bt.id = d.transaction_id join employee e on e.company_id = d.company_id and e.id = d.employee_id
            where d.company_id = $1 and d.id = $2`
        : `select f.employee_id, f.transaction_id, bt.revision, d.fiscal_period_code, e.employee_code as code, e.display_name as name
             from tax_proof f join tax_declaration d on d.company_id = f.company_id and d.id = f.declaration_id
             join business_transaction bt on bt.company_id = f.company_id and bt.id = f.transaction_id join employee e on e.company_id = f.company_id and e.id = f.employee_id
            where f.company_id = $1 and f.id = $2`,
      [companyId, id],
    )
  ).rows[0];

const assigned =
  (item: keyof typeof ITEMS, idKey: string): EventDescriber =>
  async (tx, ev) => {
    const id = uuidOf(ev.payload[idKey]);
    if (!id) return null;
    const f = await facts(tx, ev.companyId, item, id);
    if (!f) return null;
    return {
      eventType: 'TAX_ITEM_ASSIGNED',
      subjectEmployeeId: f.employee_id,
      transactionId: f.transaction_id,
      transactionRevision: f.revision,
      taskId: uuidOf(ev.payload.taskId),
      beneficiaryUserId: null,
      data: { item: ITEMS[item], employeeName: f.name, employeeCode: f.code, fiscalPeriodCode: f.fiscal_period_code },
    };
  };

const decided =
  (item: keyof typeof ITEMS, idKey: string): EventDescriber =>
  async (tx, ev) => {
    const id = uuidOf(ev.payload[idKey]);
    const outcome = typeof ev.payload.outcome === 'string' ? OUTCOMES[ev.payload.outcome] : undefined;
    if (!id || !outcome) return null;
    const f = await facts(tx, ev.companyId, item, id);
    if (!f) return null;
    return {
      eventType: 'TAX_ITEM_DECIDED',
      subjectEmployeeId: f.employee_id,
      transactionId: f.transaction_id,
      transactionRevision: f.revision,
      taskId: null,
      beneficiaryUserId: null,
      data: { item: ITEMS[item], fiscalPeriodCode: f.fiscal_period_code, outcome },
    };
  };

export const TAX_DECLARATION_EVENTS: Readonly<Record<string, EventDescriber>> = {
  'tax_declaration.assigned': assigned('declaration', 'declarationId'),
  'tax_declaration.decided': decided('declaration', 'declarationId'),
  'tax_proof.assigned': assigned('proof', 'proofId'),
  'tax_proof.decided': decided('proof', 'proofId'),
};
