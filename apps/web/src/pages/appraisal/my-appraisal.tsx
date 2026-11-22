// My ESS TN18 (Employee OWN context): one's own appraisals, self-entry and submission.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, formatDate, isNotFound, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, Notice, NotPermitted, Section, StateBadge, WarningNote, When } from '../../ui';
import { CompetenciesTable, CompetencyEntriesTable, SectionsTable, SectionTexts } from './competency-views';
import { EntriesTable, GoalsTable } from './goals';
import { QueryProblem, Refusal } from './refusals';
import { ScoreForm } from './score-form';
import { type Appraisal, type AppraisalRow, decisionText, type EntryChanges, inOwnContext, periodText, READ, READ_SELF, SELF_ASSESS, shown, stepText, taskStatusText, useKeys, windowText } from './shared';

// ---------------------------------------------------------------------------------------------------------
// My ESS TN18 (Employee OWN context): own goals and task status, own self-entry and submission
// ---------------------------------------------------------------------------------------------------------

function OwnContextNote({ children }: { children: ReactNode }) {
  return (
    <Section title="My appraisal">
      <Empty>{children}</Empty>
    </Section>
  );
}

export function MyAppraisalsPanel() {
  const { me, can } = useSession();
  if (!me) return <OwnContextNote>Loading your role…</OwnContextNote>;
  if (!inOwnContext(me)) return <OwnContextNote>Your own appraisal is shown in your Employee role. Switch to it to see your goals and enter your self-assessment.</OwnContextNote>;
  if (!can(READ) && !can(READ_SELF)) {
    return (
      <Section title="My appraisal">
        <NotPermitted>Your Employee role does not include appraisals yet; contact HR.</NotPermitted>
      </Section>
    );
  }
  return <OwnAppraisals />;
}

function OwnAppraisals() {
  const keys = useKeys();
  const list = useQuery({ queryKey: keys.mineList, queryFn: () => api<{ items: AppraisalRow[] }>('/v1/me/appraisals'), retry: retryTransient });
  const [openId, setOpenId] = useState<string | null>(null);
  const data = shown(list);
  const selected = openId ?? data?.items[0]?.id ?? null;
  return (
    <div className="stack">
      <Section title="My appraisal">
        <Hint>Your own appraisals only: your goals, where each stands, and your self-assessment. Manager and reviewer ratings and notes are never shown here, and no result is published to employees.</Hint>
        {list.isPending && <LoadingLine>Loading your appraisals…</LoadingLine>}
        <QueryProblem error={list.error} forbidden="Your Employee role cannot view appraisals." />
        {data && data.items.length === 0 && <Empty>You have no appraisals yet.</Empty>}
        {data && data.items.length > 0 && (
          <Table aria-label="My appraisals">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Cycle</TableHead>
                <TableHead scope="col">State</TableHead>
                <TableHead scope="col">Where it stands</TableHead>
                <TableHead scope="col">Goals</TableHead>
                <TableHead scope="col">Open</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    {r.cycle.code}: {r.cycle.name}
                  </TableCell>
                  <TableCell>
                    <StateBadge state={r.state} />
                  </TableCell>
                  <TableCell>{taskStatusText(r.taskStatus)}</TableCell>
                  <TableCell>{r.goalCount}</TableCell>
                  <RowActionsCell>
                    <RowActions>
                      <Button type="button" variant="outline" size="sm" aria-pressed={selected === r.id} onClick={() => setOpenId(r.id)}>
                        {selected === r.id ? 'Shown below' : `Show ${r.cycle.code}`}
                      </Button>
                    </RowActions>
                  </RowActionsCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
      {selected && <OwnAppraisal key={selected} id={selected} />}
    </div>
  );
}

function OwnAppraisal({ id }: { id: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: keys.own(id), queryFn: () => api<Appraisal>(`/v1/me/appraisals/${id}`), retry: retryTransient });
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.mine });
  const save = useMutation({
    mutationFn: (body: EntryChanges & { expectedVersion: number }) => api<Appraisal>(`/v1/me/appraisals/${id}/self-entry`, { method: 'PUT', body }),
    onSuccess: () => {
      setNotice({ text: 'Self-entry saved. Submit it when every goal has a score.', ok: true });
      refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'STALE_VERSION' || e.code === 'INVALID_STATE' || e.code === 'UNKNOWN_GOAL')) refresh();
    },
  });
  const submit = useMutation({
    mutationFn: (expectedVersion: number) => api<Appraisal>(`/v1/me/appraisals/${id}/submit`, { body: { expectedVersion } }),
    onSuccess: (view) => {
      setNotice({
        text: `Submitted. It now waits for the manager rating${view.pending?.with.displayName ? ` by ${view.pending.with.displayName}` : ''}.`,
        ok: true,
      });
      refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'STALE_VERSION' || e.code === 'INVALID_STATE')) refresh();
    },
  });
  const a = shown(query);
  if (query.isPending) return <Section title="Appraisal">{<LoadingLine>Loading your appraisal…</LoadingLine>}</Section>;
  if (!a) {
    return (
      <Section title="Appraisal">
        {isNotFound(query.error) ? <Empty>This appraisal is not available.</Empty> : <QueryProblem error={query.error} forbidden="Your Employee role cannot view appraisals." />}
      </Section>
    );
  }
  const working = a.revisions.find((r) => r.revision === a.revision);
  const selfWindow = a.windows.selfEntry;
  const editable = (a.state === 'DRAFT' || a.state === 'RETURNED') && working?.state === 'DRAFT';
  const busy = save.isPending || submit.isPending;
  const returned = a.revisions.filter((r) => r.employeeMessage);
  const earlier = a.revisions.filter((r) => r.revision !== a.revision && r.selfEntry);
  return (
    <div className="stack">
      <Section title={`Appraisal ${a.cycle.code}: ${a.cycle.name}`}>
        <Notice notice={notice} />
        <dl className="kv">
          <Item term="Period">{periodText(a.cycle)}</Item>
          <Item term="State">
            <StateBadge state={a.state} />
          </Item>
          <Item term="Where it stands">{taskStatusText(a.taskStatus)}</Item>
          <Item term="Revision">{a.revision}</Item>
          {a.pending && (
            <Item term="Waiting for">
              {stepText(a.pending.stage, a.pending.level)}
              {a.pending.with.displayName ? `: ${a.pending.with.displayName}` : ''}
            </Item>
          )}
          <Item term="Self-entry window">
            {windowText(selfWindow)}
            {selfWindow?.exceptionUntil ? `; exception through ${formatDate(selfWindow.exceptionUntil)}` : ''}
          </Item>
          {'finalRating' in a && a.finalRating !== null && a.finalRating !== undefined && <Item term="Published result">{a.finalRating}</Item>}
        </dl>
        {a.state === 'APPROVED' && !('finalRating' in a) && <Hint>Your appraisal is complete. No result is published to employees.</Hint>}
        {returned.map((r) => (
          <WarningNote key={r.revision} badge="returned">
            Revision {r.revision} was returned <When at={r.returnedAt} />: {r.employeeMessage}
          </WarningNote>
        ))}
      </Section>

      <Section title="My goals">
        <GoalsTable a={a} label="My goals" />
      </Section>

      {a.competencies !== undefined && a.competencies.length > 0 && (
        <Section title="My competencies">
          <CompetenciesTable a={a} label="My competencies" />
        </Section>
      )}

      {a.sections !== undefined && a.sections.length > 0 && (
        <Section title="Sections in this cycle">
          <SectionsTable a={a} label="Sections in this cycle" />
        </Section>
      )}

      <Section title="My self-assessment">
        {editable && can(SELF_ASSESS) && a.goalReview?.required && !a.goalReview.reviewed ? (
          // FR-041 KRA review (I-77 item 3): the goals take effect once reviewed; the server refuses entries before that.
          <p role="note">Your goals are waiting for their review. Once they have been reviewed they take effect, and you can enter your self-assessment.</p>
        ) : editable && can(SELF_ASSESS) ? (
          selfWindow?.entryAllowed ? (
            <>
              <Hint>
                Score each goal{a.competencies && a.competencies.length > 0 ? ' and competency' : ''} from 1 to 5, with a comment if you like
                {a.sections && a.sections.some((s) => s.filledBy.includes('EMPLOYEE')) ? ', and fill the sections this cycle asks of you' : ''}. Save as often as you need; submitting fixes this revision and
                sends it to your manager.
              </Hint>
              <ScoreForm
                key={`${a.id}:${a.version}`}
                goals={a.goals}
                saved={working?.selfEntry}
                label="My self-assessment"
                saveLabel="Save my self-assessment"
                busy={busy}
                hiddenSaved={() => false}
                competencies={a.competencies}
                sections={{ party: 'EMPLOYEE', items: a.sections ?? [] }}
                onDirty={setDirty}
                onSave={(changes) => {
                  setNotice(null);
                  save.mutate({ ...changes, expectedVersion: a.version });
                }}
              >
                <Refusal error={save.error} action="self-entry" />
              </ScoreForm>
              <ButtonRow className="mt-3">
                <Button
                  type="button"
                  disabled={busy || dirty}
                  onClick={() => {
                    setNotice(null);
                    submit.mutate(a.version);
                  }}
                >
                  {submit.isPending ? 'Submitting…' : 'Submit my self-assessment'}
                </Button>
                {dirty && <Hint as="span">Save your changes before submitting.</Hint>}
              </ButtonRow>
              <Refusal error={submit.error} action="submit" />
            </>
          ) : (
            <p role="note">
              The self-entry window is not open today ({windowText(selfWindow).replace(/^Not /, 'not ')}) and no exception is recorded, so entries are not accepted. Ask HR if you need an exception.
            </p>
          )
        ) : working?.selfEntry ? (
          <>
            <EntriesTable goals={a.goals} set={working.selfEntry} label={`My self-entry of revision ${a.revision}`} />
            <CompetencyEntriesTable items={a.competencies ?? []} entries={working.selfEntry.competencies ?? []} label={`My competency self-entry of revision ${a.revision}`} />
            <SectionTexts sections={a.sections ?? []} texts={working.selfEntry.sections} label={`My sections of revision ${a.revision}`} />
          </>
        ) : (
          <Empty>{editable ? 'Your Employee role cannot enter a self-assessment.' : 'Your self-assessment is not open for changes.'}</Empty>
        )}
        {earlier.map((r) => (
          <div key={r.revision} className="mt-3">
            <CardSubheading level={4}>Revision {r.revision} (as submitted)</CardSubheading>
            <EntriesTable goals={a.goals} set={r.selfEntry!} label={`My self-entry of revision ${r.revision}`} />
          </div>
        ))}
      </Section>

      {a.decisions.length > 0 && (
        <Section title="History">
          <Table aria-label="My appraisal history">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Revision</TableHead>
                <TableHead scope="col">Step</TableHead>
                <TableHead scope="col">What happened</TableHead>
                <TableHead scope="col">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {a.decisions.map((d, i) => (
                <TableRow key={`${d.revision}-${d.step}-${i}`}>
                  <TableCell>{d.revision}</TableCell>
                  <TableCell>{stepText(d.stage, d.level)}</TableCell>
                  <TableCell>{decisionText(d.decision, d.stage)}</TableCell>
                  <TableCell>
                    <When at={d.decidedAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}
    </div>
  );
}
