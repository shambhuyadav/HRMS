// shadcn/ui Collapsible (registry new-york-v4) on Radix Collapsible. React 18 passes no `ref` prop to a function component, so the
// trigger and the content, which another Radix part may hand a ref (asChild), are forwardRefs.
// The closed content keeps no children (Radix renders an empty, hidden box), so nothing in a closed group can be reached or found.
import { Collapsible as CollapsiblePrimitive } from 'radix-ui';
import * as React from 'react';

function Collapsible(props: React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

const CollapsibleTrigger = React.forwardRef<
  React.ComponentRef<typeof CollapsiblePrimitive.CollapsibleTrigger>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleTrigger>
>(function CollapsibleTrigger(props, ref) {
  return <CollapsiblePrimitive.CollapsibleTrigger ref={ref} data-slot="collapsible-trigger" {...props} />;
});

const CollapsibleContent = React.forwardRef<
  React.ComponentRef<typeof CollapsiblePrimitive.CollapsibleContent>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleContent>
>(function CollapsibleContent(props, ref) {
  return <CollapsiblePrimitive.CollapsibleContent ref={ref} data-slot="collapsible-content" {...props} />;
});

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
