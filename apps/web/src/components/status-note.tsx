// How something went, said where it happened: a success, a piece of information, a warning or a problem, with its mark. One note
// for what the screens had each drawn for themselves (LinkedNote, Done, Outcome, Succeeded, CountNote, RunEnded …; cleanup of
// 22 Nov 2026). Unlike Notice (ui.tsx), whose words are plain text and whose role follows from its outcome, a StatusNote's words may
// hold a link or other markup, and its role is given by the screen: `status` or `alert` where the line is announced, none where it
// is only shown (the line it replaced had none).
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert } from '@/components/ui/alert';

/** Each tone's Alert look and mark. */
const TONES = {
  success: { variant: 'success', Mark: CircleCheckIcon },
  info: { variant: 'info', Mark: InfoIcon },
  warning: { variant: 'warning', Mark: TriangleAlertIcon },
  error: { variant: 'destructive', Mark: CircleAlertIcon },
} as const;

export type StatusTone = keyof typeof TONES;

export function StatusNote({
  tone,
  role,
  id,
  className,
  children,
}: {
  tone: StatusTone;
  /** `status` (announced politely) or `alert` (announced at once); leave it out for a line that is shown but not announced. */
  role?: 'status' | 'alert';
  /** For a field or button that names the note in its aria-describedby. */
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const { variant, Mark } = TONES[tone];
  // The role is always passed on: when it is undefined it replaces the Alert's own "alert", so the line has no role.
  return (
    <Alert asChild variant={variant} role={role}>
      <p id={id} className={className}>
        <Mark aria-hidden="true" />
        {/* An Alert lays its children out as a grid: one wrapper keeps the words, and any link in them, in one sentence. */}
        <span>{children}</span>
      </p>
    </Alert>
  );
}

/** A form sent with nothing different from the record: said as information, not as an outcome. */
export function NothingChanged() {
  return (
    <StatusNote tone="info" role="status">
      Nothing changed.
    </StatusNote>
  );
}
