// The production malware scanner (ADR-12; FR-106): ClamAV's daemon (clamd) over its INSTREAM command, on a local TCP port or a Unix
// socket. The file is streamed in length-prefixed chunks; clamd answers "stream: OK", "stream: <signature> FOUND" or an error. Anything
// but a clear OK or FOUND, a timeout or a broken connection is ERROR: the file stays PENDING_SCAN and the scan worker retries it with
// backoff (storage/scan.ts); nothing is ever released without clamd's OK. clamd's StreamMaxLength must allow the largest upload.
import { connect } from 'node:net';
import type { ScanProvider, ScanVerdict } from './scan.js';

const CHUNK = 64 * 1024;

export interface ClamavOptions {
  /** A Unix socket of clamd (e.g. /var/run/clamav/clamd.ctl); else host and port. */
  socketPath?: string;
  host?: string;
  port?: number;
  timeoutMs: number;
}

/** clamd's answer to INSTREAM, read as a verdict. */
export function clamdVerdict(reply: string): ScanVerdict {
  const answer = reply.replace(/\0/g, '').trim();
  if (answer === 'stream: OK') return { verdict: 'CLEAN' };
  const found = /^stream: (.+) FOUND$/.exec(answer);
  if (found) return { verdict: 'INFECTED', finding: found[1]!.slice(0, 200) };
  return { verdict: 'ERROR' };
}

export function clamavScanner(opts: ClamavOptions): ScanProvider {
  return {
    scan(bytes: Buffer): Promise<ScanVerdict> {
      return new Promise((resolve) => {
        const socket = opts.socketPath ? connect(opts.socketPath) : connect(opts.port ?? 3310, opts.host ?? '127.0.0.1');
        let reply = '';
        let settled = false;
        const done = (verdict: ScanVerdict) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(verdict);
        };
        socket.setTimeout(opts.timeoutMs, () => done({ verdict: 'ERROR' }));
        socket.on('error', () => done({ verdict: 'ERROR' }));
        socket.on('connect', () => {
          socket.write('zINSTREAM\0');
          for (let at = 0; at < bytes.length; at += CHUNK) {
            const part = bytes.subarray(at, at + CHUNK);
            const length = Buffer.alloc(4);
            length.writeUInt32BE(part.length);
            socket.write(length);
            socket.write(part);
          }
          socket.write(Buffer.alloc(4)); // a zero length ends the stream
        });
        socket.on('data', (data) => {
          reply += data.toString('latin1');
          if (reply.includes('\0')) done(clamdVerdict(reply));
        });
        socket.on('end', () => done(clamdVerdict(reply)));
        socket.on('close', () => done(clamdVerdict(reply)));
      });
    },
  };
}

/** The scanner of the production entry points, from the environment: CLAMD_SOCKET, or CLAMD_HOST and CLAMD_PORT; SCAN_TIMEOUT_MS. */
export function clamavScannerFromEnv(env: NodeJS.ProcessEnv = process.env): ScanProvider {
  const timeoutMs = Number(env.SCAN_TIMEOUT_MS ?? 30_000);
  if (env.CLAMD_SOCKET?.trim()) return clamavScanner({ socketPath: env.CLAMD_SOCKET.trim(), timeoutMs });
  return clamavScanner({ host: env.CLAMD_HOST?.trim() || '127.0.0.1', port: Number(env.CLAMD_PORT ?? 3310), timeoutMs });
}
