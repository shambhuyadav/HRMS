// Types of the training routes: exactly what the API returns (plans, participants and feedback).

// ---------------------------------------------------------------------------------------------------------
// Types: exactly what the API returns (modules/training/plans.ts, participants.ts and feedback.ts)
// ---------------------------------------------------------------------------------------------------------
export interface Choice {
  code: string;
  label: string;
}
interface Question extends Choice {
  position?: number;
}
interface Cost {
  amount: string;
  currency: string;
}
export interface Plan {
  id: string;
  code: string;
  title: string;
  startDate: string;
  endDate: string;
  view: string;
  state: string;
  mode: Choice;
  venue: string | null;
  trainer: string | null;
  capacity: number;
  seatsTaken: number;
  seatsAvailable: number;
  nominationsPending: number;
  owner: { employeeId: string; employeeCode: string; name: string };
  selfNomination: boolean;
  cancellation: { cancelledAt: string; cancelledBy: string; reason: string | null; cancelledByName: string | null } | null;
  /** Present only for a caller holding the cost group; null is "no cost", distinct from a zero amount. */
  cost?: Cost | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export interface PlanDetail extends Plan {
  feedbackQuestions: Question[];
  feedbackRecorded: boolean;
}
export interface PlanPage {
  items: Plan[];
  total: number;
  page: number;
  pageSize: number;
  businessDate: string;
}
export interface Participant {
  id: string;
  planId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  state: string;
  selfNominated: boolean;
  nominatedAt: string | null;
  confirmedAt: string | null;
  attendanceRecordedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  /** The confidential reason group: present only for a caller holding the approved grant. */
  cancellationReason?: string | null;
  feedbackStatus: string;
  version: number;
}
export interface ParticipantPage {
  items: Participant[];
  total: number;
  page: number;
  pageSize: number;
  scope: { kind: string; companyWide: boolean };
}
interface PlanSummary {
  id: string;
  code: string;
  title: string;
  startDate: string;
  endDate: string;
  view: string;
  mode: Choice;
  venue: string | null;
  trainer: string | null;
  ownerName: string | null;
}
interface HistoryEntry {
  action: string;
  fromState: string | null;
  toState: string;
  reason?: string | null;
  reasonRecorded: boolean;
  occurredAt: string;
  actorName: string | null;
}
export interface ParticipantDetail extends Participant {
  plan: PlanSummary;
  history: HistoryEntry[];
}
export interface EmployeeParticipation {
  id: string;
  state: string;
  selfNominated: boolean;
  nominatedAt: string | null;
  confirmedAt: string | null;
  attendanceRecordedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason?: string | null;
  feedbackStatus: string;
  plan: PlanSummary;
}
export interface OpenPlan {
  id: string;
  code: string;
  title: string;
  startDate: string;
  endDate: string;
  view: string;
  mode: Choice;
  venue: string | null;
  trainer: string | null;
  ownerName: string | null;
  myParticipation: { participantId: string; state: string; selfNominated: boolean } | null;
}
interface Answer {
  questionCode: string;
  score: number;
  /** The confidential comment: present only for a caller holding the comment group. */
  comment?: string | null;
}
export interface OwnFeedback {
  participantId: string;
  completedAt: string | null;
  status: string;
  submittedAt: string | null;
  plan: { id: string; code: string; title: string; startDate: string; endDate: string; view: string };
  questions: Question[];
  answers: Answer[];
}
interface PlanHead {
  id: string;
  code: string;
  title: string;
  startDate: string;
  endDate: string;
  view: string;
}
export interface FeedbackSummary {
  plan: PlanHead;
  scope: { kind: string; companyWide: boolean };
  generatedAt: string;
  participants: { total: number; byState: Record<string, number> };
  feedback: { eligible: number; responded: number; missing: number; notApplicable: number };
  questions: { code: string; label: string; position: number; answered: number; scores: Record<string, number>; missing: number }[];
  reconciles: { participants: boolean; responses: boolean; questions: boolean };
}
interface FeedbackRow {
  participantId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  state: string;
  completedAt: string | null;
  feedbackStatus: string;
  submittedAt: string | null;
  answers: Answer[];
}
export interface FeedbackRegister {
  plan: PlanHead;
  questions: Question[];
  scope: { kind: string; companyWide: boolean };
  commentsIncluded: boolean;
  items: FeedbackRow[];
}
