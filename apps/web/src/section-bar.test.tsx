// A record's header card and its section bar (profile-header.tsx, section-bar.tsx), jsdom: the initials stand in for a photo, every
// value is written with its words, the bar links every section it names (all of them stay on the page), marks the one chosen or in
// view, and moves the focus to the section chosen. Synthetic data only.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialsOf, placeFact, ProfileHeader, profileSubtitle } from './profile-header';
import { type BarSection, SectionBar } from './section-bar';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SECTIONS: BarSection[] = [
  { key: 'overview', label: 'Overview', heading: 'Synthetic Person (SYN-1)' },
  { key: 'private', label: 'Private details', heading: 'Private details' },
  { key: 'history', label: 'History', heading: 'Employment history' },
];

function Page({ sections = SECTIONS }: { sections?: BarSection[] }) {
  return (
    <div>
      <SectionBar sections={sections} />
      <section className="card">
        <header className="card-header">
          <h2>Synthetic Person (SYN-1)</h2>
        </header>
        <p>The record</p>
      </section>
      <section className="card">
        <h2 className="sr-only">Private details</h2>
        <p>Shown on request</p>
      </section>
      <section className="card">
        <header className="card-header">
          <h2>Employment history</h2>
        </header>
        <h3>Shifts</h3>
      </section>
    </div>
  );
}

const bar = () => screen.getByRole('navigation', { name: 'Sections of this record' });
const link = (name: string) => within(bar()).getByRole('link', { name });
const sectionOf = (heading: string) => screen.getByRole('heading', { name: heading }).closest('section')!;

describe('the section bar', () => {
  it('links each section it names, in order, leaves every section on the page and marks the first', () => {
    render(<Page />);
    expect(within(bar()).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Overview', '#section-overview'],
      ['Private details', '#section-private'],
      ['History', '#section-history'],
    ]);
    expect(sectionOf('Synthetic Person (SYN-1)').id).toBe('section-overview');
    expect(sectionOf('Private details').id).toBe('section-private');
    expect(sectionOf('Employment history').id).toBe('section-history');
    expect(screen.getByText('The record')).toBeTruthy();
    expect(screen.getByText('Shown on request')).toBeTruthy();
    expect(link('Overview').getAttribute('aria-current')).toBe('true');
    expect(link('History').getAttribute('aria-current')).toBeNull();
  });

  it('a section chosen is marked, brought into view and its heading takes the focus; the address is not changed', () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      render(<Page />);
      const followed = fireEvent.click(link('History'));
      expect(followed).toBe(false);
      expect(link('History').getAttribute('aria-current')).toBe('true');
      expect(link('Overview').getAttribute('aria-current')).toBeNull();
      expect(scrolled).toEqual([sectionOf('Employment history')]);
      const heading = screen.getByRole('heading', { name: 'Employment history' });
      expect(document.activeElement).toBe(heading);
      expect(heading.getAttribute('tabindex')).toBe('-1');
      // A section whose title is shown only to assistive technology is found the same way.
      fireEvent.click(link('Private details'));
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Private details' }));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('marks the first section in the band under the bar as the page scrolls', () => {
    type Notify = (entries: { target: Element; isIntersecting: boolean }[]) => void;
    const observers: { notify: Notify; margin: string; observed: Element[] }[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observed: Element[] = [];
        constructor(notify: Notify, options: { rootMargin: string }) {
          observers.push({ notify, margin: options.rootMargin, observed: this.observed });
        }
        observe(el: Element) {
          this.observed.push(el);
        }
        disconnect() {}
      },
    );
    render(<Page />);
    // The band under the bar to a little under half the screen, and everything in sight under the bar.
    expect(observers.map((o) => o.margin)).toEqual(['-8px 0px -55% 0px', '-8px 0px 0px 0px']);
    const band = observers[0]!;
    expect(band.observed).toEqual([sectionOf('Synthetic Person (SYN-1)'), sectionOf('Private details'), sectionOf('Employment history')]);
    act(() => band.notify([{ target: sectionOf('Synthetic Person (SYN-1)'), isIntersecting: false }, { target: sectionOf('Private details'), isIntersecting: true }, { target: sectionOf('Employment history'), isIntersecting: true }]));
    expect(link('Private details').getAttribute('aria-current')).toBe('true');
    act(() => band.notify([{ target: sectionOf('Private details'), isIntersecting: false }]));
    expect(link('History').getAttribute('aria-current')).toBe('true');
  });

  it('a section chosen stays marked while the page moves to it', () => {
    type Notify = (entries: { target: Element; isIntersecting: boolean }[]) => void;
    const notifies: Notify[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(notify: Notify) {
          notifies.push(notify);
        }
        observe() {}
        disconnect() {}
      },
    );
    render(<Page />);
    fireEvent.click(link('History'));
    // Sections passing through the band on the way do not take the mark.
    act(() => notifies[0]!([{ target: sectionOf('Private details'), isIntersecting: true }]));
    expect(link('History').getAttribute('aria-current')).toBe('true');
  });

  it('a page of one section has no bar', () => {
    render(<Page sections={SECTIONS.slice(0, 1)} />);
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});

describe('the header card', () => {
  it('shows the initials for a photo, the name, the code with the designation, the status and the facts, each with its words', () => {
    render(
      <ProfileHeader
        name="Synthetic Person"
        subtitle={profileSubtitle('SYN-1', 'Developer', 'Fixed term')}
        status="ACTIVE_PROBATION"
        facts={[...placeFact('Engineering', 'Head office'), { icon: 'calendar', text: 'Joined 1 Feb 2026', title: 'Date joined' }]}
      />,
    );
    expect(screen.getByText('SP').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('Synthetic Person')).toBeTruthy();
    expect(screen.getByText('SYN-1 · Developer')).toBeTruthy();
    expect(screen.getByText('on probation')).toBeTruthy();
    expect(screen.getByText('Engineering · Head office').getAttribute('title')).toBe('Department and location');
    expect(screen.getByText('Joined 1 Feb 2026').getAttribute('title')).toBe('Date joined');
    // No value stands alone, so the record's own facts below stay the only exact match for it.
    expect(screen.queryByText('SYN-1')).toBeNull();
    expect(screen.queryByText('Engineering')).toBeNull();
  });

  it('words the code beside what is known, and the initials of any name', () => {
    expect(profileSubtitle('SYN-1', null, 'Fixed term')).toBe('SYN-1 · Fixed term');
    expect(profileSubtitle('SYN-1', '', null)).toBe('Employee code SYN-1');
    expect(initialsOf('Synthetic')).toBe('S');
    expect(initialsOf('asha synthetic-person')).toBe('AS');
    expect(initialsOf('  ')).toBe('?');
    expect(placeFact(null, null)).toEqual([]);
    expect(placeFact('Engineering', null)).toEqual([{ icon: 'building', text: 'Works in Engineering', title: 'Department' }]);
    expect(placeFact(null, 'Head office')).toEqual([{ icon: 'mapPin', text: 'Based at Head office', title: 'Location' }]);
  });
});
