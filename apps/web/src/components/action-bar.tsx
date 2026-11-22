// Actions behind buttons (the old `.action-bar`): a row of outline buttons, each opening its own form. An opened form takes the full
// width below all the buttons, so the row of buttons never breaks around it, and the button of an open form reads as chosen (neutral,
// not the red of a main button). Open forms stay open while others are used, so a form left half-filled keeps its values.
import { type ComponentPropsWithoutRef, createContext, type ReactNode, useContext, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Inside an ActionBar, an Action's own box is left out of the layout, so its button joins the bar's row. */
const InActionBarContext = createContext(false);

/** The row of Actions, wrapping on a narrow screen; the forms opened from them go below the whole row. */
export function ActionBar({ className, children, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div data-slot="action-bar" className={cn('flex flex-wrap items-start gap-2', className)} {...props}>
      <InActionBarContext.Provider value={true}>{children}</InActionBarContext.Provider>
    </div>
  );
}

/** On its own, an Action is its button with what it opened below it (its other child), at the full width. */
const ACTION_ALONE = 'flex flex-col items-start gap-2 [&>:not(button)]:self-stretch';
/**
 * In an ActionBar its box takes no room (`contents`), so the button is an item of the bar's row and what it opened is a full-width
 * item placed after every button.
 */
const ACTION_IN_BAR = 'contents [&>:not(button)]:order-1 [&>:not(button)]:mt-2 [&>:not(button)]:flex-[0_0_100%]';
/** The button of an open form reads as chosen: neutral, raised a little. */
const OPEN_BUTTON = 'aria-expanded:border-[var(--line-hover)] aria-expanded:bg-muted aria-expanded:text-foreground';

/** An action behind a button; `children` draws what the button opens and is given a way to close it. Also used on its own. */
export function Action({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const inBar = useContext(InActionBarContext);
  return (
    <div className={inBar ? ACTION_IN_BAR : ACTION_ALONE}>
      <Button type="button" variant="outline" aria-expanded={open} className={OPEN_BUTTON} onClick={() => setOpen(!open)}>
        {label}
      </Button>
      {open && children(() => setOpen(false))}
    </div>
  );
}
