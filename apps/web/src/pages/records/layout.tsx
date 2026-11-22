// The layout pieces of the import and document screens that the shared helpers (FormField, Hint, Table …) do not cover, as utility
// classes (shadcn/ui move, 20 Nov 2026).

/** A field in a stacked form keeps the old 560px limit, so a wide card does not stretch it. */
export const FIELD_WIDTH = 'max-w-[560px]';
/** Fields side by side with their button, their bottoms lined up, wrapping on a narrow screen (the old `div.inline`, `form.inline`). */
export const FIELD_ROW = 'flex flex-wrap items-end gap-x-4 gap-y-3';
/** A date in a list stays on one line ("3 Nov 2026", not "3 Nov" over "2026"). */
export const DATE_CELL = 'whitespace-nowrap';
