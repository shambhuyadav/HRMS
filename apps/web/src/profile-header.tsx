// A person's record opens with a header card (owner's request of 20 Nov 2026: "a header card with photo and key facts"). The
// system keeps no photo of anyone, so the card shows the person's initials in a large circle, as the top bar does for the account.
// It shows only what the page has already read, and adds no request of its own.
//
// Every value is written as one piece of text together with its words ("SYN-1 · Developer", "Joined 1 Feb 2026"), never on its own:
// the same value stays exactly once on the page as a plain value (the record's facts below), so a search for it finds that one.

import { Icon, type IconName } from './icons';
import { StateBadge } from './ui';

/** The card: the initials beside the name and facts; on a phone a little tighter, the initials at the top. */
const CARD =
  'flex items-center gap-[1rem_1.25rem] rounded-xl border border-border bg-card px-6 py-[1.35rem] shadow-[var(--shadow-xs)] phone:items-start phone:gap-[0.85rem] phone:px-4 phone:py-[1.05rem]';
/** The initials stand in for a photo (the system keeps none): the top bar's avatar, larger, in the information tint. */
const AVATAR =
  'grid size-[64px] flex-none place-items-center rounded-full bg-[var(--info-soft)] text-[1.35rem] font-[650] tracking-[0.02em] text-[var(--info)] shadow-[inset_0_0_0_1px_var(--info-edge)] select-none phone:size-[48px] phone:text-[1.05rem]';
const NAME = 'm-0 text-[1.3rem] leading-[1.25] font-[650] tracking-[-0.015em] text-foreground [overflow-wrap:anywhere] phone:text-[1.12rem]';
const SUBTITLE = 'm-0 text-[0.9rem] font-medium text-[var(--body)] [overflow-wrap:anywhere]';
/** The facts side by side, wrapping; one under another on a phone. */
const FACTS = 'm-0 mt-[0.45rem] flex list-none flex-wrap gap-[0.35rem_1.35rem] p-0 text-[0.84rem] text-muted-foreground phone:flex-col phone:gap-[0.3rem]';
const FACT = 'inline-flex max-w-full items-center gap-[0.4rem] [overflow-wrap:anywhere]';

/** Up to two initials of a name: "Synthetic Person" reads "SP". */
export const initialsOf = (name: string) =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

export interface ProfileFact {
  icon: IconName;
  /** The fact with its words, as one piece of text. */
  text: string;
  /** What the fact is, shown on pointing at it. */
  title: string;
}

/** The line under the name: the code with the designation, or with the employment type when no designation is known. */
export function profileSubtitle(code: string, designation?: string | null, employmentType?: string | null): string {
  const beside = designation || employmentType;
  return beside ? `${code} · ${beside}` : `Employee code ${code}`;
}

/** The place of work: department and location together, or whichever is known, in words. */
export function placeFact(department?: string | null, location?: string | null): ProfileFact[] {
  if (department && location) return [{ icon: 'building', text: `${department} · ${location}`, title: 'Department and location' }];
  if (department) return [{ icon: 'building', text: `Works in ${department}`, title: 'Department' }];
  if (location) return [{ icon: 'mapPin', text: `Based at ${location}`, title: 'Location' }];
  return [];
}

export function ProfileHeader({ name, subtitle, status, facts }: { name: string; subtitle: string; status?: string | null | undefined; facts: readonly ProfileFact[] }) {
  return (
    <div data-slot="profile-header" className={CARD}>
      <span className={AVATAR} aria-hidden="true">
        {initialsOf(name)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[0.2rem]">
        <div className="flex flex-wrap items-center gap-[0.3rem_0.65rem]">
          <p data-slot="profile-name" className={NAME}>
            {name}
          </p>
          {status && <StateBadge state={status} />}
        </div>
        <p className={SUBTITLE}>{subtitle}</p>
        {facts.length > 0 && (
          <ul className={FACTS}>
            {facts.map((f) => (
              <li key={f.title} title={f.title} className={FACT}>
                <Icon name={f.icon} size={15} className="text-[var(--faint)]" />
                {f.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
