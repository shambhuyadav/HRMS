// Application-level protection of private field payloads (H4, DB115/DB116: "encrypted/protected per technical
// policy"). AES-256-GCM with a random 96-bit nonce per envelope. Each envelope is bound (additional authenticated
// data) to its purpose, company, owner and row, so a ciphertext copied into another row, employee or company fails
// to open. Envelope: v1.<key id>.<nonce>.<tag>.<ciphertext>, base64url parts.
//
// Keys come from HRMS_FIELD_KEYS="<id>:<base64 32-byte key>[,<id>:<key>...]"; the first key seals new envelopes and
// the others still open older ones (rotation). Outside production a fixed development key is used when none is
// configured; production refuses to start without keys. Key custody and rotation policy are a deployment decision.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

interface Keyring {
  active: string;
  keys: Map<string, Buffer>;
}

let cached: { spec: string | undefined; production: boolean; ring: Keyring } | null = null;

function keyring(): Keyring {
  const spec = process.env.HRMS_FIELD_KEYS;
  const production = process.env.NODE_ENV === 'production';
  if (cached && cached.spec === spec && cached.production === production) return cached.ring;
  let ring: Keyring;
  if (!spec) {
    if (production) throw new Error('HRMS_FIELD_KEYS must be configured in production');
    ring = { active: 'dev', keys: new Map([['dev', createHash('sha256').update('hrms-development-field-key; never for real data').digest()]]) };
  } else {
    const keys = new Map<string, Buffer>();
    let active = '';
    for (const part of spec.split(',')) {
      const [id, encoded, extra] = part.trim().split(':');
      if (!id || !encoded || extra !== undefined || !/^[A-Za-z0-9_-]{1,20}$/.test(id) || keys.has(id)) throw new Error('HRMS_FIELD_KEYS is malformed');
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== 32) throw new Error('Each HRMS_FIELD_KEYS key must be 32 bytes');
      if (!active) active = id;
      keys.set(id, key);
    }
    if (!active) throw new Error('HRMS_FIELD_KEYS is malformed');
    ring = { active, keys };
  }
  cached = { spec, production, ring };
  return ring;
}

/** Fails fast at start-up when keys are missing or malformed. */
export function assertFieldKeysConfigured(): void {
  keyring();
}

export interface EnvelopeBinding {
  /** What the envelope holds, e.g. 'sensitive_change.proposed'. */
  purpose: string;
  companyId: string;
  /** The person the values belong to. */
  ownerId: string;
  /** The row that stores the envelope. */
  recordId: string;
}

const aad = (b: EnvelopeBinding) => Buffer.from(`hrms:v1:${b.purpose}:${b.companyId}:${b.ownerId}:${b.recordId}`, 'utf8');

export function sealJson(value: unknown, binding: EnvelopeBinding): string {
  const { active, keys } = keyring();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.get(active)!, nonce, { authTagLength: 16 });
  cipher.setAAD(aad(binding));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', active, nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

/** Opens an envelope sealed for the same binding; anything else (tampered, moved, unknown key) throws. */
export function openJson<T>(envelope: string, binding: EnvelopeBinding): T {
  const [version, id, nonce, tag, body, extra] = envelope.split('.');
  const key = id ? keyring().keys.get(id) : undefined;
  if (version !== 'v1' || !key || !nonce || !tag || body === undefined || extra !== undefined) throw new Error('Protected payload cannot be opened');
  const tagBytes = Buffer.from(tag, 'base64url');
  const nonceBytes = Buffer.from(nonce, 'base64url');
  if (tagBytes.length !== 16 || nonceBytes.length !== 12) throw new Error('Protected payload cannot be opened');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonceBytes, { authTagLength: 16 });
    decipher.setAAD(aad(binding));
    decipher.setAuthTag(tagBytes);
    const clear = Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]);
    return JSON.parse(clear.toString('utf8')) as T;
  } catch {
    // Never echo the envelope or the cause: it could carry fragments of protected data.
    throw new Error('Protected payload cannot be opened');
  }
}
