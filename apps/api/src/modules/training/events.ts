// Notification events of training participation (DF12). The plan's title, code and dates only, sent to the participant:
// reasons, feedback, cost and other participants never travel in notifications.
import type { EventDescriber } from '../events-registry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);

const describe =
  (eventType: string): EventDescriber =>
  async (tx, ev) => {
    // A malformed event (payload not an object, id missing or not a uuid) produces nothing instead of failing (DF12 retries).
    const payload: unknown = ev.payload;
    const participantId = typeof payload === 'object' && payload !== null ? id((payload as Record<string, unknown>).participantId) : null;
    if (!participantId) return null;
    const r = (
      await tx.query<{ employee_id: string; code: string; title: string; start_date: string; end_date: string }>(
        `select t.employee_id, p.code, p.title, to_char(p.start_date, 'YYYY-MM-DD') as start_date, to_char(p.end_date, 'YYYY-MM-DD') as end_date
           from training_participant t join training_plan p on p.company_id = t.company_id and p.id = t.plan_id
          where t.company_id = $1 and t.id = $2`,
        [ev.companyId, participantId],
      )
    ).rows[0];
    if (!r) return null;
    return {
      eventType,
      subjectEmployeeId: r.employee_id,
      transactionId: null,
      transactionRevision: null,
      taskId: null,
      beneficiaryUserId: null,
      data: { planTitle: r.title, planCode: r.code, startDate: r.start_date, endDate: r.end_date },
    };
  };

export const TRAINING_EVENTS: Readonly<Record<string, EventDescriber>> = {
  'training.nominated': describe('TRAINING_NOMINATED'),
  'training.confirmed': describe('TRAINING_CONFIRMED'),
  'training.participation_cancelled': describe('TRAINING_PARTICIPATION_CANCELLED'),
  'training.plan_cancelled': describe('TRAINING_PLAN_CANCELLED'),
  'training.completed': describe('TRAINING_COMPLETED'),
};
