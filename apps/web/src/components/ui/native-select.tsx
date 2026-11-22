// shadcn/ui NativeSelect (registry new-york-v4): the browser's own <select> with a chevron. A forwardRef for React 18: the ref
// reaches the <select>, not the wrapper. HRMS tuning: the control height (--control-h: 38px, 44px on a phone, which the small size
// keeps too), text at 16px or more on a phone (no zoom on focus), the HRMS focus ring, outline-hidden for Windows high-contrast
// mode, and a list box (multiple, or more than one row shown) that keeps its own height and has no chevron. In the dark theme the
// field is filled with a tenth of its edge grey, a fifth under the pointer, as faint as shadcn's own fill (Input explains why).
// The <select> sits inside a wrapper <div> (which holds the chevron); a field's name above it is laid out by FormField.
import { ChevronDownIcon } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

type NativeSelectProps = Omit<React.ComponentPropsWithoutRef<'select'>, 'size'> & {
  /** The control's height: `sm` for a pager or a toolbar. (It takes the place of the select's own `size`; see `rows`.) */
  size?: 'sm' | 'default';
  /**
   * How many choices a list box shows at once (the select's own size attribute). Give a list box as many rows as it has choices, up
   * to a limit, so none is hidden behind its scrollbar.
   */
  rows?: number;
};

/** A drop-down: one line at the control height, room at the end for the chevron. */
const DROP_DOWN = 'h-[var(--control-h)] px-3 py-0 pr-9 data-[size=sm]:h-[34px]';
/**
 * A list box: as tall as its rows. No padding above and below: the browser fits the rows inside the padding, so with it the last row
 * would not fit and the box would show scroll arrows although every choice is on screen.
 */
const LIST_BOX = 'h-auto px-3 py-0';
const SELECT =
  'min-h-0 w-full min-w-0 cursor-pointer appearance-none rounded-md border border-input bg-transparent text-sm text-foreground shadow-xs transition-[color,box-shadow] outline-hidden selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed phone:min-h-[44px] phone:text-[length:max(1rem,16px)] dark:bg-input/10 dark:hover:bg-input/20';
const FOCUS_AND_INVALID =
  'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40';
const CHEVRON = 'pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-muted-foreground opacity-50 select-none';

const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(function NativeSelect({ className, size = 'default', rows, ...props }, ref) {
  const listBox = props.multiple === true || (rows !== undefined && rows > 1);
  return (
    <div className="relative w-fit has-[select:disabled]:opacity-50" data-slot="native-select-wrapper">
      <select
        ref={ref}
        data-slot="native-select"
        data-size={size}
        size={rows}
        className={cn(SELECT, listBox ? LIST_BOX : DROP_DOWN, FOCUS_AND_INVALID, className)}
        {...props}
      />
      {!listBox && <ChevronDownIcon className={CHEVRON} aria-hidden="true" data-slot="native-select-icon" />}
    </div>
  );
});

function NativeSelectOption({ className, ...props }: React.ComponentPropsWithoutRef<'option'>) {
  return <option data-slot="native-select-option" className={cn('bg-[Canvas] text-[CanvasText]', className)} {...props} />;
}

function NativeSelectOptGroup({ className, ...props }: React.ComponentPropsWithoutRef<'optgroup'>) {
  return <optgroup data-slot="native-select-optgroup" className={cn('bg-[Canvas] text-[CanvasText]', className)} {...props} />;
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption, type NativeSelectProps };
