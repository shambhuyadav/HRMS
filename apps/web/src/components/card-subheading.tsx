// A heading inside a card's content (a form's or a part's title), a little apart from what is above it. The card's own title is its
// Section's h2, so a part's heading is an h3, or an h4 under one of those: give `level` the level the screen's outline needs.
// The ref reaches the heading, for a screen that moves the focus to it.
import * as React from 'react';
import { cn } from '@/lib/utils';

const CARD_SUBHEADING = 'mt-2 mb-0 text-[1rem]';

type CardSubheadingProps = React.ComponentPropsWithoutRef<'h3'> & { level?: 3 | 4 };

export const CardSubheading = React.forwardRef<HTMLHeadingElement, CardSubheadingProps>(function CardSubheading({ level = 3, className, ...props }, ref) {
  const Heading = level === 4 ? 'h4' : 'h3';
  return <Heading ref={ref} data-slot="card-subheading" className={cn(CARD_SUBHEADING, className)} {...props} />;
});
