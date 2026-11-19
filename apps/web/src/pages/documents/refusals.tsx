// The documents API's refusals in plain words; any other error is shown as the API sent it.
import { ApiError } from '../../api';
import { ErrorNote } from '../../ui';
import { scanStateOf } from './shared';

// ---------------------------------------------------------------------------------------------------------
// The API's refusals in plain words; any other error is shown as the API sent it
// ---------------------------------------------------------------------------------------------------------
export type Words = Record<string, string | ((e: ApiError) => string)>;

export function wordsFor(error: unknown, words: Words): string | null {
  if (!(error instanceof ApiError)) return null;
  const w = words[error.code];
  return w === undefined ? null : typeof w === 'function' ? w(error) : w;
}

export function Refusal({ error, words }: { error: unknown; words: Words }) {
  if (!error) return null;
  const text = wordsFor(error, words);
  if (text === null) return <ErrorNote error={error} />;
  return (
    <div role="alert" className="error">
      {text}
      <div className="hint">{(error as ApiError).code}</div>
    </div>
  );
}

export const UPLOAD_WORDS: Words = {
  UNSUPPORTED_FILE: 'Only PDF, JPEG and PNG files are accepted.',
  FILE_SIZE: 'Files must be between 1 byte and 10 MB.',
  PAYLOAD_TOO_LARGE: 'The file is larger than 10 MB.',
};

export const DOWNLOAD_WORDS: Words = {
  FILE_NOT_RELEASED: (e) =>
    scanStateOf(e) === 'QUARANTINED' ? 'This version failed the safety check and can never be opened.' : 'This version is still being checked, so it cannot be opened yet. Try again shortly.',
  NOT_FOUND: 'This policy version is not available in the selected role’s company.',
  FORBIDDEN: 'The selected role cannot read company policies.',
};

export const PUBLISH_WORDS: Words = {
  ...UPLOAD_WORDS,
  POLICY_EXISTS: 'A policy with this code already exists. Publish a new version from that policy’s page instead.',
  EXPIRY_IN_PAST: 'This expiry date has already passed, and a new version cannot already be expired. Choose a later date or leave it empty.',
  FORBIDDEN:
    'The selected role cannot publish this policy. Company policies are published from an unrestricted company-scope assignment holding the policy duty; a confidential policy also needs the confidential policy grant.',
  INVALID_REQUEST: 'Check the code (an upper-case letter, then upper-case letters, digits or _; at most 40), the title and the file name (no / \\ < > : " | ? * characters).',
};

export const VERSION_WORDS: Words = {
  ...UPLOAD_WORDS,
  EXPIRY_IN_PAST: PUBLISH_WORDS.EXPIRY_IN_PAST!,
  STALE_VERSION: 'The policy changed since this page loaded it, so nothing was published. It has been reloaded: check it and publish again.',
  NOT_FOUND: 'This policy is not available in the selected role’s company.',
  FORBIDDEN: 'The selected role cannot publish policy versions: that needs the policy duty in an unrestricted company-scope assignment.',
  INVALID_REQUEST: 'The file name cannot contain / \\ < > : " | ? * or control characters, and a change note has at most 1000 characters.',
};

export const CHANGE_WORDS: Words = {
  STALE_VERSION: 'The policy changed since this page loaded it, so nothing was saved. It has been reloaded: check it and save again.',
  NOT_FOUND: 'This policy is not available in the selected role’s company.',
  FORBIDDEN:
    'The selected role cannot make this change. Changing a policy needs the policy duty in an unrestricted company-scope assignment; making a policy confidential, or a confidential one operational, also needs the confidential policy grant.',
  INVALID_REQUEST: 'A title has 1 to 200 characters and cannot be blank.',
};

