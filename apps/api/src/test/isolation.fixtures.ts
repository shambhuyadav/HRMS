// ZT01 / ZT39 (not a test file): each module's table of routes, run the same way. A company B actor, holding the permission the
// route needs, asks for a company A record by its real identifier ("direct identifier bypass"):
//   * the answer is the refusal, with no company A value in it and nothing changed in any table company A owns;
//   * it is identical to the answer for an identifier that exists nowhere, so the refusal does not say the record exists (ZT02, sec-4);
//   * the same actor and call on company B's own record goes through, so the refusal came from the record's company and not from a
//     missing permission or a validation that would have stopped any caller.
// Then the same call with company A in the header and the B assignment: the assignment does not belong there (BR-046).
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { changedTables, type CompanyState, companyState } from './company-state.fixtures.js';
import type { Company, Harness, TestActor } from './harness.js';

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';

/** One company's records and actors, by name: the same names in both companies. */
export interface World {
  company: Company;
  /** Record identifiers and other values that must never reach another company. */
  ids: Record<string, string>;
  /** Current record versions, for the routes that take an expected version. */
  versions: Record<string, number>;
  actors: Record<string, TestActor>;
}

/** The ids of nothing: a well-formed identifier in every position, so only existence can differ from a real one. */
export function nowhere(company: Company, actors: Record<string, TestActor>): World {
  const id = randomUUID();
  return {
    company,
    actors,
    ids: new Proxy({}, { get: (_t, key) => (key === 'code' ? 'NOWHERE-CODE' : id) }) as Record<string, string>,
    versions: new Proxy({}, { get: () => 1 }) as Record<string, number>,
  };
}

export interface Probe {
  name: string;
  /** Which actor of the world asks. */
  as: string;
  method: Method;
  path: (w: World) => string;
  body?: (w: World) => object;
  /** The refusal, when it is not the 404 of a record that is not there. */
  refusal?: [number, string];
  /** The refusal with company A in the header, for a route that looks at the caller's own task before it picks the permission to check. */
  headerRefusal?: [number, string];
  /** The status of the same call on the home company's own record. */
  control?: number;
  /** The control takes another body or path (for example because the call consumes the record). */
  controlPath?: (w: World) => string;
  controlBody?: (w: World) => object;
}

export interface ListProbe {
  name: string;
  as: string;
  path: string | ((w: World) => string);
  /** The home-company values the answer must hold, so an empty answer does not pass for a refusal. */
  holds?: (w: World) => (string | undefined)[];
  /** The foreign values to look for, when not every id of the world can appear in this answer. */
  never?: (w: World) => (string | undefined)[];
  /** ZT01 "count": what the answer's `total` must be, counted in the home company's own rows. */
  total?: (h: Harness, w: World) => Promise<number>;
}

export interface IsolationContext {
  h: Harness;
  /** The company asked about. */
  foreign: World;
  /** The company asking; its actors make every call. */
  home: World;
}

const send = (h: Harness, a: TestActor, method: Method, url: string, payload?: object) => h.call(a, method, url, payload);
const answer = (res: { statusCode: number; body: string }) => {
  let parsed: unknown = res.body;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    // Not JSON: compared as text.
  }
  return { status: res.statusCode, body: parsed };
};
const errorOf = (res: { body: string }) => {
  try {
    return (JSON.parse(res.body) as { error?: string }).error;
  } catch {
    return undefined;
  }
};

/** No value of the foreign company in an answer. */
export function expectNoForeignValue(body: string, foreign: World, label: string, values?: (string | undefined)[]) {
  for (const value of values ?? Object.values(foreign.ids)) {
    if (!value) throw new Error(`${label}: a value to look for is not in the world, so the check would pass unseen`);
    expect(body.includes(value), `${label}: holds ${value}`).toBe(false);
  }
}

/** One test per route: refusal, no effect, no existence signal, positive control. */
export function itRefusesForeignRecords(ctx: () => IsolationContext, probes: Probe[]) {
  let initial: CompanyState;
  beforeAll(async () => {
    const { h, foreign } = ctx();
    initial = await companyState(h, foreign.company.id);
  });

  it.each(probes.map((p) => [p.name, p] as const))('%s', async (name, p) => {
    const { h, foreign, home } = ctx();
    const actor = home.actors[p.as];
    if (!actor) throw new Error(`No actor ${p.as}`);
    // A write compares the whole company at once, so its own failure names it; the reads are held by the test after this table.
    const before = p.method === 'GET' ? null : await companyState(h, foreign.company.id);
    const attempt = await send(h, actor, p.method, p.path(foreign), p.body?.(foreign));
    const refusal = p.refusal ?? [404, 'NOT_FOUND'];
    expect([attempt.statusCode, errorOf(attempt)], `${name}: ${attempt.body.slice(0, 300)}`).toEqual(refusal);
    expectNoForeignValue(attempt.body, foreign, name);
    if (before) expect(changedTables(before, await companyState(h, foreign.company.id)), `${name}: tables changed`).toEqual([]);

    const none = nowhere(home.company, home.actors);
    const absent = await send(h, actor, p.method, p.path(none), p.body?.(none));
    expect(answer(absent), `${name}: differs from a record that does not exist`).toEqual(answer(attempt));

    const own = await send(h, actor, p.method, (p.controlPath ?? p.path)(home), (p.controlBody ?? p.body)?.(home));
    expect(own.statusCode, `${name}: control on the home company's own record: ${own.body.slice(0, 300)}`).toBe(p.control ?? 200);
  });

  it('none of those calls changed anything the other company holds', async () => {
    const { h, foreign } = ctx();
    expect(changedTables(initial, await companyState(h, foreign.company.id))).toEqual([]);
  });
}

/** One test per list: the home company's records and none of the foreign company's. */
export function itListsOnlyOwnRecords(ctx: () => IsolationContext, lists: ListProbe[]) {
  it.each(lists.map((l) => [l.name, l] as const))('%s', async (name, l) => {
    const { h, foreign, home } = ctx();
    const actor = home.actors[l.as];
    if (!actor) throw new Error(`No actor ${l.as}`);
    const res = await send(h, actor, 'GET', typeof l.path === 'string' ? l.path : l.path(home));
    expect(res.statusCode, `${name}: ${res.body.slice(0, 300)}`).toBe(200);
    expectNoForeignValue(res.body, foreign, name, l.never?.(foreign));
    for (const value of l.holds?.(home) ?? []) {
      if (!value) throw new Error(`${name}: a value to look for is not in the world`);
      expect(res.body.includes(value), `${name}: lacks its own ${value}`).toBe(true);
    }
    if (l.total) expect((JSON.parse(res.body) as { total: number }).total, `${name}: total`).toBe(await l.total(h, home));
  });
}

/**
 * The company header names A while the assignment is B's: refused before any record is looked at. Only the denial's own evidence may
 * be added to A's audit trail, with no payload.
 */
export function itRefusesAnotherCompanyInTheHeader(ctx: () => IsolationContext, probes: Probe[]) {
  it('the company header cannot move a company B assignment into company A (BR-046)', async () => {
    const { h, foreign, home } = ctx();
    const before = await companyState(h, foreign.company.id);
    const denials = async () => (await h.one<{ n: number }>(`select count(*)::int as n from audit_event where company_id = $1 and action <> 'ACCESS_DENIED'`, [foreign.company.id])).n;
    const others = await denials();
    for (const p of probes) {
      const replayed: TestActor = { ...home.actors[p.as]!, company: foreign.company };
      const res = await send(h, replayed, p.method, p.path(foreign), p.body?.(foreign));
      expect([res.statusCode, errorOf(res)], `${p.name}: ${res.body.slice(0, 300)}`).toEqual(p.headerRefusal ?? [403, 'FORBIDDEN']);
    }
    expect(changedTables(before, await companyState(h, foreign.company.id)).filter((t) => t !== 'audit_event')).toEqual([]);
    expect(await denials()).toBe(others);
  });
}
