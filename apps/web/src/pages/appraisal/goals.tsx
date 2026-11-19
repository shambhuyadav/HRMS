// Appraisal goals: the goal editor (FR-041) and the read-only goals and scores tables.
import { Empty } from '../../ui';
import { type Appraisal, type EntrySet, FLUSH, type Goal, type GoalInput, GROUP, SCROLL, TEXTAREA, WHOLE } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Goals: the editor (FR-041) and read-only tables
// ---------------------------------------------------------------------------------------------------------
export interface GoalDraft {
  key: number;
  sequence: string;
  description: string;
  target: string;
  weight: string;
}
export const draftsOf = (goals: Goal[]): GoalDraft[] =>
  goals.map((g, i) => ({ key: i + 1, sequence: String(g.sequence), description: g.description, target: g.target ?? '', weight: String(g.weight) }));
export const wholeIn = (text: string, min: number, max: number) => WHOLE.test(text.trim()) && Number(text) >= min && Number(text) <= max;

/** The goals as the API takes them, or what to correct first (the server checks every rule again). */
export function goalsBody(drafts: GoalDraft[]): { goals: GoalInput[] } | { problem: string } {
  const goals: GoalInput[] = [];
  for (const [i, d] of drafts.entries()) {
    const n = i + 1;
    if (!wholeIn(d.sequence, 1, 100)) return { problem: `Goal ${n}: the sequence is a whole number from 1 to 100.` };
    const description = d.description.trim();
    if (!description) return { problem: `Goal ${n}: enter a description.` };
    if (!wholeIn(d.weight, 1, 100)) return { problem: `Goal ${n}: the weight is a whole number from 1 to 100.` };
    const target = d.target.trim();
    goals.push({ sequence: Number(d.sequence), description, target: target === '' ? null : target, weight: Number(d.weight) });
  }
  return { goals };
}

export function GoalsEditor({ drafts, onChange }: { drafts: GoalDraft[]; onChange: (next: GoalDraft[]) => void }) {
  const total = drafts.reduce((s, d) => s + (wholeIn(d.weight, 1, 100) ? Number(d.weight) : 0), 0);
  const set = (key: number, patch: Partial<GoalDraft>) => onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const add = () => {
    const key = drafts.reduce((m, d) => Math.max(m, d.key), 0) + 1;
    const sequence = drafts.reduce((m, d) => Math.max(m, wholeIn(d.sequence, 1, 100) ? Number(d.sequence) : 0), 0) + 1;
    onChange([...drafts, { key, sequence: String(Math.min(sequence, 100)), description: '', target: '', weight: '' }]);
  };
  return (
    <div className="wide">
      {drafts.length === 0 && <Empty>No goals yet.</Empty>}
      {drafts.map((d, i) => (
        <fieldset key={d.key} style={GROUP} aria-label={`Goal ${i + 1}`}>
          <legend>Goal {i + 1}</legend>
          <div className="row">
            <label>
              Sequence
              <input inputMode="numeric" value={d.sequence} maxLength={3} onChange={(e) => set(d.key, { sequence: e.target.value })} />
            </label>
            <label>
              Weight
              <input inputMode="numeric" value={d.weight} maxLength={3} onChange={(e) => set(d.key, { weight: e.target.value })} />
            </label>
            <button type="button" className="secondary" onClick={() => onChange(drafts.filter((x) => x.key !== d.key))}>
              Remove goal {i + 1}
            </button>
          </div>
          <label>
            Description
            <input value={d.description} maxLength={500} onChange={(e) => set(d.key, { description: e.target.value })} />
          </label>
          <label>
            Target (optional)
            <textarea rows={2} value={d.target} maxLength={1000} onChange={(e) => set(d.key, { target: e.target.value })} style={TEXTAREA} />
          </label>
        </fieldset>
      ))}
      <div className="row">
        <button type="button" className="secondary" onClick={add} disabled={drafts.length >= 100}>
          Add a goal
        </button>
      </div>
      <p className="hint" role="status">
        Weights entered: {total} of 100. They must total exactly 100 before the employee can submit; the server checks this at submission.
      </p>
    </div>
  );
}

export function GoalsTable({ a, label }: { a: Appraisal; label: string }) {
  const showManager = a.goals.some((g) => g.managerRatingComplete !== undefined);
  return (
    <>
      {a.goals.length === 0 ? (
        <Empty>No goals have been set yet.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label={label}>
            <thead>
              <tr>
                <th>#</th>
                <th>Goal</th>
                <th>Target</th>
                <th>Weight</th>
                <th>Self-entry</th>
                {showManager && <th>Manager rating</th>}
              </tr>
            </thead>
            <tbody>
              {a.goals.map((g) => (
                <tr key={g.id}>
                  <td>{g.sequence}</td>
                  <td>{g.description}</td>
                  <td>{g.target ?? '—'}</td>
                  <td>{g.weight}</td>
                  <td>{g.selfEntryComplete ? 'Entered' : 'Not entered'}</td>
                  {showManager && <td>{g.managerRatingComplete === undefined ? '—' : g.managerRatingComplete ? 'Entered' : 'Not entered'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={a.goalWeightTotal === 100 ? 'hint' : 'error'} style={FLUSH}>
        Goal weights total {a.goalWeightTotal}
        {a.goalWeightTotal === 100 ? '.' : '; they must total exactly 100 before the appraisal can be submitted.'}
      </p>
    </>
  );
}

/** Scores and comments of one stage, exactly as the server returned them. */
export function EntriesTable({ goals, set, label }: { goals: Goal[]; set: EntrySet; label: string }) {
  const goalOf = new Map(goals.map((g) => [g.id, g]));
  return (
    <>
      <div style={SCROLL}>
        <table aria-label={label}>
          <thead>
            <tr>
              <th>#</th>
              <th>Goal</th>
              <th>Score</th>
              <th>Comment</th>
            </tr>
          </thead>
          <tbody>
            {set.entries.map((e) => (
              <tr key={e.goalId}>
                <td>{e.sequence}</td>
                <td>{goalOf.get(e.goalId)?.description ?? '—'}</td>
                <td>{e.score ?? 'Not scored'}</td>
                <td>{e.comment ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {set.entries.length === 0 && <Empty>No scores entered.</Empty>}
      {set.comment && <p style={FLUSH}>Overall comment: {set.comment}</p>}
    </>
  );
}
