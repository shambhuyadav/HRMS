// My ESS TN18 (Employee OWN context): one's own appraisals, self-entry and submission.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { api, ApiError, formatDate, isNotFound, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Item, Notice, NotPermitted, Section, StateBadge, When } from '../../ui';
import { CompetenciesTable, CompetencyEntriesTable, SectionsTable, SectionTexts } from './competency-views';
import { EntriesTable, GoalsTable } from './goals';
import { QueryProblem, Refusal } from './refusals';
import { ScoreForm } from './score-form';
import { type Appraisal, type AppraisalRow, decisionText, type EntryChanges, H3, inOwnContext, periodText, READ, READ_SELF, SCROLL, SELF_ASSESS, shown, SPACED, stepText, taskStatusText, useKeys, windowText } from './shared';

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
        <p className="hint">Your own appraisals only: your goals, where each stands, and your self-assessment. Manager and reviewer ratings and notes are never shown here, and no result is published to employees.</p>
        {list.isPending && <p className="hint loading">Loading your appraisals…</p>}
        <QueryProblem error={list.error} forbidden="Your Employee role cannot view appraisals." />
        {data && data.items.length === 0 && <Empty>You have no appraisals yet.</Empty>}
        {data && data.items.length > 0 && (
          <div style={SCROLL}>
            <table aria-label="My appraisals">
              <thead>
                <tr>
                  <th>Cycle</th>
                  <th>State</th>
                  <th>Where it stands</th>
                  <th>Goals</th>
                  <th>Open</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.cycle.code}: {r.cycle.name}
                    </td>
                    <td>
                      <StateBadge state={r.state} />
                    </td>
                    <td>{taskStatusText(r.taskStatus)}</td>
                    <td>{r.goalCount}</td>
                    <td>
                      <button type="button" className="secondary" aria-pressed={selected === r.id} onClick={() => setOpenId(r.id)}>
                        {selected === r.id ? 'Shown below' : `Show ${r.cycle.code}`}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
  if (query.isPending) return <Section title="Appraisal">{<p className="hint loading">Loading your appraisal…</p>}</Section>;
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
        {a.state === 'APPROVED' && !('finalRating' in a) && <p className="hint">Your appraisal is complete. No result is published to employees.</p>}
        {returned.map((r) => (
          <p key={r.revision} role="note">
            <Badge tone="warn">returned</Badge> Revision {r.revision} was returned <When at={r.returnedAt} />: {r.employeeMessage}
          </p>
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
              <p className="hint">
                Score each goal{a.competencies && a.competencies.length > 0 ? ' and competency' : ''} from 1 to 5, with a comment if you like
                {a.sections && a.sections.some((s) => s.filledBy.includes('EMPLOYEE')) ? ', and fill the sections this cycle asks of you' : ''}. Save as often as you need; submitting fixes this revision and
                sends it to your manager.
              </p>
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
              <div className="row" style={SPACED}>
                <button
                  type="button"
                  disabled={busy || dirty}
                  onClick={() => {
                    setNotice(null);
                    submit.mutate(a.version);
                  }}
                >
                  {submit.isPending ? 'Submitting…' : 'Submit my self-assessment'}
                </button>
                {dirty && <span className="hint">Save your changes before submitting.</span>}
              </div>
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
          <div key={r.revision} style={SPACED}>
            <h4 style={H3}>Revision {r.revision} (as submitted)</h4>
            <EntriesTable goals={a.goals} set={r.selfEntry!} label={`My self-entry of revision ${r.revision}`} />
          </div>
        ))}
      </Section>

      {a.decisions.length > 0 && (
        <Section title="History">
          <div style={SCROLL}>
            <table aria-label="My appraisal history">
              <thead>
                <tr>
                  <th>Revision</th>
                  <th>Step</th>
                  <th>What happened</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {a.decisions.map((d, i) => (
                  <tr key={`${d.revision}-${d.step}-${i}`}>
                    <td>{d.revision}</td>
                    <td>{stepText(d.stage, d.level)}</td>
                    <td>{decisionText(d.decision, d.stage)}</td>
                    <td>
                      <When at={d.decidedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  );
}
