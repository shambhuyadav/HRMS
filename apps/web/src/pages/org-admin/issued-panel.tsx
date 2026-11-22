// The temporary password the server issued for a new account or a password reset, shown this once.
import { useEffect, useId, useRef, useState } from 'react';
import { ConfirmBox } from '@/components/confirm-box';
import { ButtonRow } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';

/**
 * A temporary password the server issued. It is held only in the page's state until Done, never in a query cache, and the
 * mutation that brought it is dropped as soon as its form closes (gcTime 0).
 */
export interface Issued {
  kind: 'created' | 'reset';
  accountKey: string;
  temporaryPassword: string | null;
  sessionsRevoked?: number;
}

/** The password itself: large monospaced characters on the card colour, selected whole by one click, breaking anywhere on a phone. */
const SECRET = 'rounded-md border border-[var(--line-strong)] bg-card px-3 py-1.5 font-mono text-[1.05rem] tracking-[0.04em] text-foreground break-all select-all';

const signedOutText = (sessions = 0) => (sessions === 0 ? 'They had no open session.' : `They are signed out of ${sessions} ${sessions === 1 ? 'session' : 'sessions'}.`);

function panelTitle(issued: Issued): string {
  if (issued.temporaryPassword !== null) return `Temporary password for ${issued.accountKey}`;
  if (issued.kind === 'created') return `Account created for ${issued.accountKey}`;
  return `Password reset for ${issued.accountKey}`;
}

/** The temporary password, shown this once. Focus moves to it, so the page scrolls to it wherever the action was taken. */
export function IssuedPanel({ issued, linkPrefilled, onDone }: { issued: Issued; linkPrefilled: boolean; onDone: () => void }) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [copy, setCopy] = useState<'copied' | 'unavailable' | null>(null);
  useEffect(() => {
    setCopy(null);
    heading.current?.focus();
  }, [issued]);
  const password = issued.temporaryPassword;
  const copyPassword = () => {
    const clipboard = (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    if (password === null || typeof clipboard?.writeText !== 'function') {
      setCopy('unavailable');
      return;
    }
    try {
      clipboard.writeText(password).then(
        () => setCopy('copied'),
        () => setCopy('unavailable'),
      );
    } catch {
      setCopy('unavailable');
    }
  };
  return (
    <ConfirmBox role="status" aria-labelledby={titleId}>
      <h3 id={titleId} ref={heading} tabIndex={-1} className="m-0">
        {panelTitle(issued)}
      </h3>
      <p>{issued.kind === 'created' ? 'The account is created.' : `The password is reset. ${signedOutText(issued.sessionsRevoked)}`}</p>
      {password !== null ? (
        <>
          <ButtonRow>
            <code className={SECRET}>{password}</code>
            <Button type="button" variant="outline" onClick={copyPassword}>
              Copy
            </Button>
            {copy === 'copied' && <span className="font-medium text-[var(--good)]">Copied.</span>}
            {copy === 'unavailable' && <Hint as="span">This browser did not allow copying: select the password and copy it by hand.</Hint>}
          </ButtonRow>
          <p>Give it to the person privately. It works once: at their first sign-in they choose their own password and set up their authenticator app. It is not shown again.</p>
        </>
      ) : (
        <p>This server has no sign-in provider, so there is no temporary password: the account signs in through the development sign-in.</p>
      )}
      {linkPrefilled && <p>To connect the account to an employee, use "Link an account to an employee" below: its account key is filled in.</p>}
      <ButtonRow>
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </ButtonRow>
    </ConfirmBox>
  );
}
