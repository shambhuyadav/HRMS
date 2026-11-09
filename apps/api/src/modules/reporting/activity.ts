// DF17 "recent operational activity" (I-62 item 5, I-83 item 5; decided under owner delegation, 6 Nov 2026). The source is the
// audit trail, narrowed to what the selected assignment itself did: rows whose actor is the caller and whose acting assignment is
// the selected one, in the last N company-local days (reporting_setting.recent_activity_days). That is scope-safe by construction:
// it shows nobody else's work, so it cannot widen the assignment or disclose another person's record (FR-097; DF17 "Rendering/query
// scope cannot widen the selected assignment"). What was done, to which kind of record and when: never the values, the reason or
// the record's identity. Refused attempts are left out; they are not activity.
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import type { AccessGrant } from '../access/authorize.js';
import { settingInForce } from './settings.js';

const LIST_CAP = 100;

export async function recentActivity(db: Queryable, g: AccessGrant, q: Paging) {
  const setting = await settingInForce(db, g.companyId, g.businessDate);
  if (!setting) return { status: 'NOT_CONFIGURED' as const, message: 'No reporting setting is in force', items: [], total: 0 };
  const page = await pageOf(
    db,
    `select a.action, a.resource_code as resource, a.occurred_at as "occurredAt", a.occurred_at as hrms_at, a.id as hrms_id
       from audit_event a
      where a.company_id = $1 and a.acting_assignment_id = $2 and a.actor_user_id = $3 and a.action <> 'ACCESS_DENIED'
        and hrms_business_date(a.company_id, a.occurred_at) > $4::date - $5::int`,
    [g.companyId, g.assignmentId, g.userId, g.businessDate, setting.recentActivityDays],
    'hrms_at desc, hrms_id',
    q,
    LIST_CAP,
  );
  return { status: 'OK' as const, days: setting.recentActivityDays, ...page };
}
