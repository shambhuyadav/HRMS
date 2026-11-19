// Shared by the appraisal screens: permission keys, screen paths and constants, the API shapes, query keys, styles and label helpers.
import { type CSSProperties, useMemo } from 'react';
import { formatDate, isForbidden, isNotFound, readable } from '../../api';
import { type MeContext, useSession } from '../../session';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (modules/appraisal/registration.ts, routes.ts, goal-import.ts; migration 0035) and screen paths
// ---------------------------------------------------------------------------------------------------------
export const CYCLE_READ = 'appraisal_cycle.read.operational';
export const CYCLE_MANAGE = 'appraisal_cycle.manage.operational';
export const READ = 'appraisal.read.operational';
export const READ_SELF = 'appraisal.read.self';
export const READ_RATING = 'appraisal.read.rating';
export const MANAGE = 'appraisal.manage.operational';
export const CANCEL = 'appraisal.cancel.operational';
export const GRANT_EXCEPTION = 'appraisal.grant_exception.operational';
export const IMPORT = 'appraisal.import.operational';
export const REPORT = 'appraisal.report.operational';
export const EXPORT = 'appraisal.export.operational';
export const RATE = 'appraisal.rate.rating';
export const CONFIRM = 'appraisal.confirm.rating';
export const SELF_ASSESS = 'appraisal.self_assess.self';
/** GET /v1/appraisal-cycles/:id/training-needs (I-86): confidential section texts, so the rating group's report duty. */
export const REPORT_RATING = 'appraisal.report.rating';
/** GET /v1/org/departments: the department filter of the register and the report. */
export const ORG_READ = 'org_master.read.operational';
/** GET /v1/employees: whom to enrol. */
export const EMPLOYEE_LIST = 'employee.list.operational';
/** The own-ESS role: the API serves one's own appraisal only in the Employee OWN context (BR-055). */
const OWN_ESS_ROLE = 'EMPLOYEE';

export const PATHS = {
  cycles: '/appraisal/cycles',
  cycle: (id: string) => `/appraisal/cycles/${id}`,
  appraisals: '/appraisal/appraisals',
  appraisal: (id: string) => `/appraisal/appraisals/${id}`,
  ratings: '/appraisal/ratings',
  reviews: '/appraisal/reviews',
  reports: '/appraisal/reports',
  goalUpload: '/appraisal/goal-upload',
  competencies: '/appraisal/competencies',
} as const;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WHOLE = /^\d{1,3}$/;
/** GET /v1/appraisals accepts these page sizes only. */
export const PAGE_SIZES = [25, 50, 100] as const;
export const APPRAISAL_STATES = ['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'CANCELLED'] as const;
/** F1: every score is an integer 1..5. */
export const SCORES = ['1', '2', '3', '4', '5'] as const;
/** The cycle start months the API accepts (CYCLE_START_MONTHS), each explained by the period it gives. */
export const START_MONTHS: readonly (readonly [month: number, label: string])[] = [
  [1, 'January (cycles run January to December)'],
  [4, 'April (cycles run April to March)'],
  [7, 'July (cycles run July to June)'],
  [10, 'October (cycles run October to September)'],
];
export const MONTH_NAME: Record<number, string> = { 1: 'January', 4: 'April', 7: 'July', 10: 'October' };

export type WindowKey = 'goalSetting' | 'selfEntry' | 'managerRating';
export type Stage = 'GOAL_SETTING' | 'SELF_ENTRY' | 'MANAGER_RATING';
export const WINDOWS: readonly { key: WindowKey; stage: Stage; label: string }[] = [
  { key: 'goalSetting', stage: 'GOAL_SETTING', label: 'Goal setting' },
  { key: 'selfEntry', stage: 'SELF_ENTRY', label: 'Self-entry' },
  { key: 'managerRating', stage: 'MANAGER_RATING', label: 'Manager rating' },
];
export const STAGE_LABEL: Record<string, string> = { GOAL_SETTING: 'Goal setting', SELF_ENTRY: 'Self-entry', MANAGER_RATING: 'Manager rating', REVIEW: 'Reviewer confirmation' };

// ---------------------------------------------------------------------------------------------------------
// API shapes (modules/appraisal/cycles.ts, appraisals.ts, review.ts, reports.ts; imports/jobs.ts)
// ---------------------------------------------------------------------------------------------------------
export interface Setting {
  configured: boolean;
  cycleStartMonth: number | null;
  version: number | null;
  missing?: string[];
}
interface CycleWindow {
  opensOn: string;
  closesOn: string;
  openToday: boolean;
}
/** I-77 cycle rules: FORMULA (F1 weighted manager result) or MANUAL (the manager's overall rating) final ratings. */
export type RatingMode = 'FORMULA' | 'MANUAL';
export interface Cycle {
  id: string;
  code: string;
  name: string;
  startDate: string;
  endDate: string;
  /** Reviewer levels after the manager's rating: 0 (the manager's approval completes it), 1 or 2. */
  approvalLevels: number;
  /** FR-041 KRA review: goals take effect once someone other than their setter reviews them. */
  goalReviewRequired: boolean;
  ratingMode: RatingMode;
  /** The date reviewer confirmations are due; null when the cycle has no reviewer level or it was never set. */
  reviewDueOn: string | null;
  /** I-86: the cycle's goals / competencies split (absent from servers before it). */
  scoring?: Scoring;
  /** FR-042 sections the cycle includes. */
  sections?: SectionInfo[];
  state: string;
  /** null: the window is unscheduled, so entries at that stage are refused. */
  windows: Partial<Record<WindowKey, CycleWindow | null>>;
  version: number;
}
/** I-86 scoring split: whole percentages adding to 100; competencies 0 = not assessed (the goal result alone). */
export interface Scoring {
  goalWeightPercent: number;
  competencyWeightPercent: number;
  competenciesAssessed?: boolean;
}
export type SectionParty = 'EMPLOYEE' | 'MANAGER';
/** FR-042 section (modules/appraisal/sections.ts): meaning, who fills it; none is scored. Completion flags only, never the texts. */
export interface SectionInfo {
  code: string;
  title: string;
  meaning: string;
  filledBy: SectionParty[];
  prompts: Partial<Record<SectionParty, string>>;
  scored?: boolean;
  selfEntryComplete?: boolean;
  managerEntryComplete?: boolean;
}
/** FR-041 competency copied into the appraisal at enrolment and fixed (operational: no values). */
export interface CompetencyItem {
  id: string;
  competencyId: string;
  sequence: number;
  code: string;
  name: string;
  description: string | null;
  indicators: { level: number; text: string }[];
  weight: number;
  selfEntryComplete: boolean;
  /** Absent from one's own appraisal. */
  managerRatingComplete?: boolean;
}
export interface CompetencyEntry {
  competencyId: string;
  sequence: number;
  score: number | null;
  comment: string | null;
}
export interface SectionText {
  section: string;
  text: string | null;
}
/** A decider, assignee or recorder: the user, with the employee identity when the user is linked to one. */
interface UserRef {
  userId: string;
  employeeCode: string | null;
  displayName: string | null;
}
interface EmployeeRef {
  id: string;
  employeeCode: string;
  displayName: string;
  department: { id: string; name: string } | null;
}
export interface Goal {
  id: string;
  sequence: number;
  description: string;
  target: string | null;
  weight: number;
  /** DF02 completion flags (operational): whether a score was entered, never its value. */
  selfEntryComplete: boolean;
  /** Absent from one's own appraisal. */
  managerRatingComplete?: boolean;
}
interface Entry {
  goalId: string;
  sequence: number;
  score: number | null;
  comment: string | null;
}
export interface EntrySet {
  comment: string | null;
  entries: Entry[];
  /** I-86: absent from servers before it. */
  competencies?: CompetencyEntry[];
  sections?: SectionText[];
}
/** The manager's rating with the I-86 results: the goal result, the competency result and the split they were combined with. */
export interface ManagerRating extends EntrySet {
  weightedResult: string | null;
  overallRating?: number | null;
  goalResult?: string | null;
  competencyResult?: string | null;
  split?: Scoring | null;
}
/** Confidential parts arrive only for a caller who may see them (render what is present). */
export interface Revision {
  revision: number;
  state: string;
  submittedAt: string | null;
  returnedAt: string | null;
  confirmedAt: string | null;
  ratedAt?: string | null;
  approvalLevels?: number | null;
  /** The explanation of a return, addressed to the employee. */
  employeeMessage?: string | null;
  selfEntry?: EntrySet;
  /** `overallRating`: the manager's overall rating of a MANUAL cycle (null otherwise). */
  managerRating?: ManagerRating;
  /** FR-043: each reviewer level's overall score, kept apart (rating group only). */
  reviewerScores?: { level: number; score: number; scoredAt: string }[];
}
interface DecisionRecord {
  revision: number;
  step: number;
  stage: string;
  level: number | null;
  decision: string;
  decidedAt: string;
  decidedBy?: UserRef;
  /** I-57 item 7: the delegator a delegate decided for (null when decided in the decider's own right). */
  onBehalfOf?: UserRef | null;
  remark?: string | null;
}
interface WindowException {
  stage: string;
  validUntil: string;
  recordedAt: string;
  recordedBy?: UserRef;
  reason?: string | null;
}
interface AppraisalWindow {
  opensOn: string | null;
  closesOn: string | null;
  openToday: boolean;
  exceptionUntil: string | null;
  entryAllowed: boolean;
}
interface Pending {
  taskId?: string;
  step: number;
  stage: string;
  level: number | null;
  assignedAt: string;
  /** The task holder; one's own appraisal shows a name only. */
  with: { userId?: string; employeeCode?: string | null; displayName: string | null };
}
/** FR-041 KRA review; who set and reviewed the goals is absent from one's own appraisal. */
interface GoalReview {
  required: boolean;
  reviewed: boolean;
  reviewedAt: string | null;
  setBy?: UserRef | null;
  setAt?: string | null;
  reviewedBy?: UserRef | null;
}
export interface Appraisal {
  id: string;
  cycle: {
    id: string;
    code: string;
    name: string;
    startDate: string;
    endDate: string;
    approvalLevels: number;
    goalReviewRequired?: boolean;
    ratingMode?: RatingMode;
    reviewDueOn?: string | null;
    scoring?: Scoring;
    state: string;
  };
  employee: EmployeeRef;
  state: string;
  revision: number;
  source: string;
  taskStatus: string;
  /** Absent from answers of servers before I-77. */
  goalReview?: GoalReview;
  pending: Pending | null;
  goals: Goal[];
  goalWeightTotal: number;
  /** I-86 (absent from servers before it). */
  competencies?: CompetencyItem[];
  competencyWeightTotal?: number;
  sections?: SectionInfo[];
  windows: Partial<Record<WindowKey, AppraisalWindow>>;
  revisions: Revision[];
  decisions: DecisionRecord[];
  /** The confirmed revision's weighted manager result; only with the confidential rating group. */
  finalRating?: string | null;
  exceptions: WindowException[];
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason?: string | null;
  createdAt: string;
  version: number;
}
export interface AppraisalRow {
  id: string;
  cycle: { id: string; code: string; name: string };
  employee: EmployeeRef;
  state: string;
  revision: number;
  source: string;
  taskStatus: string;
  goalCount: number;
  goalWeightTotal: number;
  completedAt: string | null;
  createdAt: string;
  weightedResult?: string | null;
  finalRating?: string | null;
}
export interface AppraisalPage {
  items: AppraisalRow[];
  total: number;
  page: number;
  pageSize: number;
}
export interface AppraisalTask {
  taskId: string;
  step: number;
  stage: string;
  level: number | null;
  assignedAt: string;
  /** The task's due date (company-local, inclusive) and whether it has passed (I-77 item 5). */
  dueOn?: string | null;
  overdue?: boolean;
  /** null when the appraisal is outside the selected assignment's row scope. */
  appraisal: Appraisal | null;
}
export interface DecisionResult {
  appraisalId: string;
  state: string;
  revision: number;
  pendingStep?: number | null;
  replayed: boolean;
}
export interface Report {
  cycle: { id: string; code: string; name: string; startDate: string; endDate: string };
  filters: { departmentId: string | null };
  scope: string;
  ownAppraisalExcluded: boolean;
  generatedAt: string;
  population: number;
  byState: Record<string, number>;
  ratings?: { completed: number; distribution: { finalRating: string; count: number }[] };
}
interface ImportRow {
  rowNumber: number;
  businessKey: string | null;
  state: string;
  errorCode: string | null;
}
export interface ImportJob {
  id: string;
  state: string;
  template?: string;
  fileName: string | null;
  rowCount: number | null;
  acceptedCount: number | null;
  rejectedCount: number | null;
  rows: ImportRow[];
}
export interface MasterItem {
  id: string;
  code: string;
  name: string;
}
export interface GoalInput {
  sequence: number;
  description: string;
  target: string | null;
  weight: number;
}
interface EntryChange {
  goalId: string;
  score: number | null;
  comment: string | null;
}
/** PUT /v1/appraisal-tasks/:id/rating and PUT /v1/me/appraisals/:id/self-entry, without the version. */
export interface EntryChanges {
  entries: EntryChange[];
  /** I-86: changed competency scores and comments, and changed section texts (null clears). */
  competencies?: { competencyId: string; score: number | null; comment: string | null }[];
  sections?: SectionText[];
  comment?: string | null;
  /** The rating of a MANUAL cycle only (FR-042). */
  overallRating?: number | null;
}

// ---------------------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------------------

/**
 * Query keys carry the selected company and assignment: the app keeps one query cache across role switches, and an
 * answer given to one assignment (a rater's queue, confidential ratings) must never be shown under another.
 */
export function useKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(() => {
    const base = ['appraisal', context] as const;
    return {
      setting: [...base, 'setting'] as const,
      cycles: [...base, 'cycles'] as const,
      cycleList: (state: string) => [...base, 'cycles', 'list', state] as const,
      cycle: (id: string) => [...base, 'cycles', 'detail', id] as const,
      appraisals: [...base, 'appraisals'] as const,
      appraisalList: (query: string) => [...base, 'appraisals', 'list', query] as const,
      appraisal: (id: string) => [...base, 'appraisals', 'detail', id] as const,
      tasks: [...base, 'tasks'] as const,
      reports: [...base, 'reports'] as const,
      report: (cycleId: string, departmentId: string) => [...base, 'reports', cycleId, departmentId] as const,
      mine: [...base, 'mine'] as const,
      mineList: [...base, 'mine', 'list'] as const,
      own: (id: string) => [...base, 'mine', 'detail', id] as const,
      departments: [...base, 'departments'] as const,
      employeeSearch: (term: string) => [...base, 'employee-search', term] as const,
      sections: [...base, 'sections'] as const,
      config: [...base, 'config'] as const,
      scoring: [...base, 'config', 'scoring'] as const,
      competencies: [...base, 'config', 'competencies'] as const,
      competencySets: [...base, 'config', 'competency-sets'] as const,
      grades: [...base, 'grades'] as const,
      designations: [...base, 'designations'] as const,
      trainingNeeds: (cycleId: string, departmentId: string) => [...base, 'reports', 'training-needs', cycleId, departmentId] as const,
    };
  }, [context]);
}

export const SCROLL: CSSProperties = { overflowX: 'auto' };
export const FLUSH: CSSProperties = { margin: 0 };
export const H3: CSSProperties = { fontSize: '1rem', margin: '0.5rem 0 0' };
export const SPACED: CSSProperties = { marginTop: '0.75rem' };
export const GROUP: CSSProperties = { border: '1px solid var(--line)', borderRadius: 6, margin: '0.5rem 0', padding: '0.5rem 0.75rem', minWidth: 0 };
export const TEXTAREA: CSSProperties = {
  font: 'inherit',
  padding: '0.4rem 0.5rem',
  border: '1px solid var(--line)',
  borderRadius: 6,
  color: 'var(--text)',
  background: 'var(--surface)',
  resize: 'vertical',
};

/** The latest answer, unless the server has since refused it (403/404): what the role may no longer see is not kept. */
export function shown<T>(query: { data: T | undefined; error: unknown }): T | undefined {
  return isForbidden(query.error) || isNotFound(query.error) ? undefined : query.data;
}

export const inOwnContext = (me: MeContext | null) => me !== null && me.roleCode === OWN_ESS_ROLE && me.scopeKind === 'OWN' && me.employeeId !== null;

const TASK_STATUS_LABEL: Record<string, string> = {
  AWAITING_GOALS: 'Waiting for goals',
  AWAITING_GOAL_REVIEW: 'Waiting for the goal review',
  AWAITING_SELF_ENTRY: 'Waiting for the self-entry',
  AWAITING_MANAGER_RATING: 'Waiting for the manager rating',
  AWAITING_REVIEW: 'Waiting for the reviewer confirmation',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};
export const SOURCE_LABEL: Record<string, string> = { MANUAL: 'Entered', UPLOAD: 'KRA upload' };
export const taskStatusText = (s: string) => TASK_STATUS_LABEL[s] ?? readable(s);
export const stepText = (stage: string, level: number | null) => (stage === 'REVIEW' ? `Reviewer confirmation${level ? ` (level ${level})` : ''}` : (STAGE_LABEL[stage] ?? readable(stage)));
export function decisionText(decision: string, stage: string): string {
  if (decision === 'RETURN') return 'Returned to the employee';
  if (decision === 'APPROVE') return stage === 'MANAGER_RATING' ? 'Rating submitted' : 'Confirmed';
  return readable(decision);
}
export function userLabel(u: { userId?: string; employeeCode?: string | null; displayName: string | null } | undefined, myUserId: string | null): string {
  if (!u) return '—';
  if (myUserId !== null && u.userId !== undefined && u.userId === myUserId) return 'You';
  if (u.displayName) return u.employeeCode ? `${u.displayName} (${u.employeeCode})` : u.displayName;
  return 'A user without an employee record';
}
export const periodText = (p: { startDate: string; endDate: string }) => `${formatDate(p.startDate)} to ${formatDate(p.endDate)}`;
export function windowText(w: { opensOn: string | null; closesOn: string | null } | null | undefined): string {
  return w && w.opensOn && w.closesOn ? `${formatDate(w.opensOn)} to ${formatDate(w.closesOn)}` : 'Not scheduled (entries are refused)';
}
export const levelsText = (n: number) =>
  n === 2 ? '2 (a second independent reviewer confirms after the first)' : n === 0 ? 'None (the manager’s approval completes the appraisal)' : '1 (one independent reviewer confirms)';
export const ratingModeText = (m: string | undefined) => (m === 'MANUAL' ? 'Manual (the manager’s overall rating is the final rating)' : 'Formula (the weighted manager result is the final rating)');
export const yesNo = (v: boolean) => (v ? 'Yes' : 'No');
export const goalList = (goals: unknown) => (Array.isArray(goals) && goals.length > 0 ? goals.join(', ') : null);
