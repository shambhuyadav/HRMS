// Shared list paging (FR-056 "pagination, total counts"): page boundaries, the total of every match, the capped
// answer without page/pageSize, a page past the last one, and hidden sort keys. Synthetic rows in a temporary table.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from '../test/harness.js';
import { DEFAULT_PAGE_SIZE, pageMeta, pageOf } from './paging.js';

describe('pageOf (FR-056)', () => {
  let h: Harness;
  const SQL = `select n, label, n * 10 as hrms_sort from paging_probe where grp = $1`;

  beforeAll(async () => {
    h = await startHarness();
    await h.db.query(`create temp table paging_probe (n int primary key, grp text not null, label text not null)`);
    // 60 rows in group A, 3 in group B.
    await h.db.query(`insert into paging_probe select g, 'A', 'row ' || g from generate_series(1, 60) g`);
    await h.db.query(`insert into paging_probe select g, 'B', 'row ' || g from generate_series(61, 63) g`);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('answers one page with the total of every match, and the next page continues without overlap', async () => {
    const p1 = await pageOf(h.db, SQL, ['A'], 'hrms_sort desc', { page: 1, pageSize: 25 }, 200);
    expect(p1).toMatchObject({ total: 60, page: 1, pageSize: 25 });
    expect(p1.items).toHaveLength(25);
    expect(p1.items[0]).toEqual({ n: 60, label: 'row 60' });
    const p2 = await pageOf(h.db, SQL, ['A'], 'hrms_sort desc', { page: 2, pageSize: 25 }, 200);
    const p3 = await pageOf(h.db, SQL, ['A'], 'hrms_sort desc', { page: 3, pageSize: 25 }, 200);
    expect(p2.items).toHaveLength(25);
    expect(p3.items).toHaveLength(10);
    expect(p3.total).toBe(60);
    const all = [...p1.items, ...p2.items, ...p3.items].map((r) => r.n);
    expect(new Set(all).size).toBe(60);
    expect(all[24]).toBe(36);
    expect(all[25]).toBe(35);
  });

  it('keeps the total past the last page and on an exact boundary', async () => {
    const past = await pageOf(h.db, SQL, ['A'], 'hrms_sort desc', { page: 4, pageSize: 25 }, 200);
    expect(past).toEqual({ items: [], total: 60, page: 4, pageSize: 25 });
    const exact = await pageOf(h.db, SQL, ['A'], 'n', { page: 2, pageSize: 50 }, 200);
    expect(exact.items.map((r) => r.n)).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
    const empty = await pageOf(h.db, SQL, ['NONE'], 'n', { page: 1, pageSize: 25 }, 200);
    expect(empty).toEqual({ items: [], total: 0, page: 1, pageSize: 25 });
  });

  it('without page or pageSize answers the capped first rows as before, with the total saying more exist', async () => {
    const capped = await pageOf(h.db, SQL, ['A'], 'n', {}, 40);
    expect(capped.items).toHaveLength(40);
    expect(capped.total).toBe(60);
    expect(capped).not.toHaveProperty('page');
    expect(pageMeta(capped)).toEqual({ total: 60 });
    // Only a page size: the first page; only a page: the default size.
    expect((await pageOf(h.db, SQL, ['A'], 'n', { pageSize: 50 }, 40)).items).toHaveLength(50);
    const defaultSize = await pageOf(h.db, SQL, ['A'], 'n', { page: 1 }, 40);
    expect(defaultSize.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(pageMeta(defaultSize)).toEqual({ total: 60, page: 1, pageSize: DEFAULT_PAGE_SIZE });
  });

  it('applies the filter to the total and drops hidden hrms_ sort keys from the items', async () => {
    const b = await pageOf(h.db, SQL, ['B'], 'hrms_sort', { page: 1, pageSize: 25 }, 200);
    expect(b.total).toBe(3);
    expect(b.items).toEqual([
      { n: 61, label: 'row 61' },
      { n: 62, label: 'row 62' },
      { n: 63, label: 'row 63' },
    ]);
  });
});
