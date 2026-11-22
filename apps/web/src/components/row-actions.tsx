// A table row's actions (the old `td button.link`): small buttons side by side, `<Button variant="outline" size="sm">`, and
// `variant="danger"` for one that ends or removes something, in the row's last cell, a RowActionsCell.
import { Slot } from 'radix-ui';
import type { ComponentPropsWithoutRef } from 'react';
import { TableCell } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export function RowActions({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="row-actions" className={cn('flex items-center gap-2 phone:flex-wrap phone:justify-end', className)} {...props} />;
}

/**
 * The row's last cell, holding its RowActions. Above phone width it takes only the room the buttons need, so the data columns beside
 * it are not squeezed (never plain `w-px`: on a phone the row is a card, the buttons beside the cell's name, each a 44px target,
 * wrapping if they must, so the cell keeps its own width there). While a form or a refusal opened from the buttons shows in the cell,
 * pass `expanded`: the cell then takes the room its content needs. A RowPanel widens the cell by itself.
 */
export function RowActionsCell({ expanded = false, className, ...props }: ComponentPropsWithoutRef<typeof TableCell> & { expanded?: boolean }) {
  return <TableCell className={cn(!expanded && 'min-[561px]:w-px', className)} {...props} />;
}

/**
 * What opens in a row's actions cell, below its buttons (a change form, a refusal). The cell is only as wide as its buttons, so
 * without a width of its own the form would be squeezed to them: above phone width it shows two fields side by side. On a phone the
 * row is a card whose cells set their values at the right (styles.css, table cards): the panel takes the card's width and reads from
 * the left. With asChild the panel is drawn on the caller's own element (a FormGrid of the change).
 */
export function RowPanel({ className, asChild = false, ...props }: ComponentPropsWithoutRef<'div'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'div';
  return <Comp className={cn('mt-3 min-[561px]:min-w-[31rem] phone:basis-full phone:text-left', className)} {...props} />;
}
