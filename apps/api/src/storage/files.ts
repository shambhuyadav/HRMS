// File store (ADR-07). The reference is opaque and never a public URL, and reads always go through an authorised API
// route. Production will use the S3-compatible store; development uses a local directory and tests use memory.
//
// Object keys start with the owning company: `<company id>/<sha256>` (docs/09 §3.4), so one company's objects can be
// listed, copied, moved or erased as a unit by prefix, and identical bytes are never shared between companies (inside
// a company they still are: content addressing). The reference stored on each attachment row is what reads use, so
// files stored before company prefixes (`local:<sha256>`, `mem:<sha256>`) keep their key and stay readable.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from '../http/errors.js';

export interface StoredFile {
  reference: string;
  checksum: string;
  byteSize: number;
}

export interface FileStore {
  /** Stores bytes for one company under its key prefix (`objectKey`). */
  put(companyId: string, bytes: Buffer): Promise<StoredFile>;
  get(reference: string): Promise<Buffer>;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const COMPANY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHECKSUM = /^[0-9a-f]{64}$/;
/** A stored key: company-prefixed, or a bare checksum written before company prefixes. */
const STORED_KEY = /^(?:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/)?([0-9a-f]{64})$/;

/** The key prefix every object of a company starts with. */
export function companyKeyPrefix(companyId: string): string {
  if (!COMPANY_ID.test(companyId)) throw new Error('invalid company id');
  return `${companyId}/`;
}

/** The object key of a company's file: its company prefix and the SHA-256 of its bytes. */
export function objectKey(companyId: string, checksum: string): string {
  if (!CHECKSUM.test(checksum)) throw new Error('invalid checksum');
  return `${companyKeyPrefix(companyId)}${checksum}`;
}

/** The key part of a stored reference of the given scheme, or null when it is not one this store wrote. */
function storedKey(reference: string, scheme: string): { companyId: string | null; checksum: string } | null {
  if (!reference.startsWith(`${scheme}:`)) return null;
  const m = STORED_KEY.exec(reference.slice(scheme.length + 1));
  return m ? { companyId: m[1] ?? null, checksum: m[2]! } : null;
}

export function memoryFileStore(): FileStore {
  const files = new Map<string, Buffer>();
  return {
    async put(companyId, bytes) {
      const checksum = sha256(bytes);
      const reference = `mem:${objectKey(companyId, checksum)}`;
      files.set(reference, Buffer.from(bytes));
      return { reference, checksum, byteSize: bytes.length };
    },
    async get(reference) {
      const file = files.get(reference);
      if (!file) throw new Error('file not found');
      return file;
    },
  };
}

/** One directory per company under `dir`; files stored before company prefixes stay at the top level. */
export function localFileStore(dir: string): FileStore {
  return {
    async put(companyId, bytes) {
      const checksum = sha256(bytes);
      const key = objectKey(companyId, checksum);
      await mkdir(join(dir, companyId), { recursive: true });
      await writeFile(join(dir, companyId, checksum), bytes);
      return { reference: `local:${key}`, checksum, byteSize: bytes.length };
    },
    async get(reference) {
      const key = storedKey(reference, 'local');
      if (!key) throw new Error('invalid reference');
      return readFile(key.companyId ? join(dir, key.companyId, key.checksum) : join(dir, key.checksum));
    },
  };
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Upload file names: no path separators, reserved characters, C0 control characters or DEL. */
export const UPLOAD_FILE_NAME = { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^/\\\\<>:"|?*\\x00-\\x1f\\x7f]+$' } as const;

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Content-Disposition for a stored file (RFC 6266 with the RFC 5987 / 8187 extended parameter). A stored name is
 * user text and may hold any Unicode, while a header value cannot carry characters above U+00FF or control
 * characters (Node refuses the whole response). The quoted fallback is printable ASCII without quotes or
 * backslashes; `filename*` carries the exact name as percent-encoded UTF-8 and takes precedence in browsers.
 */
export function attachmentDisposition(fileName: string | null | undefined, defaultName: string): string {
  const name = (fileName ?? '').replace(LONE_SURROGATE, '\ufffd').trim() || defaultName;
  const fallback = name.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/g, '').trim() || defaultName;
  // encodeURIComponent leaves ' ( ) * as they are, but they are not RFC 5987 attr-chars.
  const extended = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${extended}`;
}

/** Headers for serving stored confidential bytes (FR-057): a download of the sniffed type, never cached or sniffed. */
export function downloadHeaders(file: { mediaType: string; fileName: string | null }, defaultName: string): Record<string, string> {
  return {
    'content-type': file.mediaType,
    'content-disposition': attachmentDisposition(file.fileName, defaultName),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
}

/** Decodes an uploaded document or receipt and checks its size and real type before anything is stored. */
export function decodeUpload(contentBase64: string): { bytes: Buffer; mediaType: string } {
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) throw new HttpError(422, 'FILE_SIZE', 'Files must be between 1 byte and 10 MB');
  const mediaType = detectMediaType(bytes);
  if (!mediaType) throw new HttpError(422, 'UNSUPPORTED_FILE', 'Only PDF, JPEG and PNG files are accepted');
  return { bytes, mediaType };
}

/** Basic content sniffing so a renamed file cannot claim another type (PDF, JPEG, PNG only). */
export function detectMediaType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}
