// The challan master screen (CL-074).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, formatDate, localDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section } from '../../ui';
import { CHALLAN_MANAGE, CHALLAN_READ } from './shared';

// ---------------------------------------------------------------------------------------------------------
// CL-074 challan master
// ---------------------------------------------------------------------------------------------------------
interface ChallanSetting {
  id: string;
  statute: string;
  revision: number;
  effectiveFrom: string;
  tan: string | null;
  establishmentCode: string | null;
  bankName: string;
  bankBranch: string | null;
  bsrCode: string | null;
  reason: string;
}

export function ChallanMasterPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['payroll-extras', 'challan-settings'], queryFn: () => api<{ asOf: string; inForce: Record<string, ChallanSetting | null>; items: ChallanSetting[] }>('/v1/payroll-extras/challan-settings') });
  const [form, setForm] = useState({ statute: 'TDS', effectiveFrom: localDate(), identifier: '', bankName: '', bankBranch: '', bsrCode: '', reason: '' });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () =>
      api<ChallanSetting>('/v1/payroll-extras/challan-settings', {
        body: {
          statute: form.statute,
          effectiveFrom: form.effectiveFrom,
          ...(form.statute === 'TDS' ? { tan: form.identifier } : { establishmentCode: form.identifier }),
          bankName: form.bankName,
          bankBranch: form.bankBranch || null,
          bsrCode: form.bsrCode || null,
          reason: form.reason,
        },
      }),
    onSuccess: () => {
      setForm((f) => ({ ...f, identifier: '', reason: '' }));
      void qc.invalidateQueries({ queryKey: ['payroll-extras', 'challan-settings'] });
    },
  });
  if (!can(CHALLAN_READ)) return <Empty>The challan master needs the challan read duty.</Empty>;
  return (
    <>
      <Section title="Challan master">
        <p className="hint">The company’s deposit particulars per statute. A change is a new dated revision; earlier revisions stay on record.</p>
        <ErrorNote error={settings.error} />
        {settings.data && (
          <table aria-label="In force">
            <thead>
              <tr>
                <th scope="col">Statute</th>
                <th scope="col">TAN or establishment code</th>
                <th scope="col">Bank</th>
                <th scope="col">BSR code</th>
                <th scope="col">From</th>
                <th scope="col">Revision</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(settings.data.inForce).map(([statute, s]) => (
                <tr key={statute}>
                  <td>{statute}</td>
                  {s ? (
                    <>
                      <td>{s.tan ?? s.establishmentCode}</td>
                      <td>{[s.bankName, s.bankBranch].filter(Boolean).join(', ')}</td>
                      <td>{s.bsrCode ?? '—'}</td>
                      <td>{formatDate(s.effectiveFrom)}</td>
                      <td>{s.revision}</td>
                    </>
                  ) : (
                    <td colSpan={5}>Not recorded</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {settings.data && settings.data.items.length > 0 && (
          <details>
            <summary>All revisions ({settings.data.items.length})</summary>
            <ul>
              {settings.data.items.map((s) => (
                <li key={s.id}>
                  {s.statute} revision {s.revision} from {formatDate(s.effectiveFrom)}: {s.tan ?? s.establishmentCode}, {s.bankName} — {s.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>
      {can(CHALLAN_MANAGE) && (
        <Section title="New revision">
          <form
            className="grid-form"
            aria-label="New revision"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (!save.isPending) save.mutate();
            }}
          >
            <label>
              Statute
              <select value={form.statute} onChange={set('statute')}>
                <option value="TDS">TDS</option>
                <option value="PF">PF</option>
                <option value="ESIC">ESIC</option>
              </select>
            </label>
            <label>
              Effective from
              <input type="date" value={form.effectiveFrom} onChange={set('effectiveFrom')} required />
            </label>
            <label>
              {form.statute === 'TDS' ? 'TAN' : 'Establishment code'}
              <input value={form.identifier} onChange={set('identifier')} required maxLength={30} />
            </label>
            <label>
              Bank
              <input value={form.bankName} onChange={set('bankName')} required maxLength={120} />
            </label>
            <label>
              Branch
              <input value={form.bankBranch} onChange={set('bankBranch')} maxLength={120} />
            </label>
            <label>
              BSR code
              <input value={form.bsrCode} onChange={set('bsrCode')} maxLength={7} />
            </label>
            <label>
              Reason
              <input value={form.reason} onChange={set('reason')} required maxLength={500} />
            </label>
            <button type="submit" disabled={save.isPending}>
              Record revision
            </button>
          </form>
          <ErrorNote error={save.error} />
        </Section>
      )}
    </>
  );
}
