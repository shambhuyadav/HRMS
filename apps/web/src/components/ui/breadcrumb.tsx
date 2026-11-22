// shadcn/ui Breadcrumb (registry new-york-v4), fitted to the HRMS top bar:
// - The page shown is plain text marked aria-current="page", not a disabled role="link" as in the registry: the screen reader's list
//   of links stays the menu's links, with no stop that goes nowhere.
// - One line that never wraps; a long page name is cut with an ellipsis (as the top bar has always done), not pushed to a second row.
// - No Tailwind reset: the list drops its bullets and indent itself, and a crumb link takes the crumbs' grey, not the brand red that
//   styles.css gives every link.
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { Slot } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/lib/utils';

function Breadcrumb(props: React.ComponentPropsWithoutRef<'nav'>) {
  return <nav aria-label="breadcrumb" data-slot="breadcrumb" {...props} />;
}

function BreadcrumbList({ className, ...props }: React.ComponentPropsWithoutRef<'ol'>) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn('m-0 flex min-w-0 list-none items-center gap-[0.35rem] p-0 text-[0.9rem] text-muted-foreground', className)}
      {...props}
    />
  );
}

function BreadcrumbItem({ className, ...props }: React.ComponentPropsWithoutRef<'li'>) {
  return <li data-slot="breadcrumb-item" className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', className)} {...props} />;
}

function BreadcrumbLink({ asChild, className, ...props }: React.ComponentPropsWithoutRef<'a'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'a';
  return <Comp data-slot="breadcrumb-link" className={cn('text-inherit no-underline transition-colors hover:text-foreground', className)} {...props} />;
}

function BreadcrumbPage({ className, ...props }: React.ComponentPropsWithoutRef<'span'>) {
  return <span data-slot="breadcrumb-page" aria-current="page" className={cn('min-w-0 truncate font-semibold text-foreground', className)} {...props} />;
}

function BreadcrumbSeparator({ children, className, ...props }: React.ComponentPropsWithoutRef<'li'>) {
  return (
    <li data-slot="breadcrumb-separator" role="presentation" aria-hidden="true" className={cn('flex items-center [&>svg]:size-3.5', className)} {...props}>
      {children ?? <ChevronRight />}
    </li>
  );
}

function BreadcrumbEllipsis({ className, ...props }: React.ComponentPropsWithoutRef<'span'>) {
  return (
    <span data-slot="breadcrumb-ellipsis" role="presentation" aria-hidden="true" className={cn('flex size-9 items-center justify-center', className)} {...props}>
      <MoreHorizontal className="size-4" />
      <span className="sr-only">More</span>
    </span>
  );
}

export { Breadcrumb, BreadcrumbEllipsis, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator };
