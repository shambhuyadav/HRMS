// The score form: the manager's rating and the employee's own self-entry, per goal and competency, with the sections.
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { ButtonRow, FormField, FramedFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { Notice } from '../../ui';
import { IndicatorList } from './competency-views';
import { type CompetencyItem, type EntryChanges, type EntrySet, FIELD_ROW, type Goal, SCORES, type SectionInfo, type SectionParty } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Scores per goal (integer 1 to 5) with comments: the manager's rating and the employee's own self-entry
// ---------------------------------------------------------------------------------------------------------
interface ScoreDraft {
  score: string;
  comment: string;
}

/**
 * Only goals whose score or comment changed here are sent (a goal left alone keeps what was saved, which matters
 * when the saved values are not shown to the selected role), and the overall comment only when it changed.
 */
export function ScoreForm({
  goals,
  saved,
  label,
  saveLabel,
  busy,
  hiddenSaved,
  overall,
  competencies,
  sections,
  onDirty,
  onSave,
  children,
}: {
  goals: Goal[];
  /** The saved scores, when the server returned them to this caller. */
  saved: EntrySet | undefined;
  label: string;
  saveLabel: string;
  busy: boolean;
  /** Goals whose score is saved but not returned to this caller. */
  hiddenSaved: (g: Goal) => boolean;
  /** A MANUAL cycle's rating (FR-042; I-77 item 4): the saved overall rating; absent when the cycle rates by formula. */
  overall?: { saved: number | null } | undefined;
  /** FR-041 / I-86: the appraisal's competencies, scored like goals. */
  competencies?: CompetencyItem[] | undefined;
  /** FR-042: this party's part of the sections the cycle includes. */
  sections?: { party: SectionParty; items: SectionInfo[] } | undefined;
  onDirty: (dirty: boolean) => void;
  onSave: (changes: EntryChanges) => void;
  children?: ReactNode;
}) {
  const initial = useMemo(() => {
    const out: Record<string, ScoreDraft> = {};
    for (const g of goals) {
      const e = saved?.entries.find((x) => x.goalId === g.id);
      out[g.id] = { score: e?.score === null || e?.score === undefined ? '' : String(e.score), comment: e?.comment ?? '' };
    }
    return out;
  }, [goals, saved]);
  const competencyItems = competencies ?? [];
  const initialCompetencies = useMemo(() => {
    const out: Record<string, ScoreDraft> = {};
    for (const k of competencies ?? []) {
      const e = saved?.competencies?.find((x) => x.competencyId === k.id);
      out[k.id] = { score: e?.score === null || e?.score === undefined ? '' : String(e.score), comment: e?.comment ?? '' };
    }
    return out;
  }, [competencies, saved]);
  const sectionItems = (sections?.items ?? []).filter((s) => s.filledBy.includes(sections!.party));
  const initialTexts = useMemo(() => {
    const out: Record<string, string> = {};
    for (const s of sections?.items ?? []) out[s.code] = saved?.sections?.find((x) => x.section === s.code)?.text ?? '';
    return out;
  }, [sections, saved]);
  const [competencyDrafts, setCompetencyDrafts] = useState<Record<string, ScoreDraft>>(initialCompetencies);
  const [texts, setTexts] = useState<Record<string, string>>(initialTexts);
  const changedCompetencies = competencyItems.filter((k) => {
    const a = competencyDrafts[k.id];
    const b = initialCompetencies[k.id];
    return !!a && !!b && (a.score !== b.score || a.comment.trim() !== b.comment.trim());
  });
  const changedSections = sectionItems.filter((s) => (texts[s.code] ?? '').trim() !== (initialTexts[s.code] ?? '').trim());
  const setCompetency = (id: string, patch: Partial<ScoreDraft>) => setCompetencyDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { score: '', comment: '' }), ...patch } }));
  const initialComment = saved?.comment ?? '';
  const [drafts, setDrafts] = useState<Record<string, ScoreDraft>>(initial);
  const [comment, setComment] = useState(initialComment);
  const [problem, setProblem] = useState<string | null>(null);
  const changed = goals.filter((g) => {
    const a = drafts[g.id];
    const b = initial[g.id];
    return !!a && !!b && (a.score !== b.score || a.comment.trim() !== b.comment.trim());
  });
  const commentChanged = comment.trim() !== initialComment.trim();
  const initialOverall = overall?.saved === null || overall?.saved === undefined ? '' : String(overall.saved);
  const [overallDraft, setOverallDraft] = useState(initialOverall);
  const overallChanged = overall !== undefined && overallDraft !== initialOverall;
  const dirty = changed.length > 0 || commentChanged || overallChanged || changedCompetencies.length > 0 || changedSections.length > 0;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const set = (goalId: string, patch: Partial<ScoreDraft>) => setDrafts((prev) => ({ ...prev, [goalId]: { ...(prev[goalId] ?? { score: '', comment: '' }), ...patch } }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!dirty) {
      setProblem('Nothing has changed since the last save.');
      return;
    }
    setProblem(null);
    const entries = changed.map((g) => {
      const d = drafts[g.id]!;
      const text = d.comment.trim();
      return { goalId: g.id, score: d.score === '' ? null : Number(d.score), comment: text === '' ? null : text };
    });
    const text = comment.trim();
    const competencyChanges = changedCompetencies.map((k) => {
      const d = competencyDrafts[k.id]!;
      const note = d.comment.trim();
      return { competencyId: k.id, score: d.score === '' ? null : Number(d.score), comment: note === '' ? null : note };
    });
    const sectionChanges = changedSections.map((s) => {
      const body = (texts[s.code] ?? '').trim();
      return { section: s.code, text: body === '' ? null : body };
    });
    onSave({
      entries,
      ...(competencyChanges.length > 0 ? { competencies: competencyChanges } : {}),
      ...(sectionChanges.length > 0 ? { sections: sectionChanges } : {}),
      ...(commentChanged ? { comment: text === '' ? null : text } : {}),
      ...(overallChanged ? { overallRating: overallDraft === '' ? null : Number(overallDraft) } : {}),
    });
  };
  return (
    <form aria-label={label} onSubmit={submit} noValidate className="mt-3 flex flex-col gap-3">
      {goals.map((g) => {
        const d = drafts[g.id] ?? { score: '', comment: '' };
        return (
          <FramedFieldset
            key={g.id}
            legend={
              <>
                Goal {g.sequence}: {g.description} (weight {g.weight})
              </>
            }
            aria-label={`Goal ${g.sequence}`}
          >
            {g.target && <Hint className="m-0">Target: {g.target}</Hint>}
            {hiddenSaved(g) && d.score === '' && <Hint className="m-0">A score is already saved for this goal but is not shown to the selected role; choosing a score here replaces it.</Hint>}
            <div className={FIELD_ROW}>
              <FormField className="w-auto">
                Score (1 to 5)
                <NativeSelect value={d.score} onChange={(e) => set(g.id, { score: e.target.value })}>
                  <option value="">Not scored</option>
                  {SCORES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
            </div>
            <FormField>
              Comment on goal {g.sequence} (optional)
              <Textarea rows={2} maxLength={2000} value={d.comment} onChange={(e) => set(g.id, { comment: e.target.value })} />
            </FormField>
          </FramedFieldset>
        );
      })}
      {competencyItems.map((k) => {
        const d = competencyDrafts[k.id] ?? { score: '', comment: '' };
        return (
          <FramedFieldset
            key={k.id}
            legend={
              <>
                Competency {k.sequence}: {k.name} (weight {k.weight})
              </>
            }
            aria-label={`Competency ${k.sequence}`}
          >
            <IndicatorList item={k} />
            <div className={FIELD_ROW}>
              <FormField className="w-auto">
                Score for {k.name} (1 to 5)
                <NativeSelect value={d.score} onChange={(e) => setCompetency(k.id, { score: e.target.value })}>
                  <option value="">Not scored</option>
                  {SCORES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
            </div>
            <FormField>
              Comment on {k.name} (optional)
              <Textarea rows={2} maxLength={2000} value={d.comment} onChange={(e) => setCompetency(k.id, { comment: e.target.value })} />
            </FormField>
          </FramedFieldset>
        );
      })}
      {sectionItems.map((s) => (
        <FormField key={s.code}>
          {s.title} (required in this cycle)
          <Hint as="span" className="block">
            {s.prompts[sections!.party] ?? s.meaning}
          </Hint>
          <Textarea rows={3} maxLength={4000} value={texts[s.code] ?? ''} onChange={(e) => setTexts((prev) => ({ ...prev, [s.code]: e.target.value }))} />
        </FormField>
      ))}
      {overall !== undefined && (
        <div className={FIELD_ROW}>
          <FormField className="w-auto">
            Overall rating (1 to 5)
            <NativeSelect value={overallDraft} onChange={(e) => setOverallDraft(e.target.value)}>
              <option value="">Not rated</option>
              {SCORES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <Hint as="span">This cycle rates manually: the overall rating becomes the final rating; the weighted result is kept beside it.</Hint>
        </div>
      )}
      <FormField>
        Overall comment (optional)
        <Textarea rows={3} maxLength={4000} value={comment} onChange={(e) => setComment(e.target.value)} />
      </FormField>
      {problem && <Notice notice={{ text: problem, ok: false }} />}
      <ButtonRow>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : saveLabel}
        </Button>
        {dirty && <Hint as="span">Unsaved changes</Hint>}
      </ButtonRow>
      {children}
    </form>
  );
}
