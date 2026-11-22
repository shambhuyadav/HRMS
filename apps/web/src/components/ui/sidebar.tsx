// shadcn/ui Sidebar (registry new-york-v4), adapted to the HRMS shell (owner's decisions for the move to shadcn/ui):
// - At 920px wide or less (hooks/use-mobile) the menu is a Sheet that slides over the page; on a wider screen it is always the full
//   264px menu beside the page. There is no way to hide the menu on a wide screen: the registry's Ctrl/Cmd+B shortcut, the cookie
//   that remembered a hidden menu and the rail that hides it are left out, and the shell draws no trigger there.
// - The sheet's open state can be held by the caller (openMobile and onOpenMobileChange), so the shell keeps one menu state for its
//   top-bar button, the phone bar's "More" and its own classes.
// - The sheet is named "Menu" for assistive technology (the registry says "Sidebar"), with no description.
// - The menu never shrinks to icons, so the icon-mode tooltips (and with them the Tooltip dependency) are left out, as are the parts
//   the shell does not use (input, skeleton, group and row actions).
// - The look is shadcn's light sidebar (owner's request of 23 Nov 2026; zinc-900 in the dark theme), its colours the --color-sidebar
//   roles of tailwind.css: rows of 0.87rem text beside an 18px icon, the row of the page shown on the hover tint in the strong text
//   colour with the brand red marker at its edge (the menu's one red signal), uppercase section titles in the muted text. A row is
//   lit when isActive is set or when it is a router link to the page shown (NavLink marks it aria-current="page"). Each <button>
//   sets every property of the old `button` rule of styles.css, each link sets its own colour and underline, lists drop their
//   bullets and indent, and borders name their colour: there is no Tailwind reset.
// - React 18: SidebarMenuButton is a forwardRef, so a Radix trigger rendered through it (asChild) reaches the <button>.
import { cva, type VariantProps } from 'class-variance-authority';
import { PanelLeftIcon } from 'lucide-react';
import { Slot } from 'radix-ui';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

/** The HRMS menu width beside the page, and the width of the menu sheet on a smaller screen. */
const SIDEBAR_WIDTH = '264px';
const SIDEBAR_WIDTH_MOBILE = '280px';
const SIDEBAR_WIDTH_ICON = '3rem';

type SetOpen = (open: boolean | ((open: boolean) => boolean)) => void;

type SidebarContextProps = {
  state: 'expanded' | 'collapsed';
  open: boolean;
  setOpen: SetOpen;
  openMobile: boolean;
  setOpenMobile: SetOpen;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextProps | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) throw new Error('useSidebar must be used within a SidebarProvider.');
  return context;
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  openMobile: openMobileProp,
  onOpenMobileChange: setOpenMobileProp,
  className,
  style,
  children,
  ...props
}: React.ComponentPropsWithoutRef<'div'> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Whether the menu sheet is open (smaller screens), when the caller holds that state. */
  openMobile?: boolean;
  onOpenMobileChange?: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();

  const [ownOpenMobile, setOwnOpenMobile] = React.useState(false);
  const openMobile = openMobileProp ?? ownOpenMobile;
  const setOpenMobile = React.useCallback<SetOpen>(
    (value) => {
      const next = typeof value === 'function' ? value(openMobile) : value;
      if (setOpenMobileProp) setOpenMobileProp(next);
      else setOwnOpenMobile(next);
    },
    [setOpenMobileProp, openMobile],
  );

  // The menu beside the page: open unless the caller says otherwise (nothing in the HRMS shell closes it).
  const [ownOpen, setOwnOpen] = React.useState(defaultOpen);
  const open = openProp ?? ownOpen;
  const setOpen = React.useCallback<SetOpen>(
    (value) => {
      const next = typeof value === 'function' ? value(open) : value;
      if (setOpenProp) setOpenProp(next);
      else setOwnOpen(next);
    },
    [setOpenProp, open],
  );

  const toggleSidebar = React.useCallback(() => (isMobile ? setOpenMobile((value) => !value) : setOpen((value) => !value)), [isMobile, setOpen, setOpenMobile]);

  const state = open ? 'expanded' : 'collapsed';
  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({ state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar }),
    [state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        data-slot="sidebar-wrapper"
        style={{ '--sidebar-width': SIDEBAR_WIDTH, '--sidebar-width-icon': SIDEBAR_WIDTH_ICON, ...style } as React.CSSProperties}
        className={cn('group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar', className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

function Sidebar({
  side = 'left',
  variant = 'sidebar',
  collapsible = 'offcanvas',
  mobileTitle = 'Menu',
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<'div'> & {
  side?: 'left' | 'right';
  variant?: 'sidebar' | 'floating' | 'inset';
  collapsible?: 'offcanvas' | 'icon' | 'none';
  /** The sheet's name for assistive technology on a smaller screen. */
  mobileTitle?: string;
}) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();
  // The sheet is opened by buttons outside it (the shell's menu button, the phone bar's "More"), not by a Radix trigger, so it gives
  // the focus back itself, to whatever had it when the sheet opened.
  const returnFocus = React.useRef<HTMLElement | null>(null);

  if (collapsible === 'none') {
    return (
      <div data-slot="sidebar" className={cn('flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground', className)} {...props}>
        {children}
      </div>
    );
  }

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent
          data-sidebar="sidebar"
          data-slot="sidebar"
          data-mobile="true"
          side={side}
          showCloseButton={false}
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus();
            returnFocus.current = null;
          }}
          className="w-(--sidebar-width) gap-0 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground"
          style={{ '--sidebar-width': SIDEBAR_WIDTH_MOBILE } as React.CSSProperties}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{mobileTitle}</SheetTitle>
          </SheetHeader>
          <div className="flex h-full w-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div
      className="group peer block text-sidebar-foreground"
      data-state={state}
      data-collapsible={state === 'collapsed' ? collapsible : ''}
      data-variant={variant}
      data-side={side}
      data-slot="sidebar"
    >
      {/* Holds the menu's width in the page's row, beside the fixed menu. */}
      <div
        data-slot="sidebar-gap"
        className={cn(
          'relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear',
          'group-data-[collapsible=offcanvas]:w-0',
          'group-data-[side=right]:rotate-180',
          variant === 'floating' || variant === 'inset' ? 'group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]' : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon)',
        )}
      />
      <div
        data-slot="sidebar-container"
        className={cn(
          'fixed inset-y-0 z-10 flex h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear',
          side === 'left' ? 'left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]' : 'right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]',
          // The menu draws the hairline between itself and the page.
          variant === 'floating' || variant === 'inset'
            ? 'p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]'
            : 'border-sidebar-border bg-sidebar group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l',
          className,
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className="flex h-full w-full flex-col bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow-sm"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** Opens and closes the menu sheet. The shell draws it only where the menu is a sheet; its children replace the registry's icon. */
function SidebarTrigger({ className, onClick, children, ...props }: React.ComponentPropsWithoutRef<typeof Button>) {
  const { toggleSidebar } = useSidebar();
  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon"
      className={cn('size-7', className)}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...props}
    >
      {children ?? (
        <>
          <PanelLeftIcon />
          <span className="sr-only">Toggle Sidebar</span>
        </>
      )}
    </Button>
  );
}

function SidebarInset({ className, ...props }: React.ComponentPropsWithoutRef<'main'>) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn(
        'relative flex w-full flex-1 flex-col bg-background',
        'peer-data-[variant=inset]:m-2 peer-data-[variant=inset]:ml-0 peer-data-[variant=inset]:rounded-xl peer-data-[variant=inset]:shadow-sm peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2',
        className,
      )}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="sidebar-header" data-sidebar="header" className={cn('flex flex-col gap-2 p-2', className)} {...props} />;
}

function SidebarFooter({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="sidebar-footer" data-sidebar="footer" className={cn('flex flex-col gap-2 p-2', className)} {...props} />;
}

function SidebarSeparator({ className, ...props }: React.ComponentPropsWithoutRef<typeof Separator>) {
  return <Separator data-slot="sidebar-separator" data-sidebar="separator" className={cn('mx-2 w-auto bg-sidebar-border', className)} {...props} />;
}

/** The menu's scrolling body, with the HRMS menu's padding and a thin scrollbar in the stronger hairline colour. */
function SidebarContent({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-3 pt-[0.85rem] pb-6 [scrollbar-color:var(--line-strong)_transparent] [scrollbar-width:thin] group-data-[collapsible=icon]:overflow-hidden',
        className,
      )}
      {...props}
    />
  );
}

/** A section of the menu: its title, then its rows, 2px apart. */
function SidebarGroup({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="sidebar-group" data-sidebar="group" className={cn('relative flex w-full min-w-0 flex-col gap-[2px] p-0', className)} {...props} />;
}

/** A section title (WORKSPACE, MODULES): small uppercase letters, spaced out, in the menu's muted text (4.5:1). */
function SidebarGroupLabel({ className, asChild = false, ...props }: React.ComponentPropsWithoutRef<'div'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'div';
  return (
    <Comp
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn(
        'mx-3 mt-[0.2rem] mb-[0.4rem] flex shrink-0 items-center rounded-md p-0 text-[0.72rem] font-medium tracking-[0.07em] text-sidebar-muted-foreground uppercase ring-sidebar-ring outline-hidden transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2 [&>svg]:shrink-0',
        'group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroupContent({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="sidebar-group-content" data-sidebar="group-content" className={cn('w-full text-sm', className)} {...props} />;
}

function SidebarMenu({ className, ...props }: React.ComponentPropsWithoutRef<'ul'>) {
  return <ul data-slot="sidebar-menu" data-sidebar="menu" className={cn('m-0 flex w-full min-w-0 list-none flex-col gap-[2px] p-0', className)} {...props} />;
}

function SidebarMenuItem({ className, ...props }: React.ComponentPropsWithoutRef<'li'>) {
  return <li data-slot="sidebar-menu-item" data-sidebar="menu-item" className={cn('group/menu-item relative', className)} {...props} />;
}

// The row of the page shown: on the hover tint in the strong text colour (its icon too), with the brand red marker at its edge; in
// Windows high-contrast mode, the system's highlight colours (the tint and the marker are not drawn there).
const LIT_ROW = [
  'data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground data-[active=true]:shadow-[inset_2px_0_0_var(--sidebar-marker)]',
  'aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground aria-[current=page]:shadow-[inset_2px_0_0_var(--sidebar-marker)]',
  'forced-colors:data-[active=true]:bg-[color:Highlight] forced-colors:data-[active=true]:text-[color:HighlightText] forced-colors:data-[active=true]:forced-color-adjust-none forced-colors:data-[active=true]:[&>svg:first-child]:text-[color:HighlightText]',
  'forced-colors:aria-[current=page]:bg-[color:Highlight] forced-colors:aria-[current=page]:text-[color:HighlightText] forced-colors:aria-[current=page]:forced-color-adjust-none forced-colors:aria-[current=page]:[&>svg:first-child]:text-[color:HighlightText]',
];

// A row: a link to a page, or the button that opens a module's group, its icon in the words' colour. Long names wrap (none is cut
// short).
const ROW = [
  'flex items-center rounded-sm border-0 bg-transparent font-medium text-sidebar-foreground no-underline shadow-none ring-sidebar-ring outline-hidden',
  'transition-[color,background-color,box-shadow] duration-[120ms] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground',
  'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>svg]:shrink-0',
];

const sidebarMenuButtonVariants = cva(
  [
    'peer/menu-button w-full gap-[0.7rem] overflow-hidden text-left',
    ...ROW,
    ...LIT_ROW,
    'group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2!',
  ],
  {
    variants: {
      size: {
        default: 'min-h-8 px-3 py-[0.46rem] text-[0.87rem]',
        sm: 'min-h-7 px-2 py-1 text-xs',
        lg: 'min-h-12 p-2 text-sm group-data-[collapsible=icon]:p-0!',
      },
    },
    defaultVariants: { size: 'default' },
  },
);

type SidebarMenuButtonProps = React.ComponentPropsWithoutRef<'button'> & { asChild?: boolean; isActive?: boolean } & VariantProps<typeof sidebarMenuButtonVariants>;

const SidebarMenuButton = React.forwardRef<HTMLButtonElement, SidebarMenuButtonProps>(function SidebarMenuButton(
  { asChild = false, isActive = false, size = 'default', className, ...props },
  ref,
) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      ref={ref}
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ size }), className)}
      {...props}
    />
  );
});

function SidebarMenuBadge({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        'pointer-events-none absolute right-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium text-sidebar-muted-foreground tabular-nums select-none',
        'peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground',
        'peer-data-[size=sm]/menu-button:top-1 peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  );
}

/** The screens of an open group, indented under a hairline. */
function SidebarMenuSub({ className, ...props }: React.ComponentPropsWithoutRef<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn(
        'mt-[2px] mr-0 mb-[6px] ml-[1.45rem] flex min-w-0 list-none flex-col gap-px border-l border-sidebar-border py-0 pr-0 pl-[0.65rem]',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentPropsWithoutRef<'li'>) {
  return <li data-slot="sidebar-menu-sub-item" data-sidebar="menu-sub-item" className={cn('group/menu-sub-item relative', className)} {...props} />;
}

function SidebarMenuSubButton({
  asChild = false,
  size = 'md',
  isActive = false,
  className,
  ...props
}: React.ComponentPropsWithoutRef<'a'> & { asChild?: boolean; size?: 'sm' | 'md'; isActive?: boolean }) {
  const Comp = asChild ? Slot.Root : 'a';
  return (
    <Comp
      data-slot="sidebar-menu-sub-button"
      data-sidebar="menu-sub-button"
      data-size={size}
      data-active={isActive}
      className={cn(
        'min-h-7 min-w-0 gap-2 overflow-hidden px-[0.65rem] py-[0.4rem] [&>svg]:text-sidebar-accent-foreground',
        ...ROW,
        ...LIT_ROW,
        size === 'sm' && 'text-xs',
        size === 'md' && 'text-[0.84rem]',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  sidebarMenuButtonVariants,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
};
