// shadcn/ui Button (registry new-york-v4), adapted to React 18 and the HRMS look:
// - React 18 passes no `ref` prop to a function component, so the button is a forwardRef and a ref reaches the <button>.
// - Heights follow the HRMS control height (--control-h: 38px, 44px on a phone), and on a phone every size is at least 44px.
// - Every variant sets each property the old `button` rule of styles.css sets (background, border, colour, shadow, min-height),
//   so the red of that rule never shows through a quieter variant.
// - A disabled main button is grey, not a washed-out red that reads as an error (styles.css, revamp of 19 Nov 2026), and a
//   disabled button still shows its title on hover (no pointer-events: none).
// - Keyboard focus is the ring in the HRMS focus blue; outline-hidden keeps an outline in Windows high-contrast mode.
// - A button drawn on a link (asChild with <Link>) is not underlined: the browser underlines every <a> (the link variant underlines
//   on hover).
// - `danger` is the HRMS outlined red (Deactivate, End, Remove): the card colour with red words and edge, a red tint on hover, so it
//   stands apart from the filled red main button beside it (the brand colour is red too, so colour alone would not tell them apart).
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  [
    'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md border border-transparent text-sm font-medium whitespace-nowrap no-underline',
    'min-h-0 shadow-none transition-all outline-hidden phone:min-h-[44px]',
    'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
    'disabled:cursor-not-allowed disabled:opacity-50',
    'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
  ],
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground hover:bg-[var(--accent-fill-hover)] disabled:border-border disabled:bg-muted disabled:text-[var(--faint)] disabled:opacity-100',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40',
        // On the card: a button of the card's colour with a hairline edge. In the dark theme, shadcn's faint fill and its lighter
        // hairline: a tenth of the field-edge grey (a fifth under the pointer) and the stronger hairline, since the HRMS field edge
        // (3:1, for fields) would make a button look like a field.
        outline:
          'border-border bg-card text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-[var(--line-strong)] dark:bg-input/10 dark:hover:bg-input/20',
        danger:
          'border-[var(--bad-edge)] bg-card text-[var(--bad)] shadow-xs hover:border-[var(--bad)] hover:bg-[var(--bad-soft)] hover:text-[var(--bad)]',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        // Link text uses the HRMS text accent, which keeps 4.5:1 in both themes (the fill red is for white text on it).
        link: 'bg-transparent text-[var(--accent)] underline-offset-4 hover:text-[var(--accent-hover)] hover:underline',
      },
      size: {
        default: 'h-[var(--control-h)] px-4 py-0 has-[>svg]:px-3',
        xs: 'h-6 gap-1 rounded-md px-2 py-0 text-xs has-[>svg]:px-1.5 [&_svg:not([class*=size-])]:size-3',
        sm: 'h-[34px] gap-1.5 rounded-md px-3 py-0 has-[>svg]:px-2.5',
        lg: 'h-[42px] rounded-md px-6 py-0 has-[>svg]:px-4',
        icon: 'size-[var(--control-h)] p-0',
        'icon-xs': 'size-6 rounded-md p-0 phone:min-w-[44px] [&_svg:not([class*=size-])]:size-3',
        'icon-sm': 'size-[34px] p-0 phone:min-w-[44px]',
        'icon-lg': 'size-[42px] p-0 phone:min-w-[44px]',
        // A link-styled button inside a sentence (the old `button.link`): no box of its own, so it stays on the sentence's line.
        inline: 'h-auto p-0 align-baseline',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

type ButtonProps = React.ComponentPropsWithoutRef<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'default', size = 'default', asChild = false, ...props },
  ref,
) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp ref={ref} data-slot="button" data-variant={variant} data-size={size} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
});

export { Button, buttonVariants, type ButtonProps };
