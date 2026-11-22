// shadcn/ui Skeleton (registry new-york-v4). HRMS tuning: the sunken surface (the registry's accent is the near-white soft surface
// here, which would not show on a white card), and no pulse for a person who asks for reduced motion.
import type * as React from 'react';
import { cn } from '@/lib/utils';

function Skeleton({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="skeleton" className={cn('animate-pulse rounded-md bg-muted motion-reduce:animate-none', className)} {...props} />;
}

export { Skeleton };
