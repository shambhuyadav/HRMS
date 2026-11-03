// Company-prefixed object keys (docs/09 §3.4, §13.2 item 6): every stored object's key starts with its company, so a
// company's objects can be listed, moved or erased as a unit, and references written before the prefix still read.
// Synthetic bytes only.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { companyKeyPrefix, type FileStore, localFileStore, memoryFileStore, objectKey } from './files.js';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const companyA = randomUUID();
const companyB = randomUUID();
const bytes = Buffer.from('%PDF-1.4\n% synthetic shared content\n%%EOF\n');

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrms-files-'));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe.each([
  ['memory', 'mem', () => memoryFileStore()],
  ['local directory', 'local', () => localFileStore(join(dir, randomUUID()))],
] as const)('%s store', (_name, scheme, make: () => FileStore) => {
  it('keys each object by its company and checksum; the same bytes in two companies are two objects', async () => {
    const store = make();
    const a = await store.put(companyA, bytes);
    const again = await store.put(companyA, bytes);
    const b = await store.put(companyB, bytes);
    expect(a).toEqual({ reference: `${scheme}:${companyA}/${sha256(bytes)}`, checksum: sha256(bytes), byteSize: bytes.length });
    expect(again.reference).toBe(a.reference); // content addressing inside one company
    expect(b.reference).toBe(`${scheme}:${companyB}/${sha256(bytes)}`);
    expect(b.checksum).toBe(a.checksum);
    expect((await store.get(a.reference)).equals(bytes)).toBe(true);
    expect((await store.get(b.reference)).equals(bytes)).toBe(true);
  });

  it('refuses a company id that is not a UUID, so a key can never leave its prefix', async () => {
    const store = make();
    for (const bad of ['', '..', '../x', 'ABC', `${companyA}/..`, companyA.toUpperCase()]) {
      await expect(store.put(bad, bytes)).rejects.toThrow('invalid company id');
    }
  });
});

describe('local directory store layout', () => {
  it('stores one directory per company, so its objects are listed, moved or erased as one directory', async () => {
    const root = join(dir, randomUUID());
    const store = localFileStore(root);
    const other = Buffer.from('%PDF-1.4\n% synthetic second file\n%%EOF\n');
    await store.put(companyA, bytes);
    await store.put(companyA, other);
    await store.put(companyB, bytes);
    expect((await readdir(root)).sort()).toEqual([companyA, companyB].sort());
    expect((await readdir(join(root, companyA))).sort()).toEqual([sha256(bytes), sha256(other)].sort());
    expect(await readdir(join(root, companyB))).toEqual([sha256(bytes)]);
  });

  it('still reads a file stored before company prefixes under its stored reference', async () => {
    const root = join(dir, randomUUID());
    await mkdir(root, { recursive: true });
    const legacy = Buffer.from('%PDF-1.4\n% synthetic legacy file\n%%EOF\n');
    await writeFile(join(root, sha256(legacy)), legacy);
    expect((await localFileStore(root).get(`local:${sha256(legacy)}`)).equals(legacy)).toBe(true);
  });

  it('refuses references that are not a key it wrote', async () => {
    const store = localFileStore(join(dir, randomUUID()));
    const checksum = sha256(bytes);
    for (const bad of [checksum, `mem:${companyA}/${checksum}`, `local:../${checksum}`, `local:${companyA}/../${checksum}`, `local:${companyA}/${checksum}/x`, `local:${companyA}`]) {
      await expect(store.get(bad)).rejects.toThrow('invalid reference');
    }
  });
});

describe('key helpers', () => {
  it('builds the prefix and key a company move or erasure works on', () => {
    expect(companyKeyPrefix(companyA)).toBe(`${companyA}/`);
    expect(objectKey(companyA, sha256(bytes))).toBe(`${companyA}/${sha256(bytes)}`);
    expect(() => objectKey(companyA, 'not-a-checksum')).toThrow('invalid checksum');
  });
});
