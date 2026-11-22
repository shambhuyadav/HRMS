// shadcn/ui Table (registry new-york-v4), fitted to two HRMS table behaviours of styles.css:
// - Column headings stick to the top of the page in a card whose table fits (sticky-heads.ts). A box that scrolls would hold them in
//   itself instead, so inside a card (InCardContext) the table's container does not scroll: the card scrolls sideways when the
//   table is wider.
//   No position or background is set on the heading cells, which the sticky rule needs.
// - On a phone a table reads as a list of cards, one per row (table-cards.ts). The cell sizes are for wider screens only, and the
//   last row keeps its frame there.
// - A cell's text wraps, as HRMS tables always did (only headings stay on one line): shadcn's one-line cells made wide lists such as
//   My team (10 columns) scroll sideways inside their card on a laptop. A date or code that must not break uses `whitespace-nowrap`.
// - Headings are in the muted text, as shadcn's data tables have them, on the card itself (styles.css draws no strip behind them).
// Borders name their colour (border-border): the app has no Tailwind reset to give every border the hairline colour.
import * as React from 'react';
import { InCardContext } from '@/components/card-context';
import { cn } from '@/lib/utils';

function Table({ className, ...props }: React.ComponentPropsWithoutRef<'table'>) {
  const inCard = React.useContext(InCardContext);
  return (
    <div data-slot="table-container" className={cn('relative w-full overflow-x-auto', inCard && 'overflow-visible')}>
      <table data-slot="table" className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentPropsWithoutRef<'thead'>) {
  return <thead data-slot="table-header" className={cn('[&_tr]:border-b [&_tr]:border-border', className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentPropsWithoutRef<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('min-[561px]:[&_tr:last-child]:border-0', className)} {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentPropsWithoutRef<'tfoot'>) {
  return <tfoot data-slot="table-footer" className={cn('border-t border-border bg-muted/50 font-medium [&>tr]:last:border-b-0', className)} {...props} />;
}

function TableRow({ className, ...props }: React.ComponentPropsWithoutRef<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn('border-b border-border transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted', className)}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentPropsWithoutRef<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentPropsWithoutRef<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        'min-[561px]:p-2 min-[561px]:align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentPropsWithoutRef<'caption'>) {
  return <caption data-slot="table-caption" className={cn('mt-4 text-sm text-muted-foreground', className)} {...props} />;
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
