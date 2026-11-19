// Run extras: the rerun check and members left out of a draft run.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, type EmployeeHit } from '../../api';
import { Section } from '../../ui';
import { EmployeePicker, Missing, Note, person } from './pickers';
import { Problem } from './problems';
import { TEXTAREA, useKeys } from './shared';
import type { RunDetail } from './types';

// =========================================================================================================
// Run extras: rerun check, members left out of a draft
// =========================================================================================================

interface VerifyResult {
  identical: boolean;
  records: number;
  lines: number;
  lineDifferences: number;
  totalDifferences: number;
  paidDayDifferences: number;
  complete: boolean;
  nextAfter: string | null;
}

export function RunVerify({ run }: { run: RunDetail }) {
  const [differs, setDiffers] = useState(false);
  const verify = useMutation({
    mutationFn: (after: string | null) => api<VerifyResult>(`/v1/payroll/runs/${encodeURIComponent(run.id)}/verify${after ? `?after=${encodeURIComponent(after)}` : ''}`, { method: 'POST' }),
    onSuccess: (r, after) => setDiffers((prior) => (after ? prior : false) || !r.identical),
  });
  const r = verify.data;
  const nextAfter = r && !r.complete ? r.nextAfter : null;
  return (
    <Section title="Rerun check">
      <p className="hint">Recalculates every record of this revision from its stored snapshot and compares the results with what is stored. Nothing is changed.</p>
      <div className="row">
        <button type="button" className="secondary" disabled={verify.isPending} onClick={() => verify.mutate(nextAfter)}>
          {verify.isPending ? 'Checking…' : nextAfter ? 'Continue the check' : 'Check by recalculating'}
        </button>
      </div>
      {r && (
        <p role="status" className={r.identical ? 'ok' : 'error'}>
          {`This pass checked ${r.records} records and ${r.lines} lines: ${
            r.identical ? 'identical to the stored results' : `differences found (${r.lineDifferences} lines, ${r.totalDifferences} totals, ${r.paidDayDifferences} paid-day counts)`
          }.${r.complete ? (differs ? ' The rerun found differences: report this to the payroll administrator.' : ' The rerun gives identical results for the whole revision.') : ' The check stopped at its time limit: continue it.'}`}
        </p>
      )}
      <Problem error={verify.error} act="verify" />
    </Section>
  );
}

export function MemberExclusion({ run }: { run: RunDetail }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<EmployeeHit[]>([]);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const exclude = useMutation({
    mutationFn: (body: { employeeIds: string[]; reason: string; expectedVersion: number }) => api<RunDetail>(`/v1/payroll/runs/${encodeURIComponent(run.id)}/exclusions`, { body }),
    onSuccess: (r) => {
      setChosen([]);
      setReason('');
      setOpen(false);
      setNote(`Left out of this revision: ${r.members.excluded} in all; ${r.members.included} members remain.`);
    },
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: keys.runAll }), qc.invalidateQueries({ queryKey: keys.runsAll })]),
  });
  if (!open) {
    return (
      <div>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setNote(null);
            setOpen(true);
          }}
        >
          Leave members out of this draft
        </button>
        <Note text={note} />
      </div>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (exclude.isPending) return;
    if (chosen.length === 0 || !reason.trim()) return setProblem('Choose who is left out and give the reason.');
    setProblem(null);
    exclude.reset();
    exclude.mutate({ employeeIds: chosen.map((x) => x.id), reason: reason.trim(), expectedVersion: run.version });
  };
  return (
    <form onSubmit={submit} aria-label="Leave members out of this draft" className="grid-form">
      <EmployeePicker title="Member to leave out" value={null} onChange={(e) => e && setChosen(chosen.some((x) => x.id === e.id) ? chosen : [...chosen, e])} />
      {chosen.length > 0 && (
        <ul className="wide" aria-label="Members to leave out">
          {chosen.map((x) => (
            <li key={x.id}>
              {person(x)}{' '}
              <button type="button" className="link" onClick={() => setChosen(chosen.filter((y) => y.id !== x.id))} aria-label={`Keep ${person(x)}`}>
                Keep
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="wide">
        Why they are left out
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
      </label>
      <div className="row">
        <button type="submit" disabled={exclude.isPending}>
          {exclude.isPending ? 'Saving…' : 'Leave them out'}
        </button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <Missing text={problem} />
      <div className="wide">
        <Problem error={exclude.error} act="exclude" />
      </div>
    </form>
  );
}
