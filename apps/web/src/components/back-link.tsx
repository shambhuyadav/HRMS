// The way back to a list ("← Employees"; the old `a.back-link`): a quiet muted link, not a red underlined sentence. Placed as a direct
// child of the page, it shows above the page's title (the shell draws the title first), with the page's gap below it taken back.
// On a phone it is a 44px target. Give it its words exactly, arrow included.
import { Link, type LinkProps } from 'react-router-dom';
import { cn } from '@/lib/utils';

/** First in the page's column (`order-first`), its own width, the page's gap under it taken back so it sits just over the title. */
const PLACE = 'order-first -mb-[0.85rem] inline-flex w-auto items-center gap-[0.3rem] self-start';
/** Small muted words with no underline, the accent colour on hover, the HRMS focus ring. */
const LOOK =
  'rounded-sm text-[0.86rem] font-medium text-muted-foreground no-underline outline-hidden hover:text-[var(--accent)] focus-visible:ring-[3px] focus-visible:ring-ring/50 phone:min-h-[44px]';

export function BackLink({ className, ...props }: LinkProps) {
  return <Link data-slot="back-link" className={cn(PLACE, LOOK, className)} {...props} />;
}
