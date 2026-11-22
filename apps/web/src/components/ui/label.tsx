// shadcn/ui Label (registry new-york-v4) on Radix Label, as a forwardRef for React 18 so a ref reaches the <label>. It lays its
// content out in a row: the old `label` rule of styles.css stacks a label's children in a column, which with items-center would
// centre the words.
import { Label as LabelPrimitive } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/lib/utils';

const Label = React.forwardRef<React.ComponentRef<typeof LabelPrimitive.Root>, React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>>(
  function Label({ className, ...props }, ref) {
    return (
      <LabelPrimitive.Root
        ref={ref}
        data-slot="label"
        className={cn(
          'flex flex-row items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
          className,
        )}
        {...props}
      />
    );
  },
);

export { Label };
