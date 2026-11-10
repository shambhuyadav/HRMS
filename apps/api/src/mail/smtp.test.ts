// The email channel's SMTP client and settings (FR-085; DF12; BR-044), against an in-process fake server: no real mail, no network.
// Synthetic data only (example.invalid addresses, a synthetic password).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emailChannelFromEnv } from './config.js';
import { bodyOf, closedPort, type FakeSmtp, headersOf, startFakeSmtp } from './fake-smtp.fixtures.js';
import { formatMessage, type MailMessage, smtpSender } from './smtp.js';

let smtp: FakeSmtp;
let dir: string;
const PASSWORD = 'synthetic-Pa55word-not-real';
const message = (overrides: Partial<MailMessage> = {}): MailMessage => ({
  to: 'person@example.invalid',
  subject: 'Leave request approved',
  text: 'There is a new notice for you in HRMS: Leave request approved.\n\nSign in to HRMS to see the details: https://hr.example.invalid',
  messageId: '11111111-2222-4333-8444-555555555555@example.invalid',
  ...overrides,
});
const sender = (extra: Partial<Parameters<typeof smtpSender>[0]> = {}) =>
  smtpSender({ host: '127.0.0.1', port: smtp.port, security: 'none', from: 'hrms@example.invalid', timeoutMs: 2_000, ...extra });

beforeAll(async () => {
  smtp = await startFakeSmtp();
  dir = mkdtempSync(join(tmpdir(), 'hrms-smtp-test-'));
});

afterAll(async () => {
  await smtp?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => smtp.reset());

describe('SMTP client (FR-085)', () => {
  it('FR-085: sends one plain-text message with the envelope, headers and body it was given', async () => {
    const result = await sender().send(message());
    expect(result).toEqual({ outcome: 'SENT', reference: '2.0.0 Ok: queued as FAKE0001' });
    expect(smtp.messages).toHaveLength(1);
    const [m] = smtp.messages;
    expect(m!.from).toBe('hrms@example.invalid');
    expect(m!.to).toEqual(['person@example.invalid']);
    const headers = headersOf(m!);
    expect(headers).toEqual(
      expect.arrayContaining([
        'From: hrms@example.invalid',
        'To: person@example.invalid',
        'Subject: Leave request approved',
        'Message-ID: <11111111-2222-4333-8444-555555555555@example.invalid>',
        'Content-Type: text/plain; charset=utf-8',
        'Auto-Submitted: auto-generated',
      ]),
    );
    expect(bodyOf(m!)).toBe(message().text.replace(/\n/g, '\r\n'));
    expect(smtp.sessions[0]!.slice(0, 4)).toEqual(['EHLO example.invalid', 'MAIL FROM:<hrms@example.invalid>', 'RCPT TO:<person@example.invalid>', 'DATA']);
  });

  it('FR-085: a 4xx reply is transient, a 5xx refusal is permanent, and a connection lost after the message is an unknown outcome', async () => {
    smtp.behaviour.dataReply = '451 4.3.0 Try again later';
    expect(await sender().send(message())).toEqual({ outcome: 'TRANSIENT', code: 'SMTP_MESSAGE_451' });
    smtp.reset();
    smtp.behaviour.rcptReply = '550 5.1.1 No such user';
    expect(await sender().send(message())).toEqual({ outcome: 'PERMANENT', code: 'SMTP_RCPT_550' });
    expect(smtp.messages).toHaveLength(0);
    smtp.reset();
    smtp.behaviour.dropAfterMessage = true;
    expect(await sender().send(message())).toEqual({ outcome: 'UNKNOWN', code: 'SMTP_OUTCOME_UNKNOWN' });
    smtp.reset();
    smtp.behaviour.dropAfterGreeting = true;
    expect(await sender().send(message())).toEqual({ outcome: 'TRANSIENT', code: 'SMTP_CONNECTION_LOST' });
    const nobody = await closedPort();
    expect(await smtpSender({ host: '127.0.0.1', port: nobody, security: 'none', from: 'hrms@example.invalid', timeoutMs: 2_000 }).send(message())).toEqual({
      outcome: 'TRANSIENT',
      code: 'SMTP_CONNECTION_FAILED',
    });
  });

  it('FR-085: with STARTTLS configured it never continues in clear text: nothing is said after a missing or refused STARTTLS', async () => {
    const tls = sender({ security: 'starttls', user: 'hrms', password: () => PASSWORD });
    expect(await tls.send(message())).toEqual({ outcome: 'TRANSIENT', code: 'SMTP_STARTTLS_UNAVAILABLE' });
    expect(smtp.sessions[0]).toEqual(['EHLO example.invalid']);
    smtp.reset();
    smtp.behaviour.advertiseStartTls = true;
    expect(await tls.send(message())).toEqual({ outcome: 'TRANSIENT', code: 'SMTP_STARTTLS_454' });
    expect(smtp.sessions[0]).toEqual(['EHLO example.invalid', 'STARTTLS']);
    expect(smtp.messages).toHaveLength(0);
    expect(JSON.stringify(smtp.sessions)).not.toContain(Buffer.from(PASSWORD).toString('base64'));
  });

  it('FR-085: signs in with the password only inside the AUTH exchange, by PLAIN, and a refused sign-in sends nothing', async () => {
    smtp.behaviour.credentials = { user: 'hrms', password: PASSWORD };
    expect((await sender({ user: 'hrms', password: () => PASSWORD }).send(message())).outcome).toBe('SENT');
    expect(smtp.messages[0]!.auth).toEqual({ user: 'hrms', password: PASSWORD });
    expect(smtp.sessions[0]!.filter((l) => l.startsWith('AUTH'))).toHaveLength(1);
    const wrong = await sender({ user: 'hrms', password: () => 'not-the-password' }).send(message());
    expect(wrong).toEqual({ outcome: 'PERMANENT', code: 'SMTP_AUTH_535' });
    expect(smtp.messages).toHaveLength(1);
    expect(JSON.stringify(wrong)).not.toContain('not-the-password');
  });

  it('FR-085: a header cannot be injected through the subject, and the body is dot-stuffed and base64 encoded', () => {
    const raw = formatMessage('hrms@example.invalid', message({ subject: 'Approved\r\nBcc: someone@example.invalid', text: '.\nline' }), new Date('2026-11-10T09:00:00Z'));
    const head = raw.split('\r\n\r\n')[0]!.split('\r\n');
    expect(head.filter((l) => /^Bcc:/i.test(l))).toEqual([]);
    expect(head).toContain('Subject: Approved Bcc: someone@example.invalid');
    expect(head).toContain('Date: Tue, 10 Nov 2026 09:00:00 +0000');
    expect(raw.split('\r\n').some((l) => l.startsWith('.') && !l.startsWith('..'))).toBe(false);
    expect(formatMessage('hrms@example.invalid', message({ subject: 'Café update' })).split('\r\n')).toContain(`Subject: =?UTF-8?B?${Buffer.from('Café update').toString('base64')}?=`);
  });

  it('FR-085: refuses a recipient that is not a plain address, without connecting', async () => {
    expect(await sender().send(message({ to: 'person@example.invalid>\r\nRCPT TO:<other@example.invalid' }))).toEqual({ outcome: 'PERMANENT', code: 'INVALID_RECIPIENT_ADDRESS' });
    expect(smtp.sessions).toHaveLength(0);
  });
});

describe('email channel settings (FR-085, DF12)', () => {
  const passwordFile = () => {
    const path = join(dir, 'smtp-password');
    writeFileSync(path, `${PASSWORD}\n`);
    return path;
  };
  const base = (): NodeJS.ProcessEnv => ({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURITY: 'none', SMTP_FROM: 'HRMS@example.invalid', APP_PUBLIC_URL: 'https://hr.example.invalid/' });

  it('FR-085: with no SMTP setting the channel is off, without an error', () => {
    expect(emailChannelFromEnv({})).toEqual({ state: 'OFF', reason: 'SMTP_NOT_CONFIGURED' });
    expect(emailChannelFromEnv({ APP_PUBLIC_URL: 'https://hr.example.invalid', NODE_ENV: 'production' })).toEqual({ state: 'OFF', reason: 'SMTP_NOT_CONFIGURED' });
  });

  it('FR-085: a partial or unsafe configuration stops the worker at start-up', () => {
    expect(() => emailChannelFromEnv({ SMTP_FROM: 'hrms@example.invalid' })).toThrow(/SMTP_FROM set without SMTP_HOST/);
    expect(() => emailChannelFromEnv({ ...base(), SMTP_FROM: undefined })).toThrow(/SMTP_FROM/);
    expect(() => emailChannelFromEnv({ ...base(), APP_PUBLIC_URL: undefined })).toThrow(/APP_PUBLIC_URL/);
    expect(() => emailChannelFromEnv({ ...base(), SMTP_SECURITY: 'ssl' })).toThrow(/SMTP_SECURITY/);
    expect(() => emailChannelFromEnv({ ...base(), NODE_ENV: 'production' })).toThrow(/none is refused in production/);
    expect(() => emailChannelFromEnv({ ...base(), SMTP_SECURITY: 'starttls', NODE_ENV: 'production', APP_PUBLIC_URL: 'http://hr.example.invalid' })).toThrow(/https/);
    expect(() => emailChannelFromEnv({ ...base(), SMTP_USER: 'hrms' })).toThrow(/both or neither/);
    expect(() => emailChannelFromEnv({ ...base(), SMTP_USER: 'hrms', SMTP_PASSWORD_FILE: join(dir, 'missing') })).toThrow(/could not be read/);
  });

  it('FR-085: refuses a password in the environment; reads it from SMTP_PASSWORD_FILE and never shows it', async () => {
    expect(() => emailChannelFromEnv({ ...base(), SMTP_PASSWORD: PASSWORD })).toThrow(/SMTP_PASSWORD_FILE/);
    let thrown = '';
    try {
      emailChannelFromEnv({ ...base(), SMTP_PASSWORD: PASSWORD });
    } catch (err) {
      thrown = (err as Error).message;
    }
    expect(thrown).not.toContain(PASSWORD);

    const channel = emailChannelFromEnv({ ...base(), SMTP_USER: 'hrms', SMTP_PASSWORD_FILE: passwordFile() });
    expect(channel.state).toBe('ON');
    if (channel.state !== 'ON') return;
    expect(channel.settings).toMatchObject({ appUrl: 'https://hr.example.invalid', fromDomain: 'example.invalid', testRecipients: null });
    expect(channel.summary).toBe(`127.0.0.1:${smtp.port} none with sign-in, from hrms@example.invalid`);
    // Nothing reachable from the channel's fields holds the password; only the AUTH exchange does.
    expect(JSON.stringify(channel)).not.toContain(PASSWORD);
    expect(JSON.stringify(channel.settings)).not.toContain(PASSWORD);
    smtp.behaviour.credentials = { user: 'hrms', password: PASSWORD };
    expect((await channel.sender.send(message())).outcome).toBe('SENT');
    expect(smtp.messages[0]!.auth?.password).toBe(PASSWORD);
  });

  it('FR-085: DF12 safe recipient tests: EMAIL_TEST_RECIPIENTS lists addresses and @domains', () => {
    const channel = emailChannelFromEnv({ ...base(), EMAIL_TEST_RECIPIENTS: 'Tester@Example.invalid, @qa.example.invalid' });
    expect(channel.state === 'ON' && channel.settings.testRecipients).toEqual(['tester@example.invalid', '@qa.example.invalid']);
    expect(() => emailChannelFromEnv({ ...base(), EMAIL_TEST_RECIPIENTS: 'not an address' })).toThrow(/EMAIL_TEST_RECIPIENTS/);
  });
});
