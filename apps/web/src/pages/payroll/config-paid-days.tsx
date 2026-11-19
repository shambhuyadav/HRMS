// Payroll configuration: the paid-day policy (FR-032; BR-049).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Section } from '../../ui';
import { ActivateControl, ATTENDANCE_BASIS, Choice, CONFIG_ACTIVATE, CONFIG_MANAGE, CONFIG_STATE, ISO_DAY, type PaidDayPolicy, UNITS } from './config';
import { Missing, Note } from './pickers';
import { Problem } from './problems';
import { H3, label, SCROLL, Status, useKeys } from './shared';

// ---- Paid-day policy (FR-032; BR-049) ----

export function PaidDayPolicySection() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const policies = useQuery({ queryKey: keys.paidDayPolicies, queryFn: () => api<{ items: PaidDayPolicy[] }>('/v1/payroll/paid-day-policies'), retry: retryTransient });
  const [note, setNote] = useState<string | null>(null);
  const activate = useMutation({
    mutationFn: (p: PaidDayPolicy) => api<PaidDayPolicy>(`/v1/payroll/paid-day-policies/${encodeURIComponent(p.id)}/activate`, { body: { expectedVersion: p.version } }),
    onSuccess: (p) => setNote(`Paid-day policy revision ${p.revision} is active from ${formatDate(p.effectiveFrom)}.`),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.paidDayPolicies }),
  });
  const activator = can(CONFIG_ACTIVATE);
  return (
    <Section title="Paid-day policy">
      <p className="hint">
        None exists by default. Until a policy is active, attendance never reduces paid days: absences are paid and reported for a documented resolution. Late flags and missing
        timesheets never reduce pay.
      </p>
      {policies.isPending && <p className="hint loading">Loading paid-day policies…</p>}
      {policies.error && <Problem error={policies.error} act="read" />}
      <Note text={note} />
      {policies.data && policies.data.items.length === 0 && <Empty>No paid-day policy is defined.</Empty>}
      {policies.data && policies.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Paid-day policies">
            <thead>
              <tr>
                <th>Revision</th>
                <th>Effective from</th>
                <th>Reduces paid days for</th>
                <th>Unpaid part of an absent day</th>
                <th>Unpaid part of a half day</th>
                <th>State</th>
                {activator && <th>Activation</th>}
              </tr>
            </thead>
            <tbody>
              {policies.data.items.map((p) => (
                <tr key={p.id}>
                  <td>{p.revision}</td>
                  <td>{formatDate(p.effectiveFrom)}</td>
                  <td>{label(ATTENDANCE_BASIS, p.attendanceBasis)}</td>
                  <td>{p.absentUnpaidUnits ?? '—'}</td>
                  <td>{p.halfDayUnpaidUnits ?? '—'}</td>
                  <td>
                    <Status map={CONFIG_STATE} code={p.state} />
                  </td>
                  {activator && (
                    <td>
                      <ActivateControl
                        state={p.state}
                        createdBy={p.createdBy}
                        name={`paid-day policy revision ${p.revision}`}
                        busy={activate.isPending}
                        onActivate={() => {
                          setNote(null);
                          activate.mutate(p);
                        }}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Problem error={activate.error} act="policy-activate" />
      {can(CONFIG_MANAGE) && <PolicyForm />}
    </Section>
  );
}

function PolicyForm() {
  const keys = useKeys();
  const qc = useQueryClient();
  const empty = { effectiveFrom: '', attendanceBasis: '', absentUnpaidUnits: '', halfDayUnpaidUnits: '' };
  const [f, setF] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<PaidDayPolicy>('/v1/payroll/paid-day-policies', { body }),
    onSuccess: (p) => {
      setF(empty);
      setNote(`Paid-day policy revision ${p.revision} saved as a draft: someone other than you activates it.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.paidDayPolicies }),
  });
  const set = (patch: Partial<typeof empty>) => setF((prev) => ({ ...prev, ...patch }));
  const reviewed = f.attendanceBasis === 'REVIEWED_ATTENDANCE';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    if (!ISO_DAY.test(f.effectiveFrom)) return setProblem('Give the date the policy takes effect.');
    if (!f.attendanceBasis) return setProblem('Choose what reduces paid days.');
    if (reviewed && !(UNITS.test(f.absentUnpaidUnits.trim()) && UNITS.test(f.halfDayUnpaidUnits.trim()))) {
      return setProblem('State the unpaid part of a reviewed absent day and of a half day, from 0 to 1 with at most two decimals.');
    }
    setProblem(null);
    setNote(null);
    create.reset();
    create.mutate({
      effectiveFrom: f.effectiveFrom,
      attendanceBasis: f.attendanceBasis,
      ...(reviewed ? { absentUnpaidUnits: f.absentUnpaidUnits.trim(), halfDayUnpaidUnits: f.halfDayUnpaidUnits.trim() } : {}),
    });
  };
  return (
    <form onSubmit={submit} aria-label="Define a paid-day policy" className="grid-form" style={{ marginTop: '0.75rem' }}>
      <h3 style={H3} className="wide">
        Define a paid-day policy
      </h3>
      <label>
        Effective from
        <input type="date" value={f.effectiveFrom} onChange={(e) => set({ effectiveFrom: e.target.value })} />
      </label>
      <Choice label="Reduces paid days for" value={f.attendanceBasis} onChange={(v) => set({ attendanceBasis: v })} options={ATTENDANCE_BASIS} />
      {reviewed && (
        <>
          <label>
            Unpaid part of a reviewed absent day (0 to 1)
            <input value={f.absentUnpaidUnits} onChange={(e) => set({ absentUnpaidUnits: e.target.value })} inputMode="decimal" maxLength={4} autoComplete="off" />
          </label>
          <label>
            Unpaid part of a reviewed half day (0 to 1)
            <input value={f.halfDayUnpaidUnits} onChange={(e) => set({ halfDayUnpaidUnits: e.target.value })} inputMode="decimal" maxLength={4} autoComplete="off" />
          </label>
        </>
      )}
      <div className="row">
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Saving…' : 'Save the policy as a draft'}
        </button>
      </div>
      <Missing text={problem} />
      <div className="wide">
        <Note text={note} />
        <Problem error={create.error} act="policy" />
      </div>
    </form>
  );
}
