// Phone table cards (styles.css, max-width 560px): on a phone each table row reads as a card, every value beside its column's name.
// This gives each body cell the name of its column (data-label), and marks the cell that heads the card (data-card-title) when it is not
// the first one: a table that starts with a code and then the name ("Code", "Name") is headed by the name, which is what a person scans
// for; the code then shows as an ordinary line of the card. Without a mark the first cell heads the card, as before.

const CODE_HEADING = /^code$/i;
const NAME_HEADING = /^(name|employee|employee name)$/i;
// A sorted column's heading ends in its direction arrow (SortHeader in ui.tsx); the column's name is the text before it.
const SORT_ARROW = /\s*[▲▼]$/;

/** A heading cell's column name, without a sort arrow. */
const columnName = (cell: HTMLTableCellElement) => (cell.textContent ?? '').trim().replace(SORT_ARROW, '');

/** The column that heads each card, when it is not the first: the name after a leading code column. */
function titleColumn(names: readonly string[]): number {
  return names.length > 1 && CODE_HEADING.test(names[0] ?? '') && NAME_HEADING.test(names[1] ?? '') ? 1 : -1;
}

/** Labels the body cells of every table with a header row inside `root`; only changes attributes that differ (cheap to repeat). */
export function labelTableCells(root: ParentNode): void {
  for (const table of Array.from(root.querySelectorAll('table'))) {
    const head = table.tHead?.rows[0];
    if (!head) continue;
    const names: string[] = [];
    for (const cell of Array.from(head.cells)) for (let i = 0; i < cell.colSpan; i++) names.push(columnName(cell));
    const title = titleColumn(names);
    for (const body of Array.from(table.tBodies)) {
      for (const row of Array.from(body.rows)) {
        let column = 0;
        for (const cell of Array.from(row.cells)) {
          const name = names[column] ?? '';
          if (name && cell.getAttribute('data-label') !== name) cell.setAttribute('data-label', name);
          // A cell that spans the whole row (an "empty" line) is never a title.
          const heads = column === title && cell.colSpan === 1;
          if (heads !== cell.hasAttribute('data-card-title')) {
            if (heads) cell.setAttribute('data-card-title', '');
            else cell.removeAttribute('data-card-title');
          }
          column += cell.colSpan;
        }
      }
    }
  }
}
