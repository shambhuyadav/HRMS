// The production malware scanner (ADR-12): clamd's INSTREAM protocol against a stand-in clamd on a local port, which reassembles the
// length-prefixed chunks and answers as clamd does. OK releases, FOUND quarantines with the signature, anything else (an error answer, a
// dropped connection, no answer in time, nobody listening) is ERROR, so the file waits for the scan worker's retry.
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { clamavScanner, clamdVerdict } from './clamav.js';

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

/** A stand-in clamd: collects the streamed bytes and answers what `answer` says about them. */
async function fakeClamd(answer: (streamed: Buffer, command: string) => string | null): Promise<{ port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      const command = 'zINSTREAM\0';
      if (buffer.length < command.length) return;
      let at = command.length;
      const parts: Buffer[] = [];
      for (;;) {
        if (buffer.length < at + 4) return;
        const length = buffer.readUInt32BE(at);
        if (length === 0) break;
        if (buffer.length < at + 4 + length) return;
        parts.push(buffer.subarray(at + 4, at + 4 + length));
        at += 4 + length;
      }
      const streamed = Buffer.concat(parts);
      received.push(streamed);
      const reply = answer(streamed, buffer.subarray(0, command.length).toString('latin1'));
      if (reply === null) socket.destroy();
      else socket.end(`${reply}\0`);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { port: (server!.address() as { port: number }).port, received };
}

describe('ClamAV scanner (clamd INSTREAM)', () => {
  it('streams the whole file in chunks and reads OK as CLEAN and FOUND as INFECTED with the signature', async () => {
    const big = Buffer.alloc(200 * 1024, 7); // several 64 KiB chunks
    const clamd = await fakeClamd((streamed, command) => {
      expect(command).toBe('zINSTREAM\0');
      return streamed.includes(Buffer.from('EVIL')) ? 'stream: Synthetic.Test-Signature FOUND' : 'stream: OK';
    });
    const scanner = clamavScanner({ host: '127.0.0.1', port: clamd.port, timeoutMs: 5000 });
    expect(await scanner.scan(big)).toEqual({ verdict: 'CLEAN' });
    expect(clamd.received[0]!.equals(big)).toBe(true);
    expect(await scanner.scan(Buffer.from('a file with EVIL inside'))).toEqual({ verdict: 'INFECTED', finding: 'Synthetic.Test-Signature' });
    expect(await scanner.scan(Buffer.alloc(0))).toEqual({ verdict: 'CLEAN' });
  });

  it('an error answer, a dropped connection, a timeout or no clamd at all is ERROR, never CLEAN', async () => {
    const clamd = await fakeClamd((streamed) => (streamed.length > 10 ? 'INSTREAM size limit exceeded. ERROR' : null));
    const scanner = clamavScanner({ host: '127.0.0.1', port: clamd.port, timeoutMs: 5000 });
    expect(await scanner.scan(Buffer.alloc(100, 1))).toEqual({ verdict: 'ERROR' });
    expect(await scanner.scan(Buffer.from('short'))).toEqual({ verdict: 'ERROR' });
    server!.close();
    // A clamd that never answers.
    server = createServer(() => undefined);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const silent = clamavScanner({ host: '127.0.0.1', port: (server.address() as { port: number }).port, timeoutMs: 300 });
    expect(await silent.scan(Buffer.from('x'))).toEqual({ verdict: 'ERROR' });
    expect(await clamavScanner({ host: '127.0.0.1', port: 1, timeoutMs: 2000 }).scan(Buffer.from('x'))).toEqual({ verdict: 'ERROR' });
  });

  it('reads clamd’s answers strictly', () => {
    expect(clamdVerdict('stream: OK\0')).toEqual({ verdict: 'CLEAN' });
    expect(clamdVerdict('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toEqual({ verdict: 'INFECTED', finding: 'Win.Test.EICAR_HDB-1' });
    expect(clamdVerdict('')).toEqual({ verdict: 'ERROR' });
    expect(clamdVerdict('stream: OK extra')).toEqual({ verdict: 'ERROR' });
    expect(clamdVerdict('lstat() failed: ERROR')).toEqual({ verdict: 'ERROR' });
  });
});
