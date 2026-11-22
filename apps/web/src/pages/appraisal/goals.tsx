// Appraisal goals: the goal editor (FR-041) and the read-only goals and scores tables.
import { ButtonRow, FormField, FramedFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Empty } from '../../ui';
import { UnannouncedError } from './refusals';
import { type Appraisal, enteredText, type EntrySet, FIELD_ROW, type Goal, type GoalInput, WHOLE } from './shared';

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
    <div className="col-span-full flex flex-col gap-2">
      {drafts.length === 0 && <Empty>No goals yet.</Empty>}
      {drafts.map((d, i) => (
        <FramedFieldset key={d.key} legend={<>Goal {i + 1}</>} aria-label={`Goal ${i + 1}`}>
          <div className={FIELD_ROW}>
            <FormField className="w-auto">
              Sequence
              <Input inputMode="numeric" value={d.sequence} maxLength={3} onChange={(e) => set(d.key, { sequence: e.target.value })} />
            </FormField>
            <FormField className="w-auto">
              Weight
              <Input inputMode="numeric" value={d.weight} maxLength={3} onChange={(e) => set(d.key, { weight: e.target.value })} />
            </FormField>
            <Button type="button" variant="outline" onClick={() => onChange(drafts.filter((x) => x.key !== d.key))}>
              Remove goal {i + 1}
            </Button>
          </div>
          <FormField>
            Description
            <Input value={d.description} maxLength={500} onChange={(e) => set(d.key, { description: e.target.value })} />
          </FormField>
          <FormField>
            Target (optional)
            <Textarea rows={2} value={d.target} maxLength={1000} onChange={(e) => set(d.key, { target: e.target.value })} />
          </FormField>
        </FramedFieldset>
      ))}
      <ButtonRow>
        <Button type="button" variant="outline" onClick={add} disabled={drafts.length >= 100}>
          Add a goal
        </Button>
      </ButtonRow>
      <Hint role="status" className="m-0">
        Weights entered: {total} of 100. They must total exactly 100 before the employee can submit; the server checks this at submission.
      </Hint>
    </div>
  );
}

export function GoalsTable({ a, label }: { a: Appraisal; label: string }) {
  const showManager = a.goals.some((g) => g.managerRatingComplete !== undefined);
  const total = (
    <>
      Goal weights total {a.goalWeightTotal}
      {a.goalWeightTotal === 100 ? '.' : '; they must total exactly 100 before the appraisal can be submitted.'}
    </>
  );
  return (
    <>
      {a.goals.length === 0 ? (
        <Empty>No goals have been set yet.</Empty>
      ) : (
        <Table aria-label={label}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">#</TableHead>
              <TableHead scope="col">Goal</TableHead>
              <TableHead scope="col">Target</TableHead>
              <TableHead scope="col">Weight</TableHead>
              <TableHead scope="col">Self-entry</TableHead>
              {showManager && <TableHead scope="col">Manager rating</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {a.goals.map((g) => (
              <TableRow key={g.id}>
                <TableCell>{g.sequence}</TableCell>
                <TableCell>{g.description}</TableCell>
                <TableCell>{g.target ?? '—'}</TableCell>
                <TableCell>{g.weight}</TableCell>
                <TableCell>{g.selfEntryComplete ? 'Entered' : 'Not entered'}</TableCell>
                {showManager && <TableCell>{enteredText(g.managerRatingComplete)}</TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {a.goalWeightTotal === 100 ? <Hint className="m-0">{total}</Hint> : <UnannouncedError className="m-0">{total}</UnannouncedError>}
    </>
  );
}

/** Scores and comments of one stage, exactly as the server returned them. */
export function EntriesTable({ goals, set, label }: { goals: Goal[]; set: EntrySet; label: string }) {
  const goalOf = new Map(goals.map((g) => [g.id, g]));
  return (
    <>
      <Table aria-label={label}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">#</TableHead>
            <TableHead scope="col">Goal</TableHead>
            <TableHead scope="col">Score</TableHead>
            <TableHead scope="col">Comment</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {set.entries.map((e) => (
            <TableRow key={e.goalId}>
              <TableCell>{e.sequence}</TableCell>
              <TableCell>{goalOf.get(e.goalId)?.description ?? '—'}</TableCell>
              <TableCell>{e.score ?? 'Not scored'}</TableCell>
              <TableCell>{e.comment ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {set.entries.length === 0 && <Empty>No scores entered.</Empty>}
      {set.comment && <p className="m-0">Overall comment: {set.comment}</p>}
    </>
  );
}
