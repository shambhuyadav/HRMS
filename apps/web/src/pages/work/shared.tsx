// Shared by the work screens (payments, the inbox and reports): the layout pieces these screens have and the shared helpers
// (FormField, Hint, Table …) do not cover, as utility classes (shadcn/ui move, 20 Nov 2026).

/**
 * An action of a list item ("Mark as read", "Download CSV"). The items of `ul.tasks` stack their parts at full width (styles.css),
 * so the button keeps its own width at the item's start.
 */
export const ITEM_ACTION = 'self-start';
/** Controls side by side in a table cell (a reason and its button), wrapping when the cell is narrow; each control keeps its width. */
export const CELL_CONTROLS = 'flex flex-wrap items-center gap-2';
