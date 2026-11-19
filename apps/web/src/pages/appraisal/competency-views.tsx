// An appraisal's competencies and sections as shown (FR-041, FR-042; I-86): indicators, scores, section texts and results.
import { readable } from '../../api';
import { Item } from '../../ui';
import { type Appraisal, type CompetencyEntry, type CompetencyItem, FLUSH, type ManagerRating, SCROLL, type SectionInfo, type SectionParty, type SectionText } from './shared';

// ---------------------------------------------------------------------------------------------------------
// FR-041 competencies and FR-042 sections (I-86): the copied competencies with their behavioural indicators, their
// scores as the server returned them, the section texts, and the results the formula combined
// ---------------------------------------------------------------------------------------------------------

/** The behavioural indicator of each proficiency level 1 to 5 (the F1 scale). */
export function IndicatorList({ item }: { item: Pick<CompetencyItem, 'name' | 'description' | 'indicators'> }) {
  return (
    <details>
      <summary>What each level means for {item.name}</summary>
      {item.description && <p style={FLUSH}>{item.description}</p>}
      <ol aria-label={`Levels of ${item.name}`} style={FLUSH}>
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
      <p className="hint" style={FLUSH}>
        {scoring && !scoring.competenciesAssessed && scoring.competencyWeightPercent === 0
          ? 'This cycle does not assess competencies: the result is the goal result alone.'
          : 'No competencies are mapped to this employee’s grade, so the result is the goal result alone.'}
      </p>
    );
  }
  const showManager = items.some((k) => k.managerRatingComplete !== undefined);
  return (
    <>
      <div style={SCROLL}>
        <table aria-label={label}>
          <thead>
            <tr>
              <th>#</th>
              <th>Competency</th>
              <th>Weight</th>
              <th>Self-entry</th>
              {showManager && <th>Manager rating</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((k) => (
              <tr key={k.id}>
                <td>{k.sequence}</td>
                <td>
                  {k.name} ({k.code})
                  <IndicatorList item={k} />
                </td>
                <td>{k.weight}</td>
                <td>{k.selfEntryComplete ? 'Entered' : 'Not entered'}</td>
                {showManager && <td>{k.managerRatingComplete === undefined ? '—' : k.managerRatingComplete ? 'Entered' : 'Not entered'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint" style={FLUSH}>
        Copied from the grade’s competency set when the appraisal was created, and fixed. Competency weights total {a.competencyWeightTotal ?? 100}
        {scoring ? `; the result combines goals ${scoring.goalWeightPercent}% and competencies ${scoring.competencyWeightPercent}%.` : '.'}
      </p>
    </>
  );
}

export function CompetencyEntriesTable({ items, entries, label }: { items: CompetencyItem[]; entries: CompetencyEntry[]; label: string }) {
  const itemOf = new Map(items.map((k) => [k.id, k]));
  if (entries.length === 0) return null;
  return (
    <div style={SCROLL}>
      <table aria-label={label}>
        <thead>
          <tr>
            <th>#</th>
            <th>Competency</th>
            <th>Score</th>
            <th>Comment</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.competencyId}>
              <td>{e.sequence}</td>
              <td>{itemOf.get(e.competencyId)?.name ?? '—'}</td>
              <td>{e.score ?? 'Not scored'}</td>
              <td>{e.comment ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
  if (items.length === 0) return <p className="hint">This cycle includes no additional sections.</p>;
  const party = (p: SectionParty) => (p === 'EMPLOYEE' ? 'the employee' : 'the manager');
  return (
    <div style={SCROLL}>
      <table aria-label={label}>
        <thead>
          <tr>
            <th>Section</th>
            <th>Meaning</th>
            <th>Filled by</th>
            <th>Employee part</th>
            <th>Manager part</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.code}>
              <td>{s.title}</td>
              <td>{s.meaning}</td>
              <td>{s.filledBy.map(party).join(' and ')}</td>
              <td>{s.selfEntryComplete === undefined ? '—' : s.selfEntryComplete ? 'Filled' : 'Not filled'}</td>
              <td>{s.managerEntryComplete === undefined ? '—' : s.managerEntryComplete ? 'Filled' : 'Not filled'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The I-86 results of a rating: G, C, the split and the weighted result the formula gives (FORMULA mode: the final rating). */
export function RatingResults({ rating }: { rating: ManagerRating }) {
  return (
    <p style={FLUSH}>
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
