// shadcn/ui Badge (registry new-york-v4), with the HRMS status tones beside shadcn's own variants: each tone is the status token set
// of styles.css (text, tint and edge, chosen to keep 4.5:1 in both themes). Status is never told by colour alone: a badge always
// carries its words.
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
        destructive:
          'bg-destructive text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/90',
        outline: 'border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        ghost: '[a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 [a&]:hover:underline',
        // HRMS status tones.
        neutral: 'border-[var(--line-strong)] bg-accent text-[var(--body)]',
        good: 'border-[var(--good-edge)] bg-[var(--good-soft)] text-[var(--good)]',
        warn: 'border-[var(--warn-edge)] bg-[var(--warn-soft)] text-[var(--warn)]',
        bad: 'border-[var(--bad-edge)] bg-[var(--bad-soft)] text-[var(--bad)]',
        info: 'border-[var(--info-edge)] bg-[var(--info-soft)] text-[var(--info)]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

type BadgeProps = React.ComponentPropsWithoutRef<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean };

function Badge({ className, variant = 'default', asChild = false, ...props }: BadgeProps) {
  const Comp = asChild ? Slot.Root : 'span';
  return <Comp data-slot="badge" data-variant={variant} className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants, type BadgeProps };
