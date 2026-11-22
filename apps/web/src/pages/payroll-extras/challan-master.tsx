// The challan master screen (CL-074).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate, localDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section } from '../../ui';
import { CHALLAN_MANAGE, CHALLAN_READ, FOLD, FOLD_SUMMARY } from './shared';

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
        <Hint>The company’s deposit particulars per statute. A change is a new dated revision; earlier revisions stay on record.</Hint>
        <ErrorNote error={settings.error} />
        {settings.data && (
          <Table aria-label="In force">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Statute</TableHead>
                <TableHead scope="col">TAN or establishment code</TableHead>
                <TableHead scope="col">Bank</TableHead>
                <TableHead scope="col">BSR code</TableHead>
                <TableHead scope="col">From</TableHead>
                <TableHead scope="col">Revision</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(settings.data.inForce).map(([statute, s]) => (
                <TableRow key={statute}>
                  <TableCell>{statute}</TableCell>
                  {s ? (
                    <>
                      <TableCell>{s.tan ?? s.establishmentCode}</TableCell>
                      <TableCell>{[s.bankName, s.bankBranch].filter(Boolean).join(', ')}</TableCell>
                      <TableCell>{s.bsrCode ?? '—'}</TableCell>
                      <TableCell>{formatDate(s.effectiveFrom)}</TableCell>
                      <TableCell>{s.revision}</TableCell>
                    </>
                  ) : (
                    <TableCell colSpan={5}>Not recorded</TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {settings.data && settings.data.items.length > 0 && (
          <details className={FOLD}>
            <summary className={FOLD_SUMMARY}>All revisions ({settings.data.items.length})</summary>
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
          <FormGrid
            aria-label="New revision"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (!save.isPending) save.mutate();
            }}
          >
            <FormField>
              Statute
              <NativeSelect value={form.statute} onChange={set('statute')}>
                <option value="TDS">TDS</option>
                <option value="PF">PF</option>
                <option value="ESIC">ESIC</option>
              </NativeSelect>
            </FormField>
            <FormField>
              Effective from
              <Input type="date" value={form.effectiveFrom} onChange={set('effectiveFrom')} required />
            </FormField>
            <FormField>
              {form.statute === 'TDS' ? 'TAN' : 'Establishment code'}
              <Input value={form.identifier} onChange={set('identifier')} required maxLength={30} />
            </FormField>
            <FormField>
              Bank
              <Input value={form.bankName} onChange={set('bankName')} required maxLength={120} />
            </FormField>
            <FormField>
              Branch
              <Input value={form.bankBranch} onChange={set('bankBranch')} maxLength={120} />
            </FormField>
            <FormField>
              BSR code
              <Input value={form.bsrCode} onChange={set('bsrCode')} maxLength={7} />
            </FormField>
            <FormField>
              Reason
              <Input value={form.reason} onChange={set('reason')} required maxLength={500} />
            </FormField>
            <Button type="submit" disabled={save.isPending}>
              Record revision
            </Button>
          </FormGrid>
          <ErrorNote error={save.error} />
        </Section>
      )}
    </>
  );
}
