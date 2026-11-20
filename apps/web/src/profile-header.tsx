// A person's record opens with a header card (owner's request of 20 Nov 2026: "a header card with photo and key facts"). The
// system keeps no photo of anyone, so the card shows the person's initials in a large circle, as the top bar does for the account.
// It shows only what the page has already read, and adds no request of its own.
//
// Every value is written as one piece of text together with its words ("SYN-1 · Developer", "Joined 1 Feb 2026"), never on its own:
// the same value stays exactly once on the page as a plain value (the record's facts below), so a search for it finds that one.

import { Icon, type IconName } from './icons';
import { StateBadge } from './ui';
import './styles/profile.css';

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
    <div className="profile-card">
      <span className="profile-avatar" aria-hidden="true">
        {initialsOf(name)}
      </span>
      <div className="profile-main">
        <div className="profile-title">
          <p className="profile-name">{name}</p>
          {status && <StateBadge state={status} />}
        </div>
        <p className="profile-sub">{subtitle}</p>
        {facts.length > 0 && (
          <ul className="profile-facts">
            {facts.map((f) => (
              <li key={f.title} title={f.title}>
                <Icon name={f.icon} size={15} />
                {f.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
