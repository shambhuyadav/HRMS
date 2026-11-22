// Hand-written tabs and segmented choices, drawn like shadcn's TabsList and TabsTrigger: a sunken strip of quiet buttons, the chosen
// one raised on the card colour. They stay plain buttons, not Radix Tabs or ToggleGroup: Radix Tabs do not switch on a click in the
// tests (phase 3 guide). The screen keeps its roles and its keyboard handling (arrow keys between tabs, the tab panel).
import * as React from 'react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** The strip, wrapping on a narrow screen, with no frame of its own. */
const STRIP = 'flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-lg border-0 bg-muted p-[3px]';

/**
 * Muted words on the strip; the chosen one (marked by aria-selected or aria-pressed) on the card colour, raised. In Windows
 * high-contrast mode, where tints and shadows are not drawn, the chosen one is in the system's highlight colours.
 */
const STRIP_BUTTON = cn(
  'text-muted-foreground aria-selected:border-border aria-selected:bg-card aria-selected:text-foreground aria-selected:shadow-sm',
  'aria-pressed:border-border aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-sm',
  'forced-colors:aria-selected:bg-[color:Highlight] forced-colors:aria-selected:text-[color:HighlightText] forced-colors:aria-selected:forced-color-adjust-none',
  'forced-colors:aria-pressed:bg-[color:Highlight] forced-colors:aria-pressed:text-[color:HighlightText] forced-colors:aria-pressed:forced-color-adjust-none',
);

/** A list of tabs (role="tablist"); give it its name (aria-label). */
export function TabList({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div role="tablist" data-slot="tab-list" className={cn(STRIP, className)} {...props} />;
}

type TabProps = Omit<ButtonProps, 'variant' | 'size' | 'type' | 'role'> & { selected: boolean };

/** One tab: role="tab" and aria-selected; the screen gives its id, aria-controls, tabIndex and key handling. */
export const Tab = React.forwardRef<HTMLButtonElement, TabProps>(function Tab({ selected, className, ...props }, ref) {
  return <Button ref={ref} type="button" variant="ghost" size="sm" role="tab" aria-selected={selected} className={cn(STRIP_BUTTON, className)} {...props} />;
});

/**
 * A choice of one of a few views (the old `.toggle-group`), often in a card's header: the same strip, with no role of its own, as
 * before. Its buttons are a little lower than a small button, so the strip is no taller than a field beside the card's title.
 */
export function SegmentedChoice({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="segmented-choice" className={cn(STRIP, className)} {...props} />;
}

type SegmentedOptionProps = Omit<ButtonProps, 'variant' | 'size' | 'type'> & { pressed: boolean };

/** One choice of a SegmentedChoice: a toggle button (aria-pressed). */
export const SegmentedOption = React.forwardRef<HTMLButtonElement, SegmentedOptionProps>(function SegmentedOption({ pressed, className, ...props }, ref) {
  return <Button ref={ref} type="button" variant="ghost" size="sm" aria-pressed={pressed} className={cn(STRIP_BUTTON, 'h-[32px]', className)} {...props} />;
});
