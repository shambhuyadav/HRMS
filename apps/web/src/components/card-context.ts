// What a part needs to know about the card it is drawn in, passed down instead of read from the class names around it.
import { createContext } from 'react';

/**
 * Inside a card: a Section (ui.tsx), or a list's own card (a payslip, a queue item, a structure). The card is then the box, so a form
 * (FormGrid) draws no frame of its own and a table's container does not scroll by itself (the card scrolls sideways instead).
 */
export const InCardContext = createContext(false);

/**
 * Inside the decision inbox (pages/work/tasks.tsx), a queue with nothing waiting is one quiet line after the queues that have
 * something: the card holding the empty line (Empty, compact there) loses its padding, tint and shadow, its title runs into the line,
 * and its notes (Hint) are left out. styles.css ("Decisions") lays the line out and orders the queues. The card is the Tailwind group
 * `queue`, so its parts say "when my card holds an empty line" as `group-has-[p[data-slot=empty]]/queue:…`.
 */
export const QuietWhenEmptyContext = createContext(false);
