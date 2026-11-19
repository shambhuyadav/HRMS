// Shared choices of the payroll screens: payroll period, employee, evidence documents, and the note and missing lines.

import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { api, type EmployeeHit, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty } from '../../ui';
import { Problem } from './problems';
import { CONFIG_READ, DOCUMENT_READ, EMPLOYEE_LIST, FLUSH, GROUP, useKeys } from './shared';
import type { Calendar } from './types';

// =========================================================================================================
// Shared choices: payroll period, employee, evidence documents
// =========================================================================================================

/** Query filter for every cached answer whose key starts with the prefix (any role context of this session). */
export const byPrefix = (prefix: string) => ({ predicate: (q: { queryKey: readonly unknown[] }) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith(prefix) });

export interface PeriodChoice {
  periodId: string;
  periodCode: string;
  currencyCode: string;
}

/** A period of an active payroll calendar (the calendars need the configuration read duty). */
export function PeriodPicker({ value, onChange, purpose }: { value: PeriodChoice | null; onChange: (p: PeriodChoice | null) => void; purpose: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const [calendarId, setCalendarId] = useState('');
  const calendars = useQuery({ queryKey: keys.calendars, queryFn: () => api<{ items: Calendar[] }>('/v1/payroll/calendars'), enabled: can(CONFIG_READ), retry: retryTransient });
  if (!can(CONFIG_READ)) return <p className="hint wide">{`The selected role cannot list payroll calendars, so it cannot choose the period ${purpose}.`}</p>;
  const active = (calendars.data?.items ?? []).filter((c) => c.state === 'ACTIVE');
  const calendar = active.find((c) => c.id === calendarId);
  return (
    <>
      {calendars.error && (
        <div className="wide">
          <Problem error={calendars.error} act="read" />
        </div>
      )}
      <label>
        Payroll calendar
        <select
          value={calendarId}
          onChange={(e) => {
            setCalendarId(e.target.value);
            onChange(null);
          }}
        >
          <option value="">Choose a calendar</option>
          {active.map((c) => (
            <option key={c.id} value={c.id}>
              {`${c.code} · ${c.name} (${c.currencyCode})`}
            </option>
          ))}
        </select>
      </label>
      <label>
        Period
        <select
          value={value?.periodId ?? ''}
          disabled={!calendar}
          onChange={(e) => {
            const p = calendar?.periods.find((x) => x.id === e.target.value);
            onChange(p && calendar ? { periodId: p.id, periodCode: p.periodCode, currencyCode: calendar.currencyCode } : null);
          }}
        >
          <option value="">Choose a period</option>
          {(calendar?.periods ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {`${p.periodCode} (${formatDate(p.serviceStart)} to ${formatDate(p.serviceEnd)})`}
            </option>
          ))}
        </select>
      </label>
      {calendars.data && active.length === 0 && <p className="hint wide">No payroll calendar is active yet.</p>}
    </>
  );
}

export const person = (e: { employeeCode: string; displayName: string }) => `${e.employeeCode} ${e.displayName}`;

/** An employee found by the employee search (row scope, status and one's own record are checked by the server). */
export function EmployeePicker({ title, value, onChange }: { title: string; value: EmployeeHit | null; onChange: (e: EmployeeHit | null) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const hits = useQuery({
    queryKey: keys.employeeSearch(term),
    queryFn: () => api<{ items: EmployeeHit[] }>(`/v1/employees?${new URLSearchParams({ search: term, page: '1', pageSize: '25' }).toString()}`),
    enabled: can(EMPLOYEE_LIST) && term !== '',
    retry: retryTransient,
  });
  if (!can(EMPLOYEE_LIST)) return <p className="hint wide">The selected role cannot search employees, so it cannot choose the employee here.</p>;
  return (
    <div className="wide">
      {value !== null && (
        <p style={FLUSH}>
          {`${title}: `}
          <strong>{person(value)}</strong>{' '}
          <button type="button" className="secondary" onClick={() => onChange(null)} aria-label={`Clear the ${title.toLowerCase()}`}>
            Clear
          </button>
        </p>
      )}
      <label>
        {`Find the ${title.toLowerCase()}`}
        <input type="search" value={search} maxLength={100} placeholder="Name, employee code or work email" onChange={(e) => setSearch(e.target.value)} />
      </label>
      {term !== '' && hits.isLoading && <p className="hint">Searching…</p>}
      {hits.error && <Problem error={hits.error} act="read" />}
      {term !== '' && hits.data && hits.data.items.length === 0 && <Empty>{`No employees match “${term}”.`}</Empty>}
      {term !== '' && hits.data && hits.data.items.length > 0 && (
        <ul className="choices" aria-label="Matching employees">
          {hits.data.items.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                aria-label={`Choose ${person(e)}`}
                onClick={() => {
                  onChange(e);
                  setSearch('');
                  setTerm('');
                }}
              >
                {`${person(e)} · ${readable(e.status).toLowerCase()}`}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface EvidenceDocument {
  id: string;
  documentType: string;
  fileName: string | null;
  uploadedAt: string;
  scanState: string | null;
  verificationState: string;
}
/** Evidence must be released by the malware scan and verified by an independent reviewer (the API refuses anything else). */
export const usableEvidence = (d: EvidenceDocument) => d.scanState === 'CLEAN' && d.verificationState === 'VERIFIED';
export function evidenceState(d: EvidenceDocument): string {
  if (d.scanState === 'QUARANTINED') return 'quarantined by the malware scan, not usable';
  if (d.scanState !== 'CLEAN') return 'waiting for the malware scan, not usable yet';
  if (d.verificationState === 'VERIFIED') return 'released and verified';
  if (d.verificationState === 'REJECTED') return 'rejected by the verifier, not usable';
  return 'released, not verified yet, not usable';
}

/** The employee's own documents as evidence: only released and verified ones can be chosen; the files are not opened here. */
export function EvidencePicker({ employeeId, chosen, onChange, max }: { employeeId: string; chosen: string[]; onChange: (ids: string[]) => void; max: number }) {
  const { can } = useSession();
  const keys = useKeys();
  const name = useId();
  const docs = useQuery({
    queryKey: keys.documents(employeeId),
    queryFn: () => api<{ items: EvidenceDocument[] }>(`/v1/employees/${encodeURIComponent(employeeId)}/documents`),
    enabled: can(DOCUMENT_READ),
    retry: retryTransient,
  });
  if (!can(DOCUMENT_READ)) return <p className="hint wide">The selected role cannot list the employee’s documents, so it cannot choose the evidence here.</p>;
  return (
    <fieldset className="wide" style={GROUP}>
      <legend>{max === 1 ? 'Evidence document (released and verified)' : `Evidence documents (released and verified, at most ${max})`}</legend>
      {docs.isPending && <p className="hint loading">Loading the employee’s documents…</p>}
      {docs.error && <Problem error={docs.error} act="read" />}
      {docs.data && docs.data.items.length === 0 && <p className="hint">The employee has no documents yet: add the evidence to their record and have it verified first.</p>}
      {docs.data?.items.map((d) => {
        const picked = chosen.includes(d.id);
        return (
          <label key={d.id} className="check">
            <input
              type={max === 1 ? 'radio' : 'checkbox'}
              name={name}
              checked={picked}
              disabled={!usableEvidence(d) || (!picked && max > 1 && chosen.length >= max)}
              onChange={(e) => onChange(max === 1 ? [d.id] : e.target.checked ? [...chosen, d.id] : chosen.filter((x) => x !== d.id))}
            />{' '}
            {`${readable(d.documentType)}${d.fileName ? ` · ${d.fileName}` : ''} (${formatDate(d.uploadedAt)}): ${evidenceState(d)}`}
          </label>
        );
      })}
    </fieldset>
  );
}

export function Note({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="status" className="ok">
      {text}
    </p>
  );
}

export function Missing({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="error wide">
      {text}
    </p>
  );
}
