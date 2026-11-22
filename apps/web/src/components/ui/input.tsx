// shadcn/ui Input (registry new-york-v4), as a forwardRef for React 18 so a ref reaches the <input>. HRMS tuning: the control height
// (--control-h: 38px, 44px on a phone), text at 16px or more on a phone so the browser does not zoom the page on focus, the HRMS
// focus ring, and outline-hidden, which keeps an outline in Windows high-contrast mode. In the dark theme the field is filled with a
// tenth of its edge grey (dark:bg-input/10): the HRMS edge is a strong 3:1 grey, so shadcn's 30% of it would fill the field far more
// heavily than shadcn's own faint fill.
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A file field's "Choose file" button, drawn as a small outlined button inside the field. Every property is set here, so the old
 * file-button rule of styles.css (padding, radius, shadow) no longer shows through it.
 */
const FILE_BUTTON =
  'file:mr-3 file:inline-flex file:h-7 file:cursor-pointer file:items-center file:rounded-sm file:border file:border-input file:bg-card file:px-2.5 file:text-sm file:font-medium file:text-foreground file:shadow-none';

const Input = React.forwardRef<HTMLInputElement, React.ComponentPropsWithoutRef<'input'>>(function Input({ className, type, ...props }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(
        'h-[var(--control-h)] w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground shadow-xs transition-[color,box-shadow] outline-hidden selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 phone:text-[length:max(1rem,16px)] dark:bg-input/10',
        FILE_BUTTON,
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  );
});

export { Input };
