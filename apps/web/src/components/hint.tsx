// A hint: help or a remark beside what it is about (the old `.hint`), in running text, so a link, code or button inside stays in the
// sentence. Its look follows its place, as the old rules of styles.css had it:
// - a card's own note (a direct child of a card): a quiet box with an info mark, set apart from what is above and below it;
// - a note between cards (a direct child of the page): muted, at a readable line length;
// - anywhere else (in a form, under a field, after a button): one muted line.
// The screens do not mark which place a hint is in (it is used in hundreds of places), so the two placed looks are variants on the
// hint's position: a direct child of `.card` (the marker every card carries: Section and the lists' own cards) or of `.content` (the
// page, App.tsx), and what comes just before it there. A decision queue with nothing waiting leaves its notes out.
import { InfoIcon } from 'lucide-react';
import * as React from 'react';
import { QuietWhenEmptyContext } from '@/components/card-context';
import { cn } from '@/lib/utils';

/** Anywhere: one muted line. */
const HINT = 'text-[0.84rem] text-muted-foreground';
/** A card's own note: a boxed line with room on the left for the mark; spaced from its neighbours, closer under another note. */
const CARD_NOTE = cn(
  '[.card>&]:relative [.card>&]:mt-4 [.card>&]:mb-0 [.card>&]:block [.card>&]:rounded-md [.card>&]:border [.card>&]:border-border [.card>&]:bg-accent',
  '[.card>&]:py-[0.7rem] [.card>&]:pr-[0.9rem] [.card>&]:pl-[2.3rem] [.card>&]:leading-normal',
  '[.card>&:not(:last-child)]:mb-4 [.card>&:first-child]:mt-0 [.card>header+&]:mt-0 [.card>header+&]:mb-4 [.card>.sr-only+&]:mt-0 [.card>.sr-only+&]:mb-4',
  '[.card>[data-slot=hint]+&]:-mt-[0.4rem]',
);
/** A note between cards: at a readable line length, closer under the page's title or another note. */
const PAGE_NOTE = '[.content>&]:max-w-[90ch] [.content>[data-slot=hint]+&]:-mt-3 [.content>h1+&]:-mt-3 [.content>h1+&]:max-w-[72ch] [.content>h1+&]:text-[0.9rem]';
/** In a decision queue with nothing waiting (QuietWhenEmptyContext): left out. */
const IN_QUIET_QUEUE = 'group-has-[p[data-slot=empty]]/queue:hidden';

/** The mark of a card's note, in the muted text colour; drawn only there. */
const MARK = 'pointer-events-none absolute top-[0.82rem] left-[0.8rem] hidden size-[16px] [.card>[data-slot=hint]>&]:block';

type HintProps = React.ComponentPropsWithoutRef<'p'> & {
  /** `span` for a hint inside a sentence or beside a button ("Requested. Download it from Reports."). */
  as?: 'p' | 'span';
};

export function Hint({ as: Tag = 'p', className, children, ...props }: HintProps) {
  const quiet = React.useContext(QuietWhenEmptyContext);
  return (
    <Tag data-slot="hint" className={cn(HINT, CARD_NOTE, PAGE_NOTE, quiet && IN_QUIET_QUEUE, className)} {...props}>
      {Tag === 'p' && <InfoIcon aria-hidden="true" className={MARK} />}
      {children}
    </Tag>
  );
}

/** A muted line of its own under the main text of a table cell or a list item ("SYN-001", "requested 3 Mar"; the old `div.hint`). */
export function HintLine({ children }: { children: React.ReactNode }) {
  return (
    <Hint as="span" className="block">
      {children}
    </Hint>
  );
}
