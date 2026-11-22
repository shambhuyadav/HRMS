// Requisition views shared by the screens and the decision queue: the facts, budget check, decisions and revisions.
import { Hint } from '@/components/hint';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate, readable } from '../../api';
import { Badge, Item, StateBadge, When } from '../../ui';
import {
  type BudgetCheck,
  budgetStatusText,
  DECISION_LABEL,
  type DecisionRecord,
  personLabel,
  REASON_TYPE_LABEL,
  type Requisition,
  type RequisitionRevision,
  stepText,
  userLabel,
} from './shared';

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
 * What a requisition beyond its budget needs, by where it is: a draft needs its reason to be submitted; a submitted one needs the
 * HR approver's explicit approval of the reason it recorded, and one that recorded none cannot be approved as it stands.
 */
function exceptionNeeds(state: string, exceptionReason: string | null): string {
  if (state === 'DRAFT') return 'an exception reason is needed to submit it, and the HR approver approves the exception explicitly.';
  return exceptionReason
    ? 'the HR approver approves its budget exception explicitly.'
    : 'it records no budget exception reason, so it cannot be approved as it stands: it can be returned to the requester or rejected.';
}

/** The budget check's outcome in a sentence; nothing for a status this screen does not know. */
function budgetCheckSentence(status: string, exception: string): string {
  if (status === 'WITHIN_BUDGET') return 'Within the approved budget.';
  if (status === 'EXCEEDS_BUDGET') return `Exceeds the approved budget: ${exception}`;
  if (status === 'NO_BUDGET') return `No approved manpower budget covers this department, location and designation on the target date: ${exception}`;
  return '';
}

/** The budget check as the server worked it out; the figures only when the server sent them. */
export function BudgetCheckText({ check, state, exceptionReason }: { check: BudgetCheck; state: string; exceptionReason: string | null }) {
  const status = check.budgetStatus;
  const within = status === 'WITHIN_BUDGET';
  const text = budgetCheckSentence(status, exceptionNeeds(state, exceptionReason));
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
    <Table aria-label="Approval history">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Revision</TableHead>
          <TableHead scope="col">Step</TableHead>
          <TableHead scope="col">Decision</TableHead>
          <TableHead scope="col">Decided by</TableHead>
          <TableHead scope="col">Decided at</TableHead>
          <TableHead scope="col">Reason</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {decisions.map((d, index) => (
          <TableRow key={`${d.decidedAt}-${index}`}>
            <TableCell>{d.revision}</TableCell>
            <TableCell>{stepText(d.step, d.action)}</TableCell>
            <TableCell>{DECISION_LABEL[d.decision] ?? readable(d.decision)}</TableCell>
            <TableCell>
              {userLabel(d.decidedBy, myUserId)}
              {d.onBehalfOf && <Hint as="span">{` on behalf of ${userLabel(d.onBehalfOf, myUserId)}`}</Hint>}
            </TableCell>
            <TableCell>
              <When at={d.decidedAt} />
            </TableCell>
            <TableCell>{d.reason ?? '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RevisionTable({ revisions }: { revisions: RequisitionRevision[] }) {
  return (
    <Table aria-label="Submitted revisions">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Revision</TableHead>
          <TableHead scope="col">Vacancies</TableHead>
          <TableHead scope="col">Target date</TableHead>
          <TableHead scope="col">Budget check</TableHead>
          <TableHead scope="col">Approved headcount</TableHead>
          <TableHead scope="col">Committed</TableHead>
          <TableHead scope="col">Exception reason</TableHead>
          <TableHead scope="col">Submitted</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {revisions.map((v) => (
          <TableRow key={v.revision}>
            <TableCell>{v.revision}</TableCell>
            <TableCell>{v.vacancies}</TableCell>
            <TableCell>{formatDate(v.targetDate)}</TableCell>
            <TableCell>{budgetStatusText(v.budgetStatus)}</TableCell>
            <TableCell>{v.approvedHeadcount ?? '—'}</TableCell>
            <TableCell>{v.committed ?? '—'}</TableCell>
            <TableCell>{v.budgetExceptionReason ?? '—'}</TableCell>
            <TableCell>
              <When at={v.submittedAt} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
