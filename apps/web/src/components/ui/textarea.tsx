// shadcn/ui Textarea (registry new-york-v4), as a forwardRef for React 18 so a ref reaches the <textarea>. HRMS tuning: text at 16px
// or more on a phone (no zoom on focus), the HRMS focus ring, outline-hidden for Windows high-contrast mode. The registry's
// field-sizing-content is left out, so a textarea keeps the height its `rows` give it, as the app's textareas do now. It resizes up
// and down only (resize-y), as the app's textareas did before the move: sideways it would run out of its card. In the dark theme it
// is filled with a tenth of its edge grey, as faint as shadcn's own fill (Input explains why).
import * as React from 'react';
import { cn } from '@/lib/utils';

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentPropsWithoutRef<'textarea'>>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      className={cn(
        'flex min-h-16 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground shadow-xs transition-[color,box-shadow] outline-hidden placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 phone:text-[length:max(1rem,16px)] dark:bg-input/10 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  );
});

export { Textarea };
