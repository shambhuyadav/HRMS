// Requisition views shared by the screens and the decision queue: the facts, budget check, decisions and revisions.
import { formatDate, readable } from '../../api';
import { Badge, Item, StateBadge, When } from '../../ui';
import { type BudgetCheck, budgetStatusText, DECISION_LABEL, type DecisionRecord, personLabel, REASON_TYPE_LABEL, type Requisition, type RequisitionRevision, SCROLL, stepText, userLabel } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Shared requisition views
// ---------------------------------------------------------------------------------------------------------

export function RequisitionFacts({ r }: { r: Requisition }) {
  return (
    <dl className="kv">
      <Item term="Reference">{r.code}</Item>
      <Item term="State">
        <StateBadge state={r.state} />
      </Item>
      <Item term="Position">{r.title}</Item>
      <Item term="Department">{r.department.name}</Item>
      <Item term="Location">{r.location.name}</Item>
      <Item term="Designation">{r.designation.name}</Item>
      <Item term="Employment type">{readable(r.employmentType)}</Item>
      <Item term="Vacancies">{r.vacancies}</Item>
      <Item term="New or replacement">{REASON_TYPE_LABEL[r.reasonType] ?? readable(r.reasonType)}</Item>
      <Item term="Target date">{formatDate(r.targetDate)}</Item>
      <Item term="Hiring manager">{personLabel(r.hiringManager)}</Item>
      <Item term="Requester">{personLabel(r.requester)}</Item>
      <Item term="Skills">{r.skills.length > 0 ? r.skills.join(', ') : 'None listed'}</Item>
      <Item term="Reason">{r.reason}</Item>
    </dl>
  );
}

/**
 * The budget check as the server worked it out; the figures only when the server sent them. What an exception needs
 * depends on where the requisition is: a draft needs its reason to be submitted; a submitted one needs the HR
 * approver's explicit approval of the reason it recorded, and one that recorded none cannot be approved as it stands.
 */
export function BudgetCheckText({ check, state, exceptionReason }: { check: BudgetCheck; state: string; exceptionReason: string | null }) {
  const status = check.budgetStatus;
  const within = status === 'WITHIN_BUDGET';
  const exception =
    state === 'DRAFT'
      ? 'an exception reason is needed to submit it, and the HR approver approves the exception explicitly.'
      : exceptionReason
        ? 'the HR approver approves its budget exception explicitly.'
        : 'it records no budget exception reason, so it cannot be approved as it stands: it can be returned to the requester or rejected.';
  const text = within
    ? 'Within the approved budget.'
    : status === 'EXCEEDS_BUDGET'
      ? `Exceeds the approved budget: ${exception}`
      : status === 'NO_BUDGET'
        ? `No approved manpower budget covers this department, location and designation on the target date: ${exception}`
        : '';
  const figures = check.approvedHeadcount === null ? '' : ` Approved headcount ${check.approvedHeadcount}, already committed ${check.committed}, this requisition ${check.requested}.`;
  return (
    <p>
      <Badge tone={within ? 'good' : 'warn'}>{budgetStatusText(status)}</Badge> {text}
      {figures}
    </p>
  );
}

export function DecisionTable({ decisions, myUserId }: { decisions: DecisionRecord[]; myUserId: string | null }) {
  return (
    <div style={SCROLL}>
      <table aria-label="Approval history">
        <thead>
          <tr>
            <th scope="col">Revision</th>
            <th scope="col">Step</th>
            <th scope="col">Decision</th>
            <th scope="col">Decided by</th>
            <th scope="col">Decided at</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {decisions.map((d, index) => (
            <tr key={`${d.decidedAt}-${index}`}>
              <td>{d.revision}</td>
              <td>{stepText(d.step, d.action)}</td>
              <td>{DECISION_LABEL[d.decision] ?? readable(d.decision)}</td>
              <td>
                {userLabel(d.decidedBy, myUserId)}
                {d.onBehalfOf && <span className="hint">{` on behalf of ${userLabel(d.onBehalfOf, myUserId)}`}</span>}
              </td>
              <td>
                <When at={d.decidedAt} />
              </td>
              <td>{d.reason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RevisionTable({ revisions }: { revisions: RequisitionRevision[] }) {
  return (
    <div style={SCROLL}>
      <table aria-label="Submitted revisions">
        <thead>
          <tr>
            <th scope="col">Revision</th>
            <th scope="col">Vacancies</th>
            <th scope="col">Target date</th>
            <th scope="col">Budget check</th>
            <th scope="col">Approved headcount</th>
            <th scope="col">Committed</th>
            <th scope="col">Exception reason</th>
            <th scope="col">Submitted</th>
          </tr>
        </thead>
        <tbody>
          {revisions.map((v) => (
            <tr key={v.revision}>
              <td>{v.revision}</td>
              <td>{v.vacancies}</td>
              <td>{formatDate(v.targetDate)}</td>
              <td>{budgetStatusText(v.budgetStatus)}</td>
              <td>{v.approvedHeadcount ?? '—'}</td>
              <td>{v.committed ?? '—'}</td>
              <td>{v.budgetExceptionReason ?? '—'}</td>
              <td>
                <When at={v.submittedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

