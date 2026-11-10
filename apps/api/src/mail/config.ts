// The email channel's settings, read once when the worker starts (FR-085; DF12 "Email may be enabled ... after actual service
// configuration and safe recipient tests"). With no SMTP setting at all the channel is OFF: nothing is sent, and every email notice
// the worker meets is settled SUPPRESSED with EMAIL_NOT_CONFIGURED, so the delivery log says why. A partial or unsafe configuration
// stops the worker at start-up instead of failing quietly later.
//
//   SMTP_HOST           the submission server; setting it turns the channel on, and then SMTP_FROM and APP_PUBLIC_URL are required
//   SMTP_PORT           default 587 (starttls), 465 (tls) or 25 (none)
//   SMTP_SECURITY       starttls (default) | tls | none; none is refused in production, and TLS is never given up for clear text
//   SMTP_USER           the account to sign in as, with SMTP_PASSWORD_FILE; both or neither
//   SMTP_PASSWORD_FILE  the path of a file holding the password (read here, once). A password in the environment itself
//                       (SMTP_PASSWORD) is refused, so it never shows in a process listing or a unit file
//   SMTP_FROM           the sender address (a plain address)
//   SMTP_TIMEOUT_MS     how long one SMTP step may wait (default 30000)
//   APP_PUBLIC_URL      the application's address, the only link an email carries (https in production)
//   EMAIL_TEST_RECIPIENTS  optional, for DF12's "safe recipient tests": comma-separated addresses or @domains; when set, only
//                       those receive email and every other recipient's notice is SUPPRESSED (RECIPIENT_NOT_IN_TEST_LIST)
//   EMAIL_PER_TICK, EMAIL_SEND_LEASE_MS, EMAIL_PAUSE_AFTER_ERRORS  worker limits (starting values, not measured, G4)
// The password is kept only inside the sender's closure: it is not a field of anything returned here, so no log of the settings
// can contain it.
import { readFileSync } from 'node:fs';
import { isMailAddress, type MailSender, type SmtpSecurity, smtpSender } from './smtp.js';

export interface EmailChannelSettings {
  /** The link every email carries (APP_PUBLIC_URL, without a trailing slash). */
  appUrl: string;
  /** The domain of the sender address, used in Message-IDs. */
  fromDomain: string;
  /** Emails one worker sends per tick (EMAIL_PER_TICK). */
  perPass: number;
  /**
   * How long a claimed send may stay unrecorded before it is settled FAILED with OUTCOME_UNKNOWN (EMAIL_SEND_LEASE_MS): its worker
   * died mid-send, and the message may have gone, so it is never sent again. Longer than a send can take (eight SMTP steps).
   */
  leaseMs: number;
  /** A pass stops after this many failed sends in a row, so a server that is down is not asked once per waiting email. */
  pauseAfterErrors: number;
  /** EMAIL_TEST_RECIPIENTS: lower-case addresses and @domains; null when every recipient may receive email. */
  testRecipients: readonly string[] | null;
}

export type EmailChannel =
  | { state: 'ON'; sender: MailSender; settings: EmailChannelSettings; /** For the start-up log: host, port, security, sender; never the account or password. */ summary: string }
  | { state: 'OFF'; reason: 'SMTP_NOT_CONFIGURED' };

const SMTP_KEYS = ['SMTP_PORT', 'SMTP_SECURITY', 'SMTP_USER', 'SMTP_PASSWORD_FILE', 'SMTP_FROM', 'SMTP_TIMEOUT_MS'] as const;

const positive = (env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number => {
  const v = env[name]?.trim();
  if (!v) return fallback;
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > max) throw new Error(`${name} must be a whole number from 1 to ${max}`);
  return Number(v);
};

export function emailChannelFromEnv(env: NodeJS.ProcessEnv = process.env, readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')): EmailChannel {
  const value = (name: string) => env[name]?.trim() || undefined;
  if (env.SMTP_PASSWORD !== undefined) throw new Error('SMTP_PASSWORD is not read: put the password in a file readable by the worker only and name that file in SMTP_PASSWORD_FILE');
  const host = value('SMTP_HOST');
  if (!host) {
    const stray = SMTP_KEYS.filter((k) => value(k) !== undefined);
    if (stray.length > 0) throw new Error(`${stray.join(', ')} set without SMTP_HOST: set SMTP_HOST to turn the email channel on, or remove them`);
    return { state: 'OFF', reason: 'SMTP_NOT_CONFIGURED' };
  }
  const production = env.NODE_ENV === 'production';
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host) && !/^\[[0-9A-Fa-f:.]+\]$/.test(host)) throw new Error('SMTP_HOST must be a host name or address');
  const security = (value('SMTP_SECURITY') ?? 'starttls').toLowerCase() as SmtpSecurity;
  if (!['starttls', 'tls', 'none'].includes(security)) throw new Error('SMTP_SECURITY must be starttls, tls or none');
  if (security === 'none' && production) throw new Error('SMTP_SECURITY=none is refused in production: email is sent over TLS only');
  const port = positive(env, 'SMTP_PORT', security === 'tls' ? 465 : security === 'starttls' ? 587 : 25, 65_535);
  const timeoutMs = positive(env, 'SMTP_TIMEOUT_MS', 30_000, 300_000);

  const from = value('SMTP_FROM')?.toLowerCase();
  if (!from || !isMailAddress(from)) throw new Error('SMTP_FROM must be set to a plain sender address when SMTP_HOST is set');

  const rawUrl = value('APP_PUBLIC_URL');
  if (!rawUrl) throw new Error('APP_PUBLIC_URL must be set when SMTP_HOST is set: it is the link every email carries');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('APP_PUBLIC_URL must be an absolute URL');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('APP_PUBLIC_URL must be a plain http(s) address');
  if (production && url.protocol !== 'https:') throw new Error('APP_PUBLIC_URL must use https in production');

  const user = value('SMTP_USER');
  const passwordFile = value('SMTP_PASSWORD_FILE');
  if (Boolean(user) !== Boolean(passwordFile)) throw new Error('SMTP_USER and SMTP_PASSWORD_FILE go together: set both or neither');
  let password: string | undefined;
  if (passwordFile) {
    let content: string;
    try {
      content = readFile(passwordFile);
    } catch {
      throw new Error('SMTP_PASSWORD_FILE could not be read by the worker');
    }
    password = content.replace(/(\r?\n)+$/, '');
    if (password === '' || /[\r\n]/.test(password)) throw new Error('SMTP_PASSWORD_FILE must hold the password on one line');
  }

  const testList = value('EMAIL_TEST_RECIPIENTS');
  const testRecipients = testList
    ? testList
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : null;
  if (testRecipients && testRecipients.some((r) => !(isMailAddress(r) || /^@[a-z0-9.-]+\.[a-z]{2,}$/.test(r)))) throw new Error('EMAIL_TEST_RECIPIENTS must list addresses or @domains');

  const secret = password;
  const sender = smtpSender({ host, port, security, user, password: secret === undefined ? undefined : () => secret, from, timeoutMs });
  return {
    state: 'ON',
    sender,
    settings: {
      appUrl: url.toString().replace(/\/+$/, ''),
      fromDomain: from.split('@')[1]!,
      perPass: positive(env, 'EMAIL_PER_TICK', 100, 10_000),
      leaseMs: positive(env, 'EMAIL_SEND_LEASE_MS', Math.max(600_000, timeoutMs * 10), 86_400_000),
      pauseAfterErrors: positive(env, 'EMAIL_PAUSE_AFTER_ERRORS', 5, 1_000),
      testRecipients: testRecipients && testRecipients.length > 0 ? testRecipients : null,
    },
    summary: `${host}:${port} ${security}${user ? ' with sign-in' : ''}, from ${from}${testRecipients ? ', test recipients only' : ''}`,
  };
}
