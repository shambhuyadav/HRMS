// The light or dark theme. It follows the device's setting until the person picks one with the switch in the top bar; that choice is
// kept on this device (a convenience only: nothing depends on it, and without storage the device setting applies). The chosen theme is
// set as data-theme on <html>, which styles.css reads; without a choice the attribute is absent and the device setting applies there too.
import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const THEME_KEY = 'hrms.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The theme the person chose on this device, if any. */
export function chosenTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

/** The device's own setting (light where it cannot be read). */
export function deviceTheme(): Theme {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/** Marks the page with the chosen theme, or clears the mark so the device setting applies. */
export function applyTheme(theme: Theme | null): void {
  const root = document.documentElement;
  if (theme) root.dataset.theme = theme;
  else delete root.dataset.theme;
}

/** The theme in effect and a switch to the other one (which becomes the person's choice on this device). */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [chosen, setChosen] = useState<Theme | null>(chosenTheme);
  const [device, setDevice] = useState<Theme>(deviceTheme);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(DARK_QUERY);
    const follow = () => setDevice(query.matches ? 'dark' : 'light');
    query.addEventListener?.('change', follow);
    return () => query.removeEventListener?.('change', follow);
  }, []);
  const theme = chosen ?? device;
  const toggle = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setChosen(next);
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage unavailable: the choice lasts for this page only */
    }
  }, [theme]);
  return { theme, toggle };
}

/** Whether a media query matches now, following changes (false where media queries cannot be read). */
export function useMediaQuery(query: string): boolean {
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(query);
    const follow = () => setMatches(list.matches);
    follow();
    list.addEventListener?.('change', follow);
    return () => list.removeEventListener?.('change', follow);
  }, [query]);
  return matches;
}
