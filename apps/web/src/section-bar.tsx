// A record page's sections as a bar of tab-like links (owner's request of 20 Nov 2026: "the sections as tabs"). Every section stays
// on the page, in its order and with everything in it: the bar only jumps to one and marks the one in view. It stays at the top of
// the page while the page scrolls (styles/profile.css), and on a phone it scrolls sideways inside itself.
//
// A section is found by its heading, as the page draws it (ui.tsx Section), so the page needs no other change: the bar names each
// section it finds with an id, so its link is a real link to that place on the page.

import { type MouseEvent, useEffect, useRef, useState } from 'react';
import './styles/profile.css';

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
    <nav ref={bar} className="section-bar" aria-label={label}>
      <ul ref={list}>
        {sections.map((s) => (
          <li key={s.key}>
            <a href={`#${sectionId(s.key)}`} aria-current={current === s.key ? 'true' : undefined} onClick={go(s)}>
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
