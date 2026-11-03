// HTTP transport for the generator: keep-alive connections, a hard per-request deadline, and the moment the request
// actually got a socket (its send time), so agent queueing shows up as generator lateness rather than as latency
// the system never caused. Bodies are only kept when the caller needs them (error codes, identity checks).
import http from 'node:http';
import https from 'node:https';
import type { RequestSpec } from './workload.js';

export type TransportOutcome = 'RESPONSE' | 'TIMEOUT' | 'NETWORK_ERROR';

export interface TransportResult {
  outcome: TransportOutcome;
  status: number | null;
  /** The API's error code (`error` in the JSON body), or the network error code. */
  errorCode: string | null;
  body: unknown;
}

export interface SendOptions {
  timeoutMs: number;
  /** Parse the body of 2xx responses too (error responses are always parsed for their code). */
  wantBody: boolean;
  /** Called when the request is handed a socket, i.e. when it is actually sent. */
  onSent: () => void;
}

export interface Transport {
  send(spec: RequestSpec, opts: SendOptions): Promise<TransportResult>;
  close(): Promise<void>;
}

const MAX_KEPT_BODY = 1_048_576;

export function httpTransport(baseUrl: string, opts: { maxSockets: number }): Transport {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error(`Unsupported target protocol ${base.protocol}`);
  const lib = base.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({ keepAlive: true, maxSockets: opts.maxSockets, maxFreeSockets: Math.min(opts.maxSockets, 1024), scheduling: 'lifo' });
  const prefix = base.pathname.replace(/\/$/, '');

  return {
    send(spec, o) {
      return new Promise<TransportResult>((resolve) => {
        let settled = false;
        let deadline: NodeJS.Timeout | undefined;
        const finish = (r: TransportResult) => {
          if (settled) return;
          settled = true;
          if (deadline) clearTimeout(deadline);
          resolve(r);
        };
        const payload = spec.body === undefined ? null : Buffer.from(JSON.stringify(spec.body));
        const headers: Record<string, string> = { ...spec.headers, accept: 'application/json' };
        if (payload) {
          headers['content-type'] = 'application/json';
          headers['content-length'] = String(payload.length);
        } else if (spec.method !== 'GET') {
          headers['content-length'] = '0';
        }
        const req = lib.request(
          { protocol: base.protocol, hostname: base.hostname, port: base.port || undefined, method: spec.method, path: `${prefix}${spec.path}`, headers, agent },
          (res) => {
            const status = res.statusCode ?? 0;
            const keep = o.wantBody || status >= 400;
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (chunk: Buffer) => {
              if (keep && size < MAX_KEPT_BODY) {
                chunks.push(chunk);
                size += chunk.length;
              }
            });
            res.on('end', () => {
              let body: unknown = null;
              if (keep && chunks.length) {
                try {
                  body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                } catch {
                  body = null;
                }
              }
              const code = status >= 400 && typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : null;
              finish({ outcome: 'RESPONSE', status, errorCode: code, body });
            });
            res.on('error', (err: NodeJS.ErrnoException) => finish({ outcome: 'NETWORK_ERROR', status: null, errorCode: err.code ?? 'RESPONSE_ERROR', body: null }));
          },
        );
        req.once('socket', () => o.onSent());
        req.on('error', (err: NodeJS.ErrnoException) => finish({ outcome: 'NETWORK_ERROR', status: null, errorCode: err.code ?? 'REQUEST_ERROR', body: null }));
        deadline = setTimeout(() => {
          finish({ outcome: 'TIMEOUT', status: null, errorCode: 'TIMEOUT', body: null });
          req.destroy();
        }, o.timeoutMs);
        if (payload) req.end(payload);
        else req.end();
      });
    },
    async close() {
      agent.destroy();
    },
  };
}
