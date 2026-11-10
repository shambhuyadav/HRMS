// A minimal SMTP submission client for the email notification channel (FR-085; DF12). It sends one plain-text message per
// connection: greeting, EHLO, STARTTLS (or implicit TLS), AUTH, MAIL FROM, RCPT TO, DATA, QUIT. Written here rather than taken
// from a library because the channel needs to know exactly how far a failed send got, which decides whether it may be retried:
//   TRANSIENT  nothing was handed over (a refused or broken connection, a timeout or a 4xx reply before the message ended, or
//              a 4xx reply to it): the worker may try again after its backoff.
//   PERMANENT  a 5xx reply: the server refused the message for good; trying again would be refused the same way.
//   UNKNOWN    the connection broke or timed out after the message's final "." was written and before the server answered: it may
//              or may not have been accepted. The worker never sends it again (at most once; DF12 "no promise of exactly-once
//              external service delivery without provider support").
// It never sends in clear text when TLS is configured: STARTTLS that the server does not offer, or a certificate that does not
// verify, fails the send before anything else is said. The password is only ever written base64-encoded inside the AUTH exchange,
// never logged, and never part of an error or a result. No secret, address or message text appears in a failure code.
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

export type SmtpSecurity = 'starttls' | 'tls' | 'none';

export interface SmtpOptions {
  host: string;
  port: number;
  security: SmtpSecurity;
  /** The account to sign in as; with no user, no AUTH is attempted. */
  user?: string | undefined;
  /** The account's password, read when needed (from the file named by SMTP_PASSWORD_FILE): never stored on this object's fields. */
  password?: (() => string) | undefined;
  /** The envelope and header sender. */
  from: string;
  /** How long one step may wait for the server. */
  timeoutMs: number;
  /** Extra TLS options for tests only (a test certificate authority); production uses the system's trusted roots. */
  tlsOptions?: { ca?: string | Buffer } | undefined;
}

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text; lines end with \n. */
  text: string;
  /** The Message-ID without angle brackets (unique per notification, so a receiving system can see a repeat). */
  messageId: string;
}

export type SendResult = { outcome: 'SENT'; reference: string | null } | { outcome: 'TRANSIENT' | 'PERMANENT' | 'UNKNOWN'; code: string };

export interface MailSender {
  send(message: MailMessage): Promise<SendResult>;
}

/** A conservative address check: what the channel sends to or from (no display names, comments, quotes or line breaks). */
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const isMailAddress = (value: string): boolean => value.length <= 254 && ADDRESS.test(value) && !value.startsWith('.') && !value.includes('..');

type Phase = 'CONNECT' | 'GREETING' | 'EHLO' | 'STARTTLS' | 'AUTH' | 'MAIL' | 'RCPT' | 'DATA' | 'MESSAGE';

class SmtpIoError extends Error {
  constructor(readonly kind: 'TIMEOUT' | 'CLOSED' | 'TLS' | 'CONNECT') {
    super(`SMTP ${kind}`);
    this.name = 'SmtpIoError';
  }
}

class SmtpReplyError extends Error {
  constructor(
    readonly phase: Phase,
    readonly code: number,
  ) {
    super(`SMTP ${phase} ${code}`);
    this.name = 'SmtpReplyError';
  }
}

class SmtpRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SmtpRefusal';
  }
}

interface Reply {
  code: number;
  lines: string[];
}

/** Reads SMTP replies (one or more lines, the last with a space after the code) from a socket, which may change at STARTTLS. */
class Connection {
  private buffer = '';
  private replies: Reply[] = [];
  private partial: string[] = [];
  private waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;
  private socket!: Socket | TLSSocket;

  constructor(
    socket: Socket | TLSSocket,
    private readonly timeoutMs: number,
  ) {
    this.attach(socket);
  }

  attach(socket: Socket | TLSSocket) {
    this.socket = socket;
    socket.setTimeout(this.timeoutMs, () => this.fail(new SmtpIoError('TIMEOUT')));
    socket.on('data', (chunk: Buffer) => this.receive(chunk.toString('latin1')));
    socket.on('error', (err: Error & { code?: string }) => this.fail(new SmtpIoError(/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(err.code ?? '') ? 'TLS' : 'CLOSED')));
    socket.on('close', () => this.fail(new SmtpIoError('CLOSED')));
  }

  /** Hands the socket over (STARTTLS): this connection stops listening to it. */
  detach(): Socket | TLSSocket {
    const s = this.socket;
    s.removeAllListeners('data');
    s.removeAllListeners('error');
    s.removeAllListeners('close');
    s.removeAllListeners('timeout');
    s.setTimeout(0);
    s.on('error', () => undefined); // the TLS socket that wraps it reports its failures
    return s;
  }

  private receive(text: string) {
    this.buffer += text;
    let at: number;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at).replace(/\r$/, '');
      this.buffer = this.buffer.slice(at + 1);
      const m = /^(\d{3})(?:([ -])(.*))?$/.exec(line);
      if (!m) {
        this.fail(new SmtpIoError('CLOSED'));
        return;
      }
      this.partial.push(m[3] ?? '');
      if (m[2] !== '-') {
        const reply = { code: Number(m[1]), lines: this.partial };
        this.partial = [];
        if (this.waiting) {
          const w = this.waiting;
          this.waiting = null;
          w.resolve(reply);
        } else this.replies.push(reply);
      }
    }
    if (this.buffer.length > 65_536) this.fail(new SmtpIoError('CLOSED'));
  }

  private fail(err: Error) {
    if (this.failure) return;
    this.failure = err;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.reject(err);
    }
  }

  read(): Promise<Reply> {
    const ready = this.replies.shift();
    if (ready) return Promise.resolve(ready);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  write(text: string): void {
    if (this.failure) throw this.failure;
    this.socket.write(text, 'utf8');
  }

  close() {
    this.failure ??= new SmtpIoError('CLOSED');
    this.socket.destroy();
  }
}

function open(options: SmtpOptions): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket =
      options.security === 'tls'
        ? tlsConnect({ host: options.host, port: options.port, servername: options.host, minVersion: 'TLSv1.2', ...(options.tlsOptions ?? {}) })
        : netConnect({ host: options.host, port: options.port });
    socket.on('error', () => undefined); // a late error after the outcome is decided must not end the process
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SmtpIoError('TIMEOUT'));
    }, options.timeoutMs);
    const onError = (err: Error & { code?: string }) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new SmtpIoError(options.security === 'tls' && !/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNRESET/.test(err.code ?? '') ? 'TLS' : 'CONNECT'));
    };
    socket.once('error', onError);
    socket.once(options.security === 'tls' ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

function upgrade(socket: Socket | TLSSocket, options: SmtpOptions): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({ socket: socket as Socket, servername: options.host, minVersion: 'TLSv1.2', ...(options.tlsOptions ?? {}) });
    secure.on('error', () => undefined);
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new SmtpIoError('TIMEOUT'));
    }, options.timeoutMs);
    const onError = () => {
      clearTimeout(timer);
      secure.destroy();
      reject(new SmtpIoError('TLS'));
    };
    secure.once('error', onError);
    secure.once('secureConnect', () => {
      clearTimeout(timer);
      secure.off('error', onError);
      resolve(secure);
    });
  });
}

/** RFC 2047 encoded words for a header value that is not plain ASCII, split on whole characters. */
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let current = '';
  for (const ch of value) {
    if (Buffer.byteLength(current + ch, 'utf8') > 45) {
      words.push(current);
      current = '';
    }
    current += ch;
  }
  if (current) words.push(current);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/** The message as written after DATA: headers, a base64 plain-text body, CRLF line ends and dot-stuffing, without the final ".". */
export function formatMessage(from: string, message: MailMessage, date: Date = new Date()): string {
  const subject = message.subject.replace(/[\r\n]+/g, ' ');
  const body = Buffer.from(message.text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n');
  const headers = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${date.toUTCString().replace(/GMT$/, '+0000')}`,
    `Message-ID: <${message.messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    'X-Auto-Response-Suppress: All',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${body}`.replace(/^\./gm, '..');
}

/** The server's acceptance as a reference for the delivery log: its reply text, reduced to plain characters (a queue id). */
const reference = (reply: Reply): string | null => reply.lines.join(' ').replace(/[^A-Za-z0-9 .:_<>=@#/-]/g, '').trim().slice(0, 200) || null;

export function smtpSender(options: SmtpOptions): MailSender {
  if (!isMailAddress(options.from)) throw new Error('SMTP_FROM is not a plain email address');
  const heloName = options.from.split('@')[1]!;
  return {
    async send(message) {
      if (!isMailAddress(message.to)) return { outcome: 'PERMANENT', code: 'INVALID_RECIPIENT_ADDRESS' };
      let phase: Phase = 'CONNECT';
      let conn: Connection | null = null;
      const expect = async (accepted: (code: number) => boolean): Promise<Reply> => {
        const reply = await conn!.read();
        if (!accepted(reply.code)) throw new SmtpReplyError(phase, reply.code);
        return reply;
      };
      const ok = (c: number) => c >= 200 && c < 300;
      const command = async (text: string, accepted: (code: number) => boolean = ok) => {
        conn!.write(`${text}\r\n`);
        return expect(accepted);
      };
      try {
        conn = new Connection(await open(options), options.timeoutMs);
        phase = 'GREETING';
        await expect((c) => c === 220);
        phase = 'EHLO';
        let ehlo = await command(`EHLO ${heloName}`);
        let secure = options.security === 'tls';
        if (options.security === 'starttls') {
          phase = 'STARTTLS';
          if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) throw new SmtpRefusal('SMTP_STARTTLS_UNAVAILABLE');
          await command('STARTTLS', (c) => c === 220);
          const plain = conn.detach();
          conn.attach(await upgrade(plain, options));
          secure = true;
          phase = 'EHLO';
          ehlo = await command(`EHLO ${heloName}`);
        }
        if (options.user) {
          phase = 'AUTH';
          if (!secure && options.security !== 'none') throw new SmtpRefusal('SMTP_AUTH_NOT_SECURE');
          const mechanisms = ehlo.lines.filter((l) => /^AUTH[ =]/i.test(l)).flatMap((l) => l.slice(5).toUpperCase().split(/\s+/));
          const password = options.password?.() ?? '';
          if (mechanisms.includes('PLAIN')) {
            await command(`AUTH PLAIN ${Buffer.from(`\0${options.user}\0${password}`, 'utf8').toString('base64')}`, (c) => c === 235);
          } else if (mechanisms.includes('LOGIN')) {
            await command('AUTH LOGIN', (c) => c === 334);
            await command(Buffer.from(options.user, 'utf8').toString('base64'), (c) => c === 334);
            await command(Buffer.from(password, 'utf8').toString('base64'), (c) => c === 235);
          } else throw new SmtpRefusal('SMTP_AUTH_UNAVAILABLE');
        }
        phase = 'MAIL';
        await command(`MAIL FROM:<${options.from}>`);
        phase = 'RCPT';
        await command(`RCPT TO:<${message.to}>`);
        phase = 'DATA';
        await command('DATA', (c) => c === 354);
        conn.write(formatMessage(options.from, message));
        // From here on the server may have the message: a broken connection no longer means it was not accepted.
        phase = 'MESSAGE';
        conn.write('.\r\n');
        const accepted = await expect(ok);
        try {
          conn.write('QUIT\r\n');
        } catch {
          // the message was accepted; a QUIT that cannot be written changes nothing
        }
        return { outcome: 'SENT', reference: reference(accepted) };
      } catch (err) {
        if (err instanceof SmtpReplyError) {
          return { outcome: err.code >= 500 ? 'PERMANENT' : 'TRANSIENT', code: `SMTP_${err.phase}_${err.code}` };
        }
        if (err instanceof SmtpRefusal) return { outcome: 'TRANSIENT', code: err.code };
        if (phase === 'MESSAGE') return { outcome: 'UNKNOWN', code: 'SMTP_OUTCOME_UNKNOWN' };
        const kind = err instanceof SmtpIoError ? err.kind : 'CLOSED';
        return { outcome: 'TRANSIENT', code: kind === 'TIMEOUT' ? 'SMTP_TIMEOUT' : kind === 'TLS' ? 'SMTP_TLS_FAILED' : kind === 'CONNECT' ? 'SMTP_CONNECTION_FAILED' : 'SMTP_CONNECTION_LOST' };
      } finally {
        conn?.close();
      }
    },
  };
}
