// The parts of a list's pager line: small outline buttons to the page before and after, around the page count, at the end of the
// line, wrapping on a narrow screen. Pager (ui.tsx) draws the paged lists that announce their total with them; a screen whose list is
// read by a cursor (only "Previous" and "Next", each shown when there is a page that way) or whose words differ ("Older batches")
// puts its own buttons in a PagerRow. Paging is never the page's main action, so the buttons are outline ones.
import * as React from 'react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const PAGER_ROW = 'mt-4 flex flex-wrap items-center justify-end gap-3 text-sm text-muted-foreground';

/** The pager's line. A role and name (role="navigation", aria-label) are given by the screen where its pager had them. */
export function PagerRow({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="pager-row" className={cn(PAGER_ROW, className)} {...props} />;
}

/** A step of the pager ("Previous page", "Next lines"): a small outline button that never sends a form. */
export const PagerButton = React.forwardRef<HTMLButtonElement, Omit<ButtonProps, 'variant' | 'size' | 'type'>>(function PagerButton(props, ref) {
  return <Button ref={ref} type="button" variant="outline" size="sm" {...props} />;
});

/** The page count between the buttons ("Page 2 of 5 · 112 items"), in figures of one width, so the buttons do not shift. */
export function PagerCount({ className, ...props }: React.ComponentPropsWithoutRef<'span'>) {
  return <span className={cn('tabular-nums', className)} {...props} />;
}
