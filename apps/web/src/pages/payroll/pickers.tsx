// Shared choices of the payroll screens: payroll period, employee, evidence documents, and the note and missing lines.

import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { CheckField, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { api, type EmployeeHit, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Notice } from '../../ui';
import { Problem } from './problems';
import { CONFIG_READ, DOCUMENT_READ, EMPLOYEE_LIST, useKeys } from './shared';
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
  if (!can(CONFIG_READ)) return <Hint className="col-span-full">{`The selected role cannot list payroll calendars, so it cannot choose the period ${purpose}.`}</Hint>;
  const active = (calendars.data?.items ?? []).filter((c) => c.state === 'ACTIVE');
  const calendar = active.find((c) => c.id === calendarId);
  return (
    <>
      {calendars.error && (
        <div className="col-span-full">
          <Problem error={calendars.error} act="read" />
        </div>
      )}
      <FormField>
        Payroll calendar
        <NativeSelect
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
        </NativeSelect>
      </FormField>
      <FormField>
        Period
        <NativeSelect
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
        </NativeSelect>
      </FormField>
      {calendars.data && active.length === 0 && <Hint className="col-span-full">No payroll calendar is active yet.</Hint>}
    </>
  );
}

export const person = (e: { employeeCode: string; displayName: string }) => `${e.employeeCode} ${e.displayName}`;

/** The employees a search found, one under another (the old `.choices` list). */
const CHOICE_LIST = 'm-0 mt-3 flex list-none flex-col gap-[0.6rem] p-0';
/** One found employee: a full-width outline button, its words from the left and wrapping, tinted in the brand colour on hover. */
const CHOICE = 'h-auto w-full justify-start px-4 py-[0.8rem] text-left whitespace-normal hover:border-[var(--accent-bright)] hover:bg-[var(--accent-soft)]';

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
  if (!can(EMPLOYEE_LIST)) return <Hint className="col-span-full">The selected role cannot search employees, so it cannot choose the employee here.</Hint>;
  return (
    <div className="col-span-full">
      {value !== null && (
        <p className="my-1">
          {`${title}: `}
          <strong>{person(value)}</strong>{' '}
          <Button type="button" variant="outline" onClick={() => onChange(null)} aria-label={`Clear the ${title.toLowerCase()}`}>
            Clear
          </Button>
        </p>
      )}
      <FormField>
        {`Find the ${title.toLowerCase()}`}
        <Input type="search" value={search} maxLength={100} placeholder="Name, employee code or work email" onChange={(e) => setSearch(e.target.value)} />
      </FormField>
      {term !== '' && hits.isLoading && <Hint>Searching…</Hint>}
      {hits.error && <Problem error={hits.error} act="read" />}
      {term !== '' && hits.data && hits.data.items.length === 0 && <Empty>{`No employees match “${term}”.`}</Empty>}
      {term !== '' && hits.data && hits.data.items.length > 0 && (
        <ul className={CHOICE_LIST} aria-label="Matching employees">
          {hits.data.items.map((e) => (
            <li key={e.id}>
              <Button
                type="button"
                variant="outline"
                className={CHOICE}
                aria-label={`Choose ${person(e)}`}
                onClick={() => {
                  onChange(e);
                  setSearch('');
                  setTerm('');
                }}
              >
                {`${person(e)} · ${readable(e.status).toLowerCase()}`}
              </Button>
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
  if (!can(DOCUMENT_READ)) return <Hint className="col-span-full">The selected role cannot list the employee’s documents, so it cannot choose the evidence here.</Hint>;
  const choose = (id: string, checked: boolean) => {
    if (max === 1) onChange([id]);
    else onChange(checked ? [...chosen, id] : chosen.filter((x) => x !== id));
  };
  return (
    <FieldSet className="col-span-full gap-[0.55rem]">
      <legend>{max === 1 ? 'Evidence document (released and verified)' : `Evidence documents (released and verified, at most ${max})`}</legend>
      {docs.isPending && <LoadingLine>Loading the employee’s documents…</LoadingLine>}
      {docs.error && <Problem error={docs.error} act="read" />}
      {docs.data && docs.data.items.length === 0 && <Hint>The employee has no documents yet: add the evidence to their record and have it verified first.</Hint>}
      {docs.data?.items.map((d) => {
        const picked = chosen.includes(d.id);
        return (
          <CheckField key={d.id}>
            <input
              type={max === 1 ? 'radio' : 'checkbox'}
              name={name}
              checked={picked}
              disabled={!usableEvidence(d) || (!picked && max > 1 && chosen.length >= max)}
              onChange={(e) => choose(d.id, e.target.checked)}
            />{' '}
            {`${readable(d.documentType)}${d.fileName ? ` · ${d.fileName}` : ''} (${formatDate(d.uploadedAt)}): ${evidenceState(d)}`}
          </CheckField>
        );
      })}
    </FieldSet>
  );
}

/** A change that worked, said as a status. */
export function Note({ text }: { text: string | null }) {
  if (!text) return null;
  return <Notice notice={{ text, ok: true }} />;
}

/** What is still missing before a form can be sent, said as an alert (it spans a form grid's row by its role). */
export function Missing({ text }: { text: string | null }) {
  if (!text) return null;
  return <Notice notice={{ text, ok: false }} />;
}
