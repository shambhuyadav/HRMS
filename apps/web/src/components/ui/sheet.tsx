// shadcn/ui Sheet (registry new-york-v4) on Radix Dialog: a panel that slides in from an edge, modal (the focus moves into it and
// stays there, Escape or a click on the dimmed page closes it, and the page behind is hidden from assistive technology meanwhile).
// HRMS tuning:
// - React 18 passes no `ref` prop to a function component, and Radix gives refs to the parts it renders (the portal hands one to the
//   overlay and the panel; a trigger may sit inside another asChild part), so the parts that draw an element are forwardRefs.
// - The dimmed page is shadcn's scrim (black at 50%), the panel's shadow the HRMS large shadow, and the panel the card surface. The
//   panel slides in 0.2s, as the HRMS menu always has.
// - A person who asks for reduced motion sees the panel fade in place instead of sliding across.
// - Borders name their colour and the close button sets every property of the old `button` rule of styles.css (no Tailwind reset).
import { XIcon } from 'lucide-react';
import { Dialog as SheetPrimitive } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/lib/utils';

function Sheet(props: React.ComponentPropsWithoutRef<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

const SheetTrigger = React.forwardRef<React.ComponentRef<typeof SheetPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof SheetPrimitive.Trigger>>(
  function SheetTrigger(props, ref) {
    return <SheetPrimitive.Trigger ref={ref} data-slot="sheet-trigger" {...props} />;
  },
);

const SheetClose = React.forwardRef<React.ComponentRef<typeof SheetPrimitive.Close>, React.ComponentPropsWithoutRef<typeof SheetPrimitive.Close>>(function SheetClose(props, ref) {
  return <SheetPrimitive.Close ref={ref} data-slot="sheet-close" {...props} />;
});

function SheetPortal(props: React.ComponentPropsWithoutRef<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

const SheetOverlay = React.forwardRef<React.ComponentRef<typeof SheetPrimitive.Overlay>, React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>>(
  function SheetOverlay({ className, ...props }, ref) {
    return (
      <SheetPrimitive.Overlay
        ref={ref}
        data-slot="sheet-overlay"
        className={cn(
          'fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
          className,
        )}
        {...props}
      />
    );
  },
);

type SheetContentProps = React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> & { side?: 'top' | 'right' | 'bottom' | 'left'; showCloseButton?: boolean };

const SheetContent = React.forwardRef<React.ComponentRef<typeof SheetPrimitive.Content>, SheetContentProps>(function SheetContent(
  { className, children, side = 'right', showCloseButton = true, ...props },
  ref,
) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        ref={ref}
        data-slot="sheet-content"
        className={cn(
          'fixed z-50 flex flex-col gap-4 border-border bg-card text-foreground shadow-[var(--shadow-lg)] transition ease-in-out',
          'data-[state=closed]:animate-out data-[state=closed]:duration-200 data-[state=open]:animate-in data-[state=open]:duration-200',
          'motion-reduce:data-[state=closed]:fade-out-0 motion-reduce:data-[state=open]:fade-in-0',
          side === 'right' &&
            'inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm motion-reduce:data-[state=closed]:slide-out-to-right-0 motion-reduce:data-[state=open]:slide-in-from-right-0',
          side === 'left' &&
            'inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm motion-reduce:data-[state=closed]:slide-out-to-left-0 motion-reduce:data-[state=open]:slide-in-from-left-0',
          side === 'top' &&
            'inset-x-0 top-0 h-auto border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top motion-reduce:data-[state=closed]:slide-out-to-top-0 motion-reduce:data-[state=open]:slide-in-from-top-0',
          side === 'bottom' &&
            'inset-x-0 bottom-0 h-auto border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom motion-reduce:data-[state=closed]:slide-out-to-bottom-0 motion-reduce:data-[state=open]:slide-in-from-bottom-0',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close className="absolute top-4 right-4 min-h-0 cursor-pointer rounded-xs border-0 bg-transparent p-0 text-foreground opacity-70 shadow-none ring-offset-background transition-opacity hover:bg-transparent hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
});

function SheetHeader({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="sheet-header" className={cn('flex flex-col gap-1.5 p-4', className)} {...props} />;
}

function SheetFooter({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="sheet-footer" className={cn('mt-auto flex flex-col gap-2 p-4', className)} {...props} />;
}

const SheetTitle = React.forwardRef<React.ComponentRef<typeof SheetPrimitive.Title>, React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>>(function SheetTitle(
  { className, ...props },
  ref,
) {
  return <SheetPrimitive.Title ref={ref} data-slot="sheet-title" className={cn('m-0 font-semibold text-foreground', className)} {...props} />;
});

const SheetDescription = React.forwardRef<React.ComponentRef<typeof SheetPrimitive.Description>, React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>>(
  function SheetDescription({ className, ...props }, ref) {
    return <SheetPrimitive.Description ref={ref} data-slot="sheet-description" className={cn('m-0 text-sm text-muted-foreground', className)} {...props} />;
  },
);

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger };
