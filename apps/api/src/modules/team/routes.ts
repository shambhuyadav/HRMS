import type { FastifyInstance } from 'fastify';
import { sortQuery } from '../../db/paging.js';
import type { Database } from '../../db/transaction.js';
import { requireAccess } from '../../http/guard.js';
import { OWN_REQUEST_PENDING_PAIRS, roleDashboard } from '../dashboard/service.js';
import { ownPendingRequests, pendingTaskList } from '../dashboard/tasks.js';
import { teamMemberDetail } from './detail.js';
import { CURRENT_MEMBER_STATUSES, listTeam, TEAM_SORTS, type TeamQuery, teamFilterOptions } from './service.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date' } as const;

const teamQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    search: { type: 'string', maxLength: 100 },
    departmentId: uuid,
    locationId: uuid,
    status: { type: 'string', enum: [...CURRENT_MEMBER_STATUSES] },
    reviewDueFrom: date,
    reviewDueTo: date,
    todayAttendance: { type: 'string', pattern: '^[A-Z_]{1,40}$' },
    confirmationDueTo: date,
    page: { type: 'integer', minimum: 1, default: 1 },
    pageSize: { type: 'integer', enum: [25, 50, 100], default: 25 },
    ...sortQuery(TEAM_SORTS),
  },
} as const;

export async function teamRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  app.get('/my-team', { schema: { querystring: teamQuery } }, async (request) => {
    const grant = await requireAccess(db, request, 'team', 'list', ['operational']);
    return listTeam(db, grant, request.query as TeamQuery);
  });

  // DF16 filters: the departments and locations of the caller's own current members.
  app.get('/my-team/filter-options', async (request) => {
    const grant = await requireAccess(db, request, 'team', 'list', ['operational']);
    return teamFilterOptions(db, grant);
  });

  app.get('/my-team/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'team', 'read', ['operational'], { recordKey: id });
    return teamMemberDetail(db, grant, id);
  });

  app.get('/dashboard', async (request) => {
    const grant = await requireAccess(db, request, 'dashboard', 'read', ['operational']);
    return roleDashboard(db, grant);
  });

  // DF17 priority task list; FR-096 "pending tasks".
  app.get('/dashboard/tasks', async (request) => {
    const grant = await requireAccess(db, request, 'dashboard', 'read', ['operational']);
    return pendingTaskList(db, grant);
  });

  // F2 Employee "Own pending requests": the rows of the widget (kind, state, date).
  app.get('/me/pending-requests', async (request) => {
    const grant = await requireAccess(db, request, 'dashboard', 'read', ['operational']);
    return ownPendingRequests(db, grant, OWN_REQUEST_PENDING_PAIRS);
  });
}
