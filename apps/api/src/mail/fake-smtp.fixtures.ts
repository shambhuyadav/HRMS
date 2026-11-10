// An in-process SMTP server for tests (node:net on 127.0.0.1, port 0): no real mail and no network. It records each session's
// commands and each accepted message, and can be told to misbehave at one step. Synthetic data only (example.invalid addresses).
import { createServer, type Server, type Socket } from 'node:net';

export interface ReceivedMessage {
  from: string;
  to: string[];
  /** The DATA section as received, dot-stuffing undone, CRLF line ends. */
  data: string;
  /** Decoded AUTH credentials of the session, when it signed in. */
  auth: { user: string; password: string } | null;
}

export interface FakeSmtpBehaviour {
  /** Advertise STARTTLS (a test server cannot complete it; a client that requires it must refuse before saying anything else). */
  advertiseStartTls: boolean;
  /** Advertise AUTH PLAIN LOGIN and accept these credentials; anything else is answered 535. */
  credentials: { user: string; password: string } | null;
  /** The reply to RCPT TO, e.g. '550 5.1.1 No such user'. */
  rcptReply: string;
  /** The reply after the message's final dot, e.g. '451 4.3.0 Try again later'. */
  dataReply: string;
  /** Close the connection after the message's final dot, without replying (the outcome cannot be known). */
  dropAfterMessage: boolean;
  /** Close the connection right after the greeting. */
  dropAfterGreeting: boolean;
}

export interface FakeSmtp {
  port: number;
  behaviour: FakeSmtpBehaviour;
  messages: ReceivedMessage[];
  /** Every command line received, per session (AUTH lines included as sent). */
  sessions: string[][];
  reset(): void;
  close(): Promise<void>;
}

const DEFAULTS: FakeSmtpBehaviour = {
  advertiseStartTls: false,
  credentials: null,
  rcptReply: '250 2.1.5 Ok',
  dataReply: '250 2.0.0 Ok: queued as FAKE0001',
  dropAfterMessage: false,
  dropAfterGreeting: false,
};

export async function startFakeSmtp(): Promise<FakeSmtp> {
  const state: FakeSmtp = {
    port: 0,
    behaviour: { ...DEFAULTS },
    messages: [],
    sessions: [],
    reset() {
      state.behaviour = { ...DEFAULTS };
      state.messages.length = 0;
      state.sessions.length = 0;
    },
    close: async () => undefined,
  };
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const b = state.behaviour;
    const transcript: string[] = [];
    state.sessions.push(transcript);
    let buffer = '';
    let inData = false;
    let data: string[] = [];
    let envelope: { from: string; to: string[] } = { from: '', to: [] };
    let auth: { user: string; password: string } | null = null;
    let loginStep: 'user' | 'password' | null = null;
    let loginUser = '';
    const send = (text: string) => socket.write(`${text}\r\n`);
    const authenticate = (user: string, password: string) => {
      if (b.credentials && user === b.credentials.user && password === b.credentials.password) {
        auth = { user, password };
        send('235 2.7.0 Authentication successful');
      } else send('535 5.7.8 Authentication failed');
    };
    send('220 fake.example.invalid ESMTP');
    if (b.dropAfterGreeting) {
      socket.destroy();
      return;
    }
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let at: number;
      while ((at = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            state.messages.push({ ...envelope, data: data.join('\r\n'), auth });
            data = [];
            if (b.dropAfterMessage) {
              socket.destroy();
              return;
            }
            send(b.dataReply);
          } else data.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        transcript.push(line);
        if (loginStep === 'user') {
          loginUser = Buffer.from(line, 'base64').toString('utf8');
          loginStep = 'password';
          send('334 UGFzc3dvcmQ6');
          continue;
        }
        if (loginStep === 'password') {
          loginStep = null;
          authenticate(loginUser, Buffer.from(line, 'base64').toString('utf8'));
          continue;
        }
        const verb = line.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') {
          const ext = [...(b.advertiseStartTls ? ['STARTTLS'] : []), ...(b.credentials ? ['AUTH PLAIN LOGIN'] : []), '8BITMIME'];
          send(['250-fake.example.invalid', ...ext.slice(0, -1).map((e) => `250-${e}`), `250 ${ext.at(-1)}`].join('\r\n'));
        } else if (verb === 'STARTTLS') send('454 4.7.0 TLS not available in this test server');
        else if (verb === 'AUTH') {
          const [, mechanism, initial] = line.split(' ');
          if (mechanism?.toUpperCase() === 'PLAIN' && initial) {
            const [, user, password] = Buffer.from(initial, 'base64').toString('utf8').split('\0');
            authenticate(user ?? '', password ?? '');
          } else if (mechanism?.toUpperCase() === 'LOGIN') {
            loginStep = 'user';
            send('334 VXNlcm5hbWU6');
          } else send('504 5.5.4 Unrecognised authentication type');
        } else if (verb === 'MAIL') {
          if (b.credentials && !auth) send('530 5.7.0 Authentication required');
          else {
            envelope = { from: /<([^>]*)>/.exec(line)?.[1] ?? '', to: [] };
            send('250 2.1.0 Ok');
          }
        } else if (verb === 'RCPT') {
          if (b.rcptReply.startsWith('2')) envelope.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          send(b.rcptReply);
        } else if (verb === 'DATA') {
          inData = true;
          send('354 End data with <CR><LF>.<CR><LF>');
        } else if (verb === 'QUIT') {
          send('221 2.0.0 Bye');
          socket.end();
        } else send('502 5.5.2 Command not recognised');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as { port: number }).port;
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return state;
}

/** A port on 127.0.0.1 that nothing listens on (taken and released at once). */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** The decoded text body of a received message (base64, as the channel sends it). */
export function bodyOf(message: ReceivedMessage): string {
  const [, body = ''] = message.data.split('\r\n\r\n');
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

/** A received message's header lines, unfolded. */
export function headersOf(message: ReceivedMessage): string[] {
  const [head = ''] = message.data.split('\r\n\r\n');
  return head.replace(/\r\n[ \t]+/g, ' ').split('\r\n');
}
