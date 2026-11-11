// FR-093 and section 11.2's notification outputs. Columns are the BRD's lists and await the owner's samples (section 11; I-40
// item 12). Neither holds a message, a payload, a birth date, a year of birth or an age.
import { HttpError } from '../../http/errors.js';
import { employeeScopePredicate, SqlParams } from '../access/authorize.js';
import type { ReportDefinition } from '../report/catalogue.js';
import { deliveryExportSql, FAILED_EVENT_STATES, NOTIFICATION_STATES } from './delivery-log.js';
import { ACTIVE_EMPLOYEE_STATUSES } from './dispatcher.js';

/** One event's dates over at most a year and a day of rows; a technical bound on a request, not a business rule. */
const MAX_UPCOMING_DAYS = 366;

const DELIVERY_STATUSES: readonly string[] = [...new Set<string>([...NOTIFICATION_STATES, ...FAILED_EVENT_STATES])];

export const NOTIFICATION_REPORTS: Record<string, ReportDefinition> = {
  // Section 11.2 "Notification delivery log"; FR-093; DF12 "Retry attempts are auditable". Not tied to employees, so for an
  // unrestricted company-scope assignment. Its own export right; the read right opens only the lists.
  NOTIFICATION_DELIVERY: {
    code: 'NOTIFICATION_DELIVERY',
    title: 'Notification delivery log',
    resource: 'notification',
    fieldGroup: 'operational',
    requiresPeriod: true,
    companyScopeOnly: true,
    statusFilter: true,
    recordFilters: ['category'],
    checkFilters(f) {
      if (f.status !== undefined && !DELIVERY_STATUSES.includes(f.status)) throw new HttpError(422, 'INVALID_FILTER', `The delivery status is one of ${DELIVERY_STATUSES.join(', ')}`, { field: 'status' });
    },
    columns: [
      { key: 'occurred_at', header: 'Occurred at (company time)' },
      { key: 'source', header: 'Source' },
      { key: 'event', header: 'Event' },
      { key: 'occurrence', header: 'Occurrence' },
      { key: 'recipient', header: 'Recipient account' },
      { key: 'channel', header: 'Channel' },
      { key: 'attempts', header: 'Attempts' },
      { key: 'outcome', header: 'Outcome' },
      { key: 'failure_code', header: 'Failure' },
      { key: 'id', header: 'Record id' },
    ],
    async rows(db, grant, f) {
      const p = new SqlParams([grant.companyId]);
      return (await db.query(deliveryExportSql(p, '$1', { from: f.from, to: f.to, state: f.status, category: f.category }, grant), p.values)).rows;
    },
  },

  // FR-093 "upcoming celebration events"; section 11.2 "Eligible dates ... with privacy preferences; no public DOB/year/age";
  // DF12: opted-in active employees, with name, work department and event type. Each row is an occurrence in the period, from
  // today on, by the rules runCelebrations publishes it under (29 February on 28 February in a non-leap year, month-end clamp, an
  // anniversary only after the first year), under the requester's row scope. Its date is the occurrence, so its year is the
  // period's, and a past period holds nothing, so neither a birth year nor a joining year can be probed from it.
  UPCOMING_CELEBRATIONS: {
    code: 'UPCOMING_CELEBRATIONS',
    title: 'Upcoming celebration events',
    resource: 'celebration',
    fieldGroup: 'operational',
    requiresPeriod: true,
    maxPeriodDays: MAX_UPCOMING_DAYS,
    columns: [
      { key: 'observed_on', header: 'Observed on' },
      { key: 'event', header: 'Event' },
      { key: 'name', header: 'Name' },
      { key: 'department', header: 'Department' },
    ],
    async rows(db, grant, f) {
      const p = new SqlParams();
      const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, p);
      const today = `${p.add(grant.businessDate)}::date`;
      const from = `${p.add(f.from)}::date`;
      const to = `${p.add(f.to)}::date`;
      return (
        await db.query(
          `select to_char(o.day, 'YYYY-MM-DD') as observed_on, k.kind as event, e.display_name as name, dep.name as department
             from employee e
             join reference_value st on st.company_id = e.company_id and st.id = e.status_id and st.code = any(${p.add(ACTIVE_EMPLOYEE_STATUSES)}::text[])
             join user_employee_link l on l.company_id = e.company_id and l.employee_id = e.id
                  and l.effective_from <= ${today} and (l.effective_to is null or l.effective_to > ${today})
             cross join (values ('BIRTHDAY'), ('WORK_ANNIVERSARY')) as k (kind)
             join notification_preference np on np.company_id = e.company_id and np.user_id = l.user_id
                  and np.event_type = k.kind and np.channel = 'IN_APP' and np.publish_celebration
             cross join lateral (
               select (b.base + make_interval(years => y.y - extract(year from b.base)::int))::date as day
                 from (select case when k.kind = 'BIRTHDAY' then e.date_of_birth else coalesce(e.service_anniversary_date, e.joining_date) end as base) b
                 cross join generate_series(extract(year from ${from})::int, extract(year from ${to})::int) as y (y)
                where b.base is not null and (k.kind = 'BIRTHDAY' or y.y > extract(year from b.base)::int)) o
             left join employment_assignment ea on ea.company_id = e.company_id and ea.employee_id = e.id
                  and ea.effective_from <= ${today} and (ea.effective_to is null or ea.effective_to > ${today})
             left join department dep on dep.company_id = ea.company_id and dep.id = ea.department_id
            where ${scope} and o.day between ${from} and ${to} and o.day >= ${today}
            order by o.day, e.display_name, k.kind`,
          p.values,
        )
      ).rows;
    },
  },
};
