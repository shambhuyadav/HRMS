// Malware scanning of user uploads (FR-106; H4 "failed scan quarantines"). A file is quarantined (PENDING_SCAN) when
// stored and is served only once a scanner has released it as CLEAN; a finding quarantines it for good. The actual
// scanner is a deployment integration (its contract and credentials stay outside shared files); production refuses
// to start without one. The development scanner below is for synthetic data only: it recognises the industry-
// standard EICAR test string and treats everything else as clean, so tests can exercise both verdicts.
import type { Queryable } from '../db/queryable.js';
import type { FileStore } from './files.js';

export type ScanVerdict = { verdict: 'CLEAN' } | { verdict: 'INFECTED'; finding: string } | { verdict: 'ERROR' };

export interface ScanProvider {
  scan(bytes: Buffer): Promise<ScanVerdict>;
}

/** The EICAR test string, assembled at run time so this source file itself never looks like a test virus. */
export const EICAR_TEST_STRING = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-', 'ANTIVIRUS-TEST-FILE!$H+H*'].join('');
const EICAR = EICAR_TEST_STRING;

export function developmentScanner(): ScanProvider {
  if (process.env.NODE_ENV === 'production') throw new Error('The development scanner cannot be used in production');
  return {
    async scan(bytes) {
      return bytes.includes(Buffer.from(EICAR, 'latin1')) ? { verdict: 'INFECTED', finding: 'EICAR-Test-File' } : { verdict: 'CLEAN' };
    },
  };
}

/**
 * Scans one stored attachment and records the verdict. A scanner error leaves it PENDING_SCAN for a later retry;
 * the verdict update only applies while the file is still pending, so concurrent scans cannot disagree. With
 * `notifyOwner` a quarantine also queues the uploader's notice in the same statement (H7): a background scan answers no
 * request, so nobody would otherwise learn of it. An upload route is told the verdict and answers the uploader itself.
 */
export async function scanAttachment(
  db: Queryable,
  scanner: ScanProvider,
  attachment: { companyId: string; id: string; bytes: Buffer },
  options: { notifyOwner?: boolean } = {},
): Promise<'PENDING_SCAN' | 'CLEAN' | 'QUARANTINED'> {
  let result: ScanVerdict;
  try {
    result = await scanner.scan(attachment.bytes);
  } catch {
    result = { verdict: 'ERROR' };
  }
  if (result.verdict === 'ERROR') return 'PENDING_SCAN';
  const state = result.verdict === 'CLEAN' ? 'CLEAN' : 'QUARANTINED';
  const finding = result.verdict === 'INFECTED' ? result.finding.replace(/[^A-Za-z0-9._:/ -]/g, '').slice(0, 200) || 'FINDING' : null;
  const updated = await db.query<{ scan_state: 'CLEAN' | 'QUARANTINED' }>(
    `with verdict as (
       update attachment set scan_state = $3, scan_checked_at = now(), scan_finding = $4
        where company_id = $1 and id = $2 and scan_state = 'PENDING_SCAN' returning id, scan_state
     ), notice as (
       insert into outbox_event (company_id, topic, aggregate_id, dedupe_key, payload)
       select $1, 'storage.scan_quarantined', v.id, 'storage.scan_quarantined:' || v.id::text, jsonb_build_object('attachmentId', v.id)
         from verdict v where $5::boolean and v.scan_state = 'QUARANTINED'
       on conflict (company_id, dedupe_key) do nothing
     )
     select scan_state from verdict`,
    [attachment.companyId, attachment.id, state, finding, options.notifyOwner === true],
  );
  if (updated.rows[0]) return updated.rows[0].scan_state;
  const current = (await db.query<{ scan_state: 'PENDING_SCAN' | 'CLEAN' | 'QUARANTINED' }>(`select scan_state from attachment where company_id = $1 and id = $2`, [attachment.companyId, attachment.id])).rows[0];
  return current?.scan_state ?? 'PENDING_SCAN';
}

/** Retries files still waiting for a verdict (e.g. after a scanner outage); oldest first, bounded per run. */
export async function scanPendingAttachments(db: Queryable, files: FileStore, scanner: ScanProvider, companyId: string, limit = 200) {
  const pending = (
    await db.query<{ id: string; content_reference: string }>(
      `select id, content_reference from attachment where company_id = $1 and scan_state = 'PENDING_SCAN' order by created_at limit $2`,
      [companyId, limit],
    )
  ).rows;
  const outcome = { scanned: 0, clean: 0, quarantined: 0, stillPending: 0 };
  for (const p of pending) {
    let bytes: Buffer;
    try {
      bytes = await files.get(p.content_reference);
    } catch {
      outcome.stillPending++;
      continue;
    }
    const state = await scanAttachment(db, scanner, { companyId, id: p.id, bytes }, { notifyOwner: true });
    outcome.scanned++;
    if (state === 'CLEAN') outcome.clean++;
    else if (state === 'QUARANTINED') outcome.quarantined++;
    else outcome.stillPending++;
  }
  return outcome;
}
