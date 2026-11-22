// shadcn/ui Spinner (registry new-york-v4): a turning mark announced as "Loading".
import { Loader2Icon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

function Spinner({ className, ...props }: React.ComponentPropsWithoutRef<'svg'>) {
  return <Loader2Icon role="status" aria-label="Loading" className={cn('size-4 animate-spin', className)} {...props} />;
}

export { Spinner };
