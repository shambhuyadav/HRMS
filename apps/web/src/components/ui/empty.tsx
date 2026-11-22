// shadcn/ui Empty (registry new-york-v4): an empty state with an optional mark, title, description and actions. ui.tsx's Empty
// keeps its one-line <p class="empty">, which the old rules of styles.css already draw the same way (a centred, muted line under a
// framed mark, in a dashed panel inside a card); this is for screens that need the fuller layout.
// Borders name their colour (border-border): the app has no Tailwind reset to give every border the hairline colour.
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/utils';

function Empty({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="empty"
      className={cn(
        'flex min-w-0 flex-1 flex-col items-center justify-center gap-6 rounded-lg border-dashed border-border p-6 text-center text-balance md:p-12',
        className,
      )}
      {...props}
    />
  );
}

function EmptyHeader({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="empty-header" className={cn('flex max-w-sm flex-col items-center gap-2 text-center', className)} {...props} />;
}

const emptyMediaVariants = cva('mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0', {
  variants: {
    variant: {
      default: 'bg-transparent',
      icon: 'flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg:not([class*=size-])]:size-6',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

function EmptyMedia({ className, variant = 'default', ...props }: React.ComponentPropsWithoutRef<'div'> & VariantProps<typeof emptyMediaVariants>) {
  return <div data-slot="empty-icon" data-variant={variant} className={cn(emptyMediaVariants({ variant, className }))} {...props} />;
}

function EmptyTitle({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="empty-title" className={cn('text-lg font-medium tracking-tight', className)} {...props} />;
}

function EmptyDescription({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="empty-description"
      className={cn('text-sm/relaxed text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary', className)}
      {...props}
    />
  );
}

function EmptyContent({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="empty-content" className={cn('flex w-full max-w-sm min-w-0 flex-col items-center gap-4 text-sm text-balance', className)} {...props} />;
}

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia };
