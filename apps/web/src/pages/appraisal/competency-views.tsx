// An appraisal's competencies and sections as shown (FR-041, FR-042; I-86): indicators, scores, section texts and results.
import { Hint } from '@/components/hint';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { readable } from '../../api';
import { Item } from '../../ui';
import { type Appraisal, type CompetencyEntry, type CompetencyItem, enteredText, filledText, type ManagerRating, type SectionInfo, type SectionParty, type SectionText } from './shared';

// ---------------------------------------------------------------------------------------------------------
// FR-041 competencies and FR-042 sections (I-86): the copied competencies with their behavioural indicators, their
// scores as the server returned them, the section texts, and the results the formula combined
// ---------------------------------------------------------------------------------------------------------

/** The behavioural indicator of each proficiency level 1 to 5 (the F1 scale). */
export function IndicatorList({ item }: { item: Pick<CompetencyItem, 'name' | 'description' | 'indicators'> }) {
  return (
    <details>
      <summary className="cursor-pointer">What each level means for {item.name}</summary>
      {item.description && <p className="m-0">{item.description}</p>}
      <ol aria-label={`Levels of ${item.name}`} className="m-0">
        {item.indicators.map((i) => (
          <li key={i.level} value={i.level}>
            {i.text}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function CompetenciesTable({ a, label }: { a: Appraisal; label: string }) {
  const items = a.competencies ?? [];
  const scoring = a.cycle.scoring;
  if (items.length === 0) {
    return (
      <Hint className="m-0">
        {scoring && !scoring.competenciesAssessed && scoring.competencyWeightPercent === 0
          ? 'This cycle does not assess competencies: the result is the goal result alone.'
          : 'No competencies are mapped to this employee’s grade, so the result is the goal result alone.'}
      </Hint>
    );
  }
  const showManager = items.some((k) => k.managerRatingComplete !== undefined);
  return (
    <>
      <Table aria-label={label}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">#</TableHead>
            <TableHead scope="col">Competency</TableHead>
            <TableHead scope="col">Weight</TableHead>
            <TableHead scope="col">Self-entry</TableHead>
            {showManager && <TableHead scope="col">Manager rating</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((k) => (
            <TableRow key={k.id}>
              <TableCell>{k.sequence}</TableCell>
              <TableCell>
                {k.name} ({k.code})
                <IndicatorList item={k} />
              </TableCell>
              <TableCell>{k.weight}</TableCell>
              <TableCell>{k.selfEntryComplete ? 'Entered' : 'Not entered'}</TableCell>
              {showManager && <TableCell>{enteredText(k.managerRatingComplete)}</TableCell>}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Hint className="m-0">
        Copied from the grade’s competency set when the appraisal was created, and fixed. Competency weights total {a.competencyWeightTotal ?? 100}
        {scoring ? `; the result combines goals ${scoring.goalWeightPercent}% and competencies ${scoring.competencyWeightPercent}%.` : '.'}
      </Hint>
    </>
  );
}

export function CompetencyEntriesTable({ items, entries, label }: { items: CompetencyItem[]; entries: CompetencyEntry[]; label: string }) {
  const itemOf = new Map(items.map((k) => [k.id, k]));
  if (entries.length === 0) return null;
  return (
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">#</TableHead>
          <TableHead scope="col">Competency</TableHead>
          <TableHead scope="col">Score</TableHead>
          <TableHead scope="col">Comment</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((e) => (
          <TableRow key={e.competencyId}>
            <TableCell>{e.sequence}</TableCell>
            <TableCell>{itemOf.get(e.competencyId)?.name ?? '—'}</TableCell>
            <TableCell>{e.score ?? 'Not scored'}</TableCell>
            <TableCell>{e.comment ?? '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function SectionTexts({ sections, texts, label }: { sections: SectionInfo[]; texts: SectionText[] | undefined; label: string }) {
  if (!texts || texts.length === 0) return null;
  const titleOf = new Map(sections.map((s) => [s.code, s.title]));
  return (
    <dl className="kv" aria-label={label}>
      {texts.map((t) => (
        <Item key={t.section} term={titleOf.get(t.section) ?? readable(t.section)}>
          {t.text ?? 'Not filled'}
        </Item>
      ))}
    </dl>
  );
}

/** FR-042 sections the cycle includes: meaning, who fills them and completion flags (never the texts). */
export function SectionsTable({ a, label }: { a: Appraisal; label: string }) {
  const items = a.sections ?? [];
  if (items.length === 0) return <Hint>This cycle includes no additional sections.</Hint>;
  const party = (p: SectionParty) => (p === 'EMPLOYEE' ? 'the employee' : 'the manager');
  return (
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Section</TableHead>
          <TableHead scope="col">Meaning</TableHead>
          <TableHead scope="col">Filled by</TableHead>
          <TableHead scope="col">Employee part</TableHead>
          <TableHead scope="col">Manager part</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((s) => (
          <TableRow key={s.code}>
            <TableCell>{s.title}</TableCell>
            <TableCell>{s.meaning}</TableCell>
            <TableCell>{s.filledBy.map(party).join(' and ')}</TableCell>
            <TableCell>{filledText(s.selfEntryComplete)}</TableCell>
            <TableCell>{filledText(s.managerEntryComplete)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The I-86 results of a rating: G, C, the split and the weighted result the formula gives (FORMULA mode: the final rating). */
export function RatingResults({ rating }: { rating: ManagerRating }) {
  return (
    <p className="m-0">
      Weighted manager result: <strong>{rating.weightedResult ?? 'not calculated yet (calculated when the rating is submitted)'}</strong>
      {rating.split && rating.goalResult && rating.competencyResult && (
        <>
          {' '}
          {`(${rating.split.goalWeightPercent}% goals at ${rating.goalResult}, ${rating.split.competencyWeightPercent}% competencies at ${rating.competencyResult})`}
        </>
      )}
      {!rating.split && rating.goalResult && <> (goals only)</>}
    </p>
  );
}
