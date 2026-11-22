// Run extras: the rerun check and members left out of a draft run.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ButtonRow, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api, type EmployeeHit } from '../../api';
import { Section } from '../../ui';
import { EmployeePicker, Missing, Note, person } from './pickers';
import { Problem } from './problems';
import { useKeys } from './shared';
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

/** The outcome of one pass of the rerun check, and of the whole check once it is complete. */
function verifyText(r: VerifyResult, differs: boolean): string {
  const pass = r.identical ? 'identical to the stored results' : `differences found (${r.lineDifferences} lines, ${r.totalDifferences} totals, ${r.paidDayDifferences} paid-day counts)`;
  let whole = ' The check stopped at its time limit: continue it.';
  if (r.complete) whole = differs ? ' The rerun found differences: report this to the payroll administrator.' : ' The rerun gives identical results for the whole revision.';
  return `This pass checked ${r.records} records and ${r.lines} lines: ${pass}.${whole}`;
}

/** The rerun check's button: checking, continuing a check cut short, or starting one. */
function verifyButtonText(pending: boolean, continuing: boolean): string {
  if (pending) return 'Checking…';
  return continuing ? 'Continue the check' : 'Check by recalculating';
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
      <Hint>Recalculates every record of this revision from its stored snapshot and compares the results with what is stored. Nothing is changed.</Hint>
      <ButtonRow>
        <Button type="button" variant="outline" disabled={verify.isPending} onClick={() => verify.mutate(nextAfter)}>
          {verifyButtonText(verify.isPending, Boolean(nextAfter))}
        </Button>
      </ButtonRow>
      {/* A status whether identical or not (announced politely): differences are a finding to report, not a failed action. */}
      {r && (
        <StatusNote tone={r.identical ? 'success' : 'error'} role="status">
          {verifyText(r, differs)}
        </StatusNote>
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
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setNote(null);
            setOpen(true);
          }}
        >
          Leave members out of this draft
        </Button>
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
    <FormGrid onSubmit={submit} aria-label="Leave members out of this draft">
      <EmployeePicker title="Member to leave out" value={null} onChange={(e) => e && setChosen(chosen.some((x) => x.id === e.id) ? chosen : [...chosen, e])} />
      {chosen.length > 0 && (
        <ul className="col-span-full" aria-label="Members to leave out">
          {chosen.map((x) => (
            <li key={x.id}>
              {person(x)}{' '}
              <Button type="button" variant="outline" size="sm" onClick={() => setChosen(chosen.filter((y) => y.id !== x.id))} aria-label={`Keep ${person(x)}`}>
                Keep
              </Button>
            </li>
          ))}
        </ul>
      )}
      <FormField className="col-span-full">
        Why they are left out
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} />
      </FormField>
      <ButtonRow>
        <Button type="submit" disabled={exclude.isPending}>
          {exclude.isPending ? 'Saving…' : 'Leave them out'}
        </Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)}>
          Close
        </Button>
      </ButtonRow>
      <Missing text={problem} />
      <div className="col-span-full">
        <Problem error={exclude.error} act="exclude" />
      </div>
    </FormGrid>
  );
}
