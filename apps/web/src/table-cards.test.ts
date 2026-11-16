// Phone table cards (jsdom): every body cell gets its column's name, and a table that starts with a code and then the name is headed by
// the name; other tables keep their first cell as the heading. Synthetic data only.
import { afterEach, describe, expect, it } from 'vitest';
import { labelTableCells } from './table-cards';

const table = (heads: string[], rows: string[][]) => {
  const t = document.createElement('table');
  t.innerHTML = `<thead><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => (c.startsWith('colspan:') ? `<td colspan="${heads.length}">${c.slice(8)}</td>` : `<td>${c}</td>`)).join('')}</tr>`)
    .join('')}</tbody>`;
  document.body.append(t);
  return t;
};
const cells = (t: HTMLTableElement, row = 0) => Array.from(t.tBodies[0]!.rows[row]!.cells);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('phone table cards', () => {
  it('gives every body cell the name of its column', () => {
    const t = table(['Date', 'Kind', 'Days'], [['3 Nov 2026', 'Casual', '1']]);
    labelTableCells(document.body);
    expect(cells(t).map((c) => c.getAttribute('data-label'))).toEqual(['Date', 'Kind', 'Days']);
    expect(cells(t).some((c) => c.hasAttribute('data-card-title'))).toBe(false);
  });

  it('heads a card with the name when the code comes first', () => {
    const t = table(['Code', 'Name', 'Department'], [['T001', 'Asha Rao', 'Finance'], ['T002', 'Bina Shah', 'Finance']]);
    labelTableCells(document.body);
    for (const row of [0, 1]) expect(cells(t, row).map((c) => c.hasAttribute('data-card-title'))).toEqual([false, true, false]);
    expect(cells(t)[0]!.getAttribute('data-label')).toBe('Code');
  });

  it('also for an "Employee" column after the code, but not for a code followed by something else', () => {
    const a = table(['Code', 'Employee', 'Status'], [['T001', 'Asha Rao', 'Confirmed']]);
    const b = table(['Code', 'Title', 'State'], [['GRATUITY', 'Gratuity', 'Draft']]);
    labelTableCells(document.body);
    expect(cells(a)[1]!.hasAttribute('data-card-title')).toBe(true);
    expect(cells(b).some((c) => c.hasAttribute('data-card-title'))).toBe(false);
  });

  it('reads a sorted column by its name, without the direction arrow, for both the label and the heading', () => {
    const t = table(['Code ▲', 'Name', 'Joined ▼'], [['T000', 'Neha Kapoor', '3 Apr 2023']]);
    labelTableCells(document.body);
    expect(cells(t).map((c) => c.getAttribute('data-label'))).toEqual(['Code', 'Name', 'Joined']);
    expect(cells(t)[1]!.hasAttribute('data-card-title')).toBe(true);
  });

  it('never marks a cell that spans the row, and drops a mark that no longer applies', () => {
    const t = table(['Code', 'Name'], [['colspan:No one matches.']]);
    labelTableCells(document.body);
    expect(cells(t)[0]!.hasAttribute('data-card-title')).toBe(false);
    const u = table(['Code', 'Name'], [['T001', 'Asha Rao']]);
    labelTableCells(document.body);
    expect(cells(u)[1]!.hasAttribute('data-card-title')).toBe(true);
    u.tHead!.rows[0]!.cells[1]!.textContent = 'Title';
    labelTableCells(document.body);
    expect(cells(u)[1]!.hasAttribute('data-card-title')).toBe(false);
    expect(cells(u)[1]!.getAttribute('data-label')).toBe('Title');
  });
});
