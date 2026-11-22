// A record page's sections as a bar of tab-like links (owner's request of 20 Nov 2026: "the sections as tabs"). Every section stays
// on the page, in its order and with everything in it: the bar only jumps to one and marks the one in view. It stays at the top of
// the page while the page scrolls, and on a phone it scrolls sideways inside itself. The page's sections come to rest below it, and a
// list's sticky column headings stop under it (styles.css, by the bar's height `--section-bar-h`, which the bar takes too).
//
// A section is found by its heading, as the page draws it (ui.tsx Section), so the page needs no other change: the bar names each
// section it finds with an id, so its link is a real link to that place on the page.

import { type MouseEvent, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * A band of the page's own background, so what scrolls under the bar never shows around it; its padding is taken back by its
 * margins, so the space between the cards stays the page's own. A sticky box stops at the page's top padding (--content-top), so the
 * bar is lifted by that much and meets the top bar with nothing scrolling past above it.
 */
const BAR = 'sticky top-[calc(-1*var(--content-top,0rem))] z-4 -my-2 h-[var(--section-bar-h,3.6rem)] bg-background py-2';
/** The tiles' strip on the card colour, scrolling sideways on a narrow screen with no scrollbar shown. */
const STRIP =
  'm-0 flex h-full list-none items-stretch gap-[2px] overflow-x-auto overscroll-x-contain rounded-lg border border-border bg-card p-[3px] shadow-[var(--shadow-xs)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';
const LINK =
  'inline-flex items-center rounded-md px-[0.9rem] text-[0.85rem] font-medium whitespace-nowrap text-muted-foreground no-underline transition-[background,color,box-shadow] duration-[120ms] hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-[var(--focus)] motion-reduce:transition-none phone:px-3';
/**
 * The section in view: ink on a sunken tile with an accent underline (the red tint alone read like an error), hovered or not; in
 * Windows high-contrast mode, where tints and shadows are not drawn, the system's highlight colours.
 */
const LINK_IN_VIEW =
  'bg-muted font-semibold text-foreground shadow-[inset_0_-2px_0_var(--accent-bright)] hover:bg-muted forced-colors:bg-[color:Highlight] forced-colors:text-[color:HighlightText] forced-colors:forced-color-adjust-none';

export interface BarSection {
  /** A stable key; the section is given the id `section-<key>`. */
  key: string;
  /** The words on the bar. */
  label: string;
  /** The section's title, as its heading reads: it finds the section on the page. */
  heading: string;
}

export const sectionId = (key: string) => `section-${key}`;

/** The section headed `heading` beside the bar: a <section> whose own heading reads it. */
function findSection(scope: ParentNode, heading: string): HTMLElement | null {
  for (const h of Array.from(scope.querySelectorAll('section > h2, section > header > h2'))) {
    if (h.textContent?.trim() === heading) return h.closest('section');
  }
  return null;
}

/** The box that scrolls the page (the shell's main content), or null for the window. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return p;
  }
  return null;
}

const smoothScroll = () => !(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

export function SectionBar({ sections, label = 'Sections of this record' }: { sections: readonly BarSection[]; label?: string }) {
  const bar = useRef<HTMLElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState<string | null>(null);
  // A chosen section stays marked while the page scrolls to it, whatever passes through view on the way.
  const heldUntil = useRef(0);
  const latest = useRef(sections);
  latest.current = sections;
  const signature = sections.map((s) => `${s.key}\u0000${s.heading}`).join('\u0001');

  useEffect(() => {
    const own = bar.current;
    const scope = own?.parentElement;
    if (!own || !scope) return;
    const found = latest.current.flatMap((s) => {
      const el = findSection(scope, s.heading);
      if (!el) return [];
      if (!el.id) el.id = sectionId(s.key);
      return [{ key: s.key, el }];
    });
    // Without an observer (an older browser, or a test page) the first section stays marked until one is chosen.
    if (typeof IntersectionObserver === 'undefined' || found.length === 0) return;
    const root = scrollerOf(own);
    const below = Math.round(own.offsetHeight + 8);
    // Sections in the band under the bar, down to a little under half the screen, and sections in sight at all.
    const inBand = new Set<Element>();
    const inSight = new Set<Element>();
    const scroller = () => root ?? document.scrollingElement;
    const atEnd = () => {
      const el = scroller();
      return !!el && el.scrollHeight > el.clientHeight && el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    };
    // The first section in the band is the one being read; at the very end of the page, the last one in sight (a short last
    // section never reaches the band).
    const mark = () => {
      if (Date.now() < heldUntil.current) return;
      const pick = atEnd() ? [...found].reverse().find((f) => inSight.has(f.el)) : found.find((f) => inBand.has(f.el));
      if (pick) setActive(pick.key);
    };
    const track = (into: Set<Element>) => (entries: IntersectionObserverEntry[]) => {
      for (const entry of entries) {
        if (entry.isIntersecting) into.add(entry.target);
        else into.delete(entry.target);
      }
      mark();
    };
    const band = new IntersectionObserver(track(inBand), { root, rootMargin: `-${below}px 0px -55% 0px` });
    const sight = new IntersectionObserver(track(inSight), { root, rootMargin: `-${below}px 0px 0px 0px` });
    for (const f of found) {
      band.observe(f.el);
      sight.observe(f.el);
    }
    // A section chosen stays marked until the page has finished moving to it; reaching the end of the page marks its last section.
    const target: HTMLElement | Window = root ?? window;
    const scrolled = () => {
      if (Date.now() < heldUntil.current) heldUntil.current = Math.max(heldUntil.current, Date.now() + 150);
      else if (atEnd()) mark();
    };
    target.addEventListener('scroll', scrolled, { passive: true });
    return () => {
      band.disconnect();
      sight.disconnect();
      target.removeEventListener('scroll', scrolled);
    };
  }, [signature]);

  const current = active !== null && sections.some((s) => s.key === active) ? active : (sections[0]?.key ?? null);

  // On a phone the bar scrolls sideways: the marked link is kept in sight (the bar's own scroll only, never the page's).
  useEffect(() => {
    const ul = list.current;
    const link = ul?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!ul || !link || ul.scrollWidth <= ul.clientWidth) return;
    const left = link.offsetLeft - ul.offsetLeft;
    if (left < ul.scrollLeft || left + link.offsetWidth > ul.scrollLeft + ul.clientWidth) {
      if (typeof ul.scrollTo === 'function') ul.scrollTo({ left: Math.max(0, left - 16), behavior: smoothScroll() ? 'smooth' : 'auto' });
    }
  }, [current]);

  const go = (s: BarSection) => (event: MouseEvent<HTMLAnchorElement>) => {
    const scope = bar.current?.parentElement;
    const el = (scope ? findSection(scope, s.heading) : null) ?? document.getElementById(sectionId(s.key));
    // The page is moved here, never by the address: a fragment in the address would be a navigation of its own.
    event.preventDefault();
    if (!el) return;
    heldUntil.current = Date.now() + 1000;
    setActive(s.key);
    el.scrollIntoView?.({ behavior: smoothScroll() ? 'smooth' : 'auto', block: 'start' });
    // The heading takes the focus, so the keyboard and a screen reader carry on from the section chosen.
    const heading = el.querySelector<HTMLElement>(':scope > h2, :scope > header > h2');
    if (heading) {
      if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  };

  if (sections.length < 2) return null;
  return (
    <nav ref={bar} data-slot="section-bar" className={BAR} aria-label={label}>
      <ul ref={list} className={STRIP}>
        {sections.map((s) => (
          <li key={s.key} className="flex flex-none">
            <a
              href={`#${sectionId(s.key)}`}
              aria-current={current === s.key ? 'true' : undefined}
              className={cn(LINK, current === s.key && LINK_IN_VIEW)}
              onClick={go(s)}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
