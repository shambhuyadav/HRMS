// DF03 "Rejected requests are terminal; a new request links to the rejected predecessor" (I-66): every own-request form offers a
// rejected request to be raised again, filled in from it. The link is the server's to check; this only saves the refusal. The
// leave, expense, asset, profile and attendance screens use these too.
import { Hint, HintLine } from '@/components/hint';
import { Button } from '@/components/ui/button';

const ENDED_STATES = ['REJECTED', 'WITHDRAWN', 'CANCELLED'];

/** The rejected requests in this list that a live request already follows, which cannot be raised again. */
export function followedRequests(items: readonly { state: string; predecessorRequestId?: string | null }[]): ReadonlySet<string> {
  return new Set(items.filter((i) => i.predecessorRequestId && !ENDED_STATES.includes(i.state)).map((i) => i.predecessorRequestId!));
}

/** A rejected request of `items` can be raised again by someone who may submit. */
export const canRaiseAgain = (r: { id: string; state: string }, followed: ReadonlySet<string>) => r.state === 'REJECTED' && !followed.has(r.id);

/** Above a form holding a rejected request's details: says what the new request will follow, and how to drop that. */
export function RaiseAgainNote({ onCancel }: { onCancel: () => void }) {
  return (
    <Hint role="status">
      This new request will be linked to your rejected request; the rejected one stays as it was.{' '}
      <Button type="button" variant="link" size="inline" onClick={onCancel}>
        Make it an unlinked request
      </Button>
    </Hint>
  );
}

/** On a request's row: what it follows. */
export function RaisedAgainHint({ predecessorRequestId }: { predecessorRequestId?: string | null | undefined }) {
  return predecessorRequestId ? <HintLine>Raised again after a rejected request</HintLine> : null;
}
