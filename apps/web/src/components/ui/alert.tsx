// shadcn/ui Alert (registry new-york-v4), adapted for HRMS:
// - Status variants on the status token sets of styles.css (text, tint and edge, 4.5:1 in both themes); the lines under a title
//   are in the text colour, as before, for long messages.
// - `asChild` (Radix Slot) renders the alert, title or description on the caller's own element (a <p role="status">, a <strong>),
//   so a message keeps its element and role; a role given on that element replaces the default "alert".
// - A title is never cut to one line (an error message is read in full), and the alert takes the width it is given rather than a
//   forced full width, as the old .error box did in a row of buttons.
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/lib/utils';

const alertVariants = cva(
  'relative grid grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg border px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current',
  {
    variants: {
      variant: {
        default: 'border-border bg-card text-card-foreground',
        destructive: 'border-[var(--bad-edge)] bg-[var(--bad-soft)] text-destructive *:data-[slot=alert-description]:text-foreground',
        success: 'border-[var(--good-edge)] bg-[var(--good-soft)] text-[var(--good)] *:data-[slot=alert-description]:text-foreground',
        warning: 'border-[var(--warn-edge)] bg-[var(--warn-soft)] text-[var(--warn)] *:data-[slot=alert-description]:text-foreground',
        info: 'border-[var(--info-edge)] bg-[var(--info-soft)] text-[var(--info)] *:data-[slot=alert-description]:text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

type AlertProps = React.ComponentPropsWithoutRef<'div'> & VariantProps<typeof alertVariants> & { asChild?: boolean };

function Alert({ className, variant, asChild = false, ...props }: AlertProps) {
  const Comp = asChild ? Slot.Root : 'div';
  return <Comp data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

function AlertTitle({ className, asChild = false, ...props }: React.ComponentPropsWithoutRef<'div'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'div';
  return <Comp data-slot="alert-title" className={cn('col-start-2 min-h-4 font-medium tracking-tight', className)} {...props} />;
}

function AlertDescription({ className, asChild = false, ...props }: React.ComponentPropsWithoutRef<'div'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'div';
  return (
    <Comp
      data-slot="alert-description"
      className={cn('col-start-2 grid justify-items-start gap-1 text-sm text-muted-foreground [&_p]:leading-relaxed', className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, alertVariants, type AlertProps };
