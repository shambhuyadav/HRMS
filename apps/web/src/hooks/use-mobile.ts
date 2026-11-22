// shadcn/ui's useIsMobile (registry new-york-v4 hooks/use-mobile), at the HRMS breakpoint: at 920px wide or less the menu is a sheet
// that slides over the page (the width at which the HRMS menu has always folded away), not shadcn's 768px. The width is read
// with useMediaQuery (theme.ts), which answers on the first render already (a phone never draws the desktop menu first) and answers
// false where media queries cannot be read (jsdom, in the tests, has no matchMedia).
import { useMediaQuery } from '@/theme';

/** The widths at which the menu is a sheet over the page; wider screens always show the full menu beside the page. */
export const MOBILE_QUERY = '(max-width: 920px)';

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}
