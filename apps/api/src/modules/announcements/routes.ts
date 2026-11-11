// HTTP routes of company events and ticker messages (CL-021, CL-022; service.ts). HR keeps them under announcement.manage; the
// dashboard feed is everyone's (announcement.read) and holds only what is for the caller.
import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { requireAccess } from '../../http/guard.js';
import type { ModuleRoutes } from '../routes-registry.js';
import {
  assertCompanyWide,
  AUDIENCES,
  createEvent,
  createTicker,
  type EventChange,
  type EventInput,
  feedFor,
  listEvents,
  listTicker,
  type TickerChange,
  type TickerInput,
  updateEvent,
  updateTicker,
} from './service.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const listQuery = { type: 'object', additionalProperties: false, properties: { includeInactive: { type: 'boolean' } } } as const;
const eventFields = {
  name: { type: 'string', minLength: 1, maxLength: 120 },
  description: { type: ['string', 'null'], maxLength: 1000 },
  eventDate: date,
  audience: { type: 'string', enum: [...AUDIENCES] },
  departmentId: { type: ['string', 'null'], format: 'uuid' },
  locationId: { type: ['string', 'null'], format: 'uuid' },
} as const;
const tickerFields = { message: { type: 'string', minLength: 1, maxLength: 280 }, startsOn: date, endsOn: date } as const;
const version = { type: 'integer', minimum: 1 } as const;

export const announcementRoutes: ModuleRoutes = async (app: FastifyInstance, opts: { db: Database }) => {
  const { db } = opts;
  // Events and messages are company-wide (a ticker message reaches everyone): keeping them needs unrestricted company scope, as the
  // organisation masters do; an HR Administrator filtered to a department or location may read the feed but not keep the lists.
  const manage = async (request: Parameters<typeof requireAccess>[1]) => assertCompanyWide(await requireAccess(db, request, 'announcement', 'manage', ['operational']));

  // Everyone: what their dashboard shows today.
  app.get('/announcements/feed', async (request) => feedFor(db, await requireAccess(db, request, 'announcement', 'read', ['operational'])));

  app.get('/company-events', { schema: { querystring: listQuery } }, async (request) => {
    const grant = await manage(request);
    return { items: await listEvents(db, grant, (request.query as { includeInactive?: boolean }).includeInactive === true) };
  });
  app.post(
    '/company-events',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['name', 'eventDate', 'audience'], properties: eventFields } } },
    async (request, reply) => {
      const grant = await manage(request);
      const created = await withTransaction(db, (tx) => createEvent(tx, grant, request.body as EventInput));
      reply.status(201);
      return created;
    },
  );
  app.patch(
    '/company-events/:id',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { ...eventFields, active: { type: 'boolean' }, expectedVersion: version } },
      },
    },
    async (request) => {
      const grant = await manage(request);
      const { id } = request.params as { id: string };
      return withTransaction(db, (tx) => updateEvent(tx, grant, id, request.body as EventChange));
    },
  );

  app.get('/ticker-messages', { schema: { querystring: listQuery } }, async (request) => {
    const grant = await manage(request);
    return { items: await listTicker(db, grant, (request.query as { includeInactive?: boolean }).includeInactive === true) };
  });
  app.post(
    '/ticker-messages',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['message', 'startsOn', 'endsOn'], properties: tickerFields } } },
    async (request, reply) => {
      const grant = await manage(request);
      const created = await withTransaction(db, (tx) => createTicker(tx, grant, request.body as TickerInput));
      reply.status(201);
      return created;
    },
  );
  app.patch(
    '/ticker-messages/:id',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { ...tickerFields, active: { type: 'boolean' }, expectedVersion: version } },
      },
    },
    async (request) => {
      const grant = await manage(request);
      const { id } = request.params as { id: string };
      return withTransaction(db, (tx) => updateTicker(tx, grant, id, request.body as TickerChange));
    },
  );
};
