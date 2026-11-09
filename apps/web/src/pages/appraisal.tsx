// Appraisal (FR-040 to FR-044; F1 "Appraisal"; H3 TN18; decisions I-23 and I-24; DF02; DF03; C4).
//
// Cycles (FR-040): the company's cycle start month (1, 4, 7 or 10; no default, so cycles are refused until it is set),
// financial-year cycles of twelve months from the 1st of that month with three inclusive windows (goal setting,
// self-entry, manager rating; each fully dated or unscheduled) and one or two reviewer levels, closed once every
// appraisal in them is finished. Appraisals (FR-041): HR or the direct manager enrols an employee in an open cycle as a
// DRAFT with goals (whole-number weights 1 to 100 that must total exactly 100 when the employee submits), never on their
// own appraisal; authorised window exceptions per appraisal and stage; HR cancels with a confidential reason. Review
// (FR-042, FR-043): the employee's self-entry and submission in the Employee OWN context (My ESS TN18); the manager's
// rating per goal (integer 1 to 5) with remarks, submitted as the F1 weighted manager result the server computes; an
// independent reviewer confirms or returns it (a return opens the next revision). Reports (FR-044) count by state and,
// with the rating grant, by exact final rating, within the selected assignment's row scope. The KRA upload only enrols
// new DRAFT appraisals; it never submits, rates or approves anything. A goal file the malware scan has not released is
// held unread (FR-106); the user's own uploads are listed, so a held one is opened again and checked again from the
// file the server stored (records.tsx).
// Competencies and sections (FR-041, FR-042; decided under owner delegation, 6 Nov 2026, I-86): HR keeps a dated goals /
// competencies split, a competency master with one behavioural indicator per level 1 to 5, and dated competency sets per grade
// (optionally one designation); enrolment copies the employee's set into the appraisal, fixed. The employee self-scores and the
// manager rates each competency like a goal; the weighted result is (goals % x goal result + competencies % x competency result)
// / 100, rounded once half up, or the goal result alone without competencies. A cycle includes any of four unscored sections
// (improvement areas, training needs, activity performance, stretched KPIs); an included one must be filled by its party before
// they submit, an excluded one never blocks. Training needs are listed for training planning as a suggestion only.
// Ratings, comments, results, remarks and reasons are confidential: the server leaves them out of its answers unless the
// selected assignment may see them, and these screens render only what it returned. One's own appraisal never shows a
// rating, and no employee-visible result is published (no setting authorises one). The server authorises every call
// and decides every rule; these screens hide what the selected assignment cannot use and say its refusals in plain words.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentType, type CSSProperties, type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, download, fileToBase64, formatDate, idempotencyKey } from '../api';
import type { EssPanel, ScreenRoute } from '../screens';
import { type MeContext, useSession } from '../session';
import { Badge, Empty, ErrorNote, Section, StateBadge } from '../ui';
import { DelegatedBadge } from './delegations';
import { HeldBatchWatchNote, ImportBatches, TemplateDownload, useBatchFollowUp } from './records';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (modules/appraisal/registration.ts, routes.ts, goal-import.ts; migration 0035) and screen paths
// ---------------------------------------------------------------------------------------------------------
const CYCLE_READ = 'appraisal_cycle.read.operational';
const CYCLE_MANAGE = 'appraisal_cycle.manage.operational';
const READ = 'appraisal.read.operational';
const READ_SELF = 'appraisal.read.self';
const READ_RATING = 'appraisal.read.rating';
const MANAGE = 'appraisal.manage.operational';
const CANCEL = 'appraisal.cancel.operational';
const GRANT_EXCEPTION = 'appraisal.grant_exception.operational';
const IMPORT = 'appraisal.import.operational';
const REPORT = 'appraisal.report.operational';
const EXPORT = 'appraisal.export.operational';
const RATE = 'appraisal.rate.rating';
const CONFIRM = 'appraisal.confirm.rating';
const SELF_ASSESS = 'appraisal.self_assess.self';
/** GET /v1/appraisal-cycles/:id/training-needs (I-86): confidential section texts, so the rating group's report duty. */
const REPORT_RATING = 'appraisal.report.rating';
/** GET /v1/org/departments: the department filter of the register and the report. */
const ORG_READ = 'org_master.read.operational';
/** GET /v1/employees: whom to enrol. */
const EMPLOYEE_LIST = 'employee.list.operational';
/** The own-ESS role: the API serves one's own appraisal only in the Employee OWN context (BR-055). */
const OWN_ESS_ROLE = 'EMPLOYEE';

const PATHS = {
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WHOLE = /^\d{1,3}$/;
/** GET /v1/appraisals accepts these page sizes only. */
const PAGE_SIZES = [25, 50, 100] as const;
const APPRAISAL_STATES = ['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'CANCELLED'] as const;
/** F1: every score is an integer 1..5. */
const SCORES = ['1', '2', '3', '4', '5'] as const;
/** The cycle start months the API accepts (CYCLE_START_MONTHS), each explained by the period it gives. */
const START_MONTHS: readonly (readonly [month: number, label: string])[] = [
  [1, 'January (cycles run January to December)'],
  [4, 'April (cycles run April to March)'],
  [7, 'July (cycles run July to June)'],
  [10, 'October (cycles run October to September)'],
];
const MONTH_NAME: Record<number, string> = { 1: 'January', 4: 'April', 7: 'July', 10: 'October' };

type WindowKey = 'goalSetting' | 'selfEntry' | 'managerRating';
type Stage = 'GOAL_SETTING' | 'SELF_ENTRY' | 'MANAGER_RATING';
const WINDOWS: readonly { key: WindowKey; stage: Stage; label: string }[] = [
  { key: 'goalSetting', stage: 'GOAL_SETTING', label: 'Goal setting' },
  { key: 'selfEntry', stage: 'SELF_ENTRY', label: 'Self-entry' },
  { key: 'managerRating', stage: 'MANAGER_RATING', label: 'Manager rating' },
];
const STAGE_LABEL: Record<string, string> = { GOAL_SETTING: 'Goal setting', SELF_ENTRY: 'Self-entry', MANAGER_RATING: 'Manager rating', REVIEW: 'Reviewer confirmation' };

// ---------------------------------------------------------------------------------------------------------
// API shapes (modules/appraisal/cycles.ts, appraisals.ts, review.ts, reports.ts; imports/jobs.ts)
// ---------------------------------------------------------------------------------------------------------
interface Setting {
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
type RatingMode = 'FORMULA' | 'MANUAL';
interface Cycle {
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
interface Scoring {
  goalWeightPercent: number;
  competencyWeightPercent: number;
  competenciesAssessed?: boolean;
}
type SectionParty = 'EMPLOYEE' | 'MANAGER';
/** FR-042 section (modules/appraisal/sections.ts): meaning, who fills it; none is scored. Completion flags only, never the texts. */
interface SectionInfo {
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
interface CompetencyItem {
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
interface CompetencyEntry {
  competencyId: string;
  sequence: number;
  score: number | null;
  comment: string | null;
}
interface SectionText {
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
interface Goal {
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
interface EntrySet {
  comment: string | null;
  entries: Entry[];
  /** I-86: absent from servers before it. */
  competencies?: CompetencyEntry[];
  sections?: SectionText[];
}
/** The manager's rating with the I-86 results: the goal result, the competency result and the split they were combined with. */
interface ManagerRating extends EntrySet {
  weightedResult: string | null;
  overallRating?: number | null;
  goalResult?: string | null;
  competencyResult?: string | null;
  split?: Scoring | null;
}
/** Confidential parts arrive only for a caller who may see them (render what is present). */
interface Revision {
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
interface Appraisal {
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
interface AppraisalRow {
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
interface AppraisalPage {
  items: AppraisalRow[];
  total: number;
  page: number;
  pageSize: number;
}
interface AppraisalTask {
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
interface DecisionResult {
  appraisalId: string;
  state: string;
  revision: number;
  pendingStep?: number | null;
  replayed: boolean;
}
interface Report {
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
interface ImportJob {
  id: string;
  state: string;
  template?: string;
  fileName: string | null;
  rowCount: number | null;
  acceptedCount: number | null;
  rejectedCount: number | null;
  rows: ImportRow[];
}
interface MasterItem {
  id: string;
  code: string;
  name: string;
}
interface EmployeeHit {
  id: string;
  employeeCode: string;
  displayName: string;
  status: string;
}
interface GoalInput {
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
interface EntryChanges {
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
function useKeys() {
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

const SCROLL: CSSProperties = { overflowX: 'auto' };
const FLUSH: CSSProperties = { margin: 0 };
const H3: CSSProperties = { fontSize: '1rem', margin: '0.5rem 0 0' };
const SPACED: CSSProperties = { marginTop: '0.75rem' };
const GROUP: CSSProperties = { border: '1px solid var(--line)', borderRadius: 6, margin: '0.5rem 0', padding: '0.5rem 0.75rem', minWidth: 0 };
const TEXTAREA: CSSProperties = {
  font: 'inherit',
  padding: '0.4rem 0.5rem',
  border: '1px solid var(--line)',
  borderRadius: 6,
  color: 'var(--text)',
  background: 'var(--surface)',
  resize: 'vertical',
};

const isForbidden = (error: unknown) => error instanceof ApiError && error.status === 403;
const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;
/** A refusal or bad request will not change on retry; only transient failures are retried (once). */
const retryTransient = (failureCount: number, error: Error) => !(error instanceof ApiError && error.status < 500) && failureCount < 1;

/** The latest answer, unless the server has since refused it (403/404): what the role may no longer see is not kept. */
function shown<T>(query: { data: T | undefined; error: unknown }): T | undefined {
  return isForbidden(query.error) || isNotFound(query.error) ? undefined : query.data;
}

function readable(code: string): string {
  const text = code.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const pad = (n: number) => String(n).padStart(2, '0');
/** An instant shown as the viewer's local date and time. */
function localDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return formatDate(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function When({ at }: { at: string | null | undefined }) {
  return at ? <time dateTime={at}>{localDateTime(at)}</time> : <>—</>;
}

const inOwnContext = (me: MeContext | null) => me !== null && me.roleCode === OWN_ESS_ROLE && me.scopeKind === 'OWN' && me.employeeId !== null;

const TASK_STATUS_LABEL: Record<string, string> = {
  AWAITING_GOALS: 'Waiting for goals',
  AWAITING_GOAL_REVIEW: 'Waiting for the goal review',
  AWAITING_SELF_ENTRY: 'Waiting for the self-entry',
  AWAITING_MANAGER_RATING: 'Waiting for the manager rating',
  AWAITING_REVIEW: 'Waiting for the reviewer confirmation',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};
const SOURCE_LABEL: Record<string, string> = { MANUAL: 'Entered', UPLOAD: 'KRA upload' };
const taskStatusText = (s: string) => TASK_STATUS_LABEL[s] ?? readable(s);
const stepText = (stage: string, level: number | null) => (stage === 'REVIEW' ? `Reviewer confirmation${level ? ` (level ${level})` : ''}` : (STAGE_LABEL[stage] ?? readable(stage)));
function decisionText(decision: string, stage: string): string {
  if (decision === 'RETURN') return 'Returned to the employee';
  if (decision === 'APPROVE') return stage === 'MANAGER_RATING' ? 'Rating submitted' : 'Confirmed';
  return readable(decision);
}
const personLabel = (p: { displayName: string; employeeCode: string }) => `${p.displayName} (${p.employeeCode})`;
function userLabel(u: { userId?: string; employeeCode?: string | null; displayName: string | null } | undefined, myUserId: string | null): string {
  if (!u) return '—';
  if (myUserId !== null && u.userId !== undefined && u.userId === myUserId) return 'You';
  if (u.displayName) return u.employeeCode ? `${u.displayName} (${u.employeeCode})` : u.displayName;
  return 'A user without an employee record';
}
const periodText = (p: { startDate: string; endDate: string }) => `${formatDate(p.startDate)} to ${formatDate(p.endDate)}`;
function windowText(w: { opensOn: string | null; closesOn: string | null } | null | undefined): string {
  return w && w.opensOn && w.closesOn ? `${formatDate(w.opensOn)} to ${formatDate(w.closesOn)}` : 'Not scheduled (entries are refused)';
}
const levelsText = (n: number) =>
  n === 2 ? '2 (a second independent reviewer confirms after the first)' : n === 0 ? 'None (the manager’s approval completes the appraisal)' : '1 (one independent reviewer confirms)';
const ratingModeText = (m: string | undefined) => (m === 'MANUAL' ? 'Manual (the manager’s overall rating is the final rating)' : 'Formula (the weighted manager result is the final rating)');
const yesNo = (v: boolean) => (v ? 'Yes' : 'No');
const goalList = (goals: unknown) => (Array.isArray(goals) && goals.length > 0 ? goals.join(', ') : null);

// ---------------------------------------------------------------------------------------------------------
// Refusals in plain words
// ---------------------------------------------------------------------------------------------------------
type Act =
  | 'setting'
  | 'cycle-create'
  | 'cycle-update'
  | 'cycle-close'
  | 'enrol'
  | 'goals'
  | 'goal-review'
  | 'exception'
  | 'cancel'
  | 'rating'
  | 'decide'
  | 'self-entry'
  | 'submit'
  | 'export'
  | 'upload'
  | 'commit'
  | 'discard'
  | 'scoring'
  | 'competency'
  | 'competency-set';

const isCycleAct = (a: Act) => a === 'setting' || a === 'scoring' || a.startsWith('cycle') || a.startsWith('competency');
const sectionTitle = (code: unknown) =>
  typeof code === 'string' ? ({ IMPROVEMENT_AREAS: 'areas for improvement', TRAINING_NEEDS: 'training needs', ACTIVITY_PERFORMANCE: 'activity performance', STRETCHED_KPIS: 'stretched KPIs' }[code] ?? readable(code).toLowerCase()) : 'section';
/** What is still missing from a self-entry or rating (goals and competencies by number, sections by name). */
function missingText(d: Record<string, unknown>): string {
  const parts: string[] = [];
  const goals = goalList(d.goals);
  if (goals) parts.push(`goal ${goals}`);
  const competencies = goalList(d.competencies);
  if (competencies) parts.push(`competency ${competencies}`);
  if (Array.isArray(d.sections) && d.sections.length > 0) parts.push(`the ${d.sections.map(sectionTitle).join(' and ')} section${d.sections.length > 1 ? 's' : ''}`);
  return parts.length > 0 ? `: still missing ${parts.join(', ')}` : '';
}

const INVALID_STATE_TEXT: Partial<Record<Act, string>> = {
  exception: 'The appraisal is finished, so no exception can be recorded.',
  cancel: 'A completed or cancelled appraisal cannot be cancelled.',
  rating: 'The appraisal is not waiting for a rating any more.',
  decide: 'The appraisal is not waiting for this decision any more.',
  'self-entry': 'The self-entry can change only before it is submitted.',
  submit: 'Only a draft or returned appraisal can be submitted.',
};

/** A refusal in plain words; null for anything else, which is shown as the API sent it. */
function refusalText(error: unknown, action: Act): string | null {
  if (!error) return null;
  if (!(error instanceof ApiError)) {
    return action === 'decide'
      ? 'No answer came back, so your decision may or may not have been recorded. Send the same decision again: it is never applied twice.'
      : 'No answer came back, so the change may or may not have been saved. Reload the page to check before trying again.';
  }
  const d = (error.details ?? {}) as Record<string, unknown>;
  const stageOf = (v: unknown) => (typeof v === 'string' ? (STAGE_LABEL[v] ?? readable(v)).toLowerCase() : 'entry');
  switch (error.code) {
    case 'FORBIDDEN':
      return isCycleAct(action)
        ? 'The selected role is not permitted to do this. Appraisal configuration needs an unrestricted company-scope assignment.'
        : 'The selected role is not permitted to do this.';
    case 'NOT_FOUND':
      if (action === 'decide' || action === 'rating') return 'This task is no longer assigned to you.';
      if (action === 'enrol') return 'The cycle or the employee is not available in the selected role’s scope.';
      if (isCycleAct(action)) return 'This cycle is not available.';
      if (action === 'commit' || action === 'discard') return 'This upload is not available any more.';
      return 'This appraisal is not available in the selected role’s scope.';
    case 'STALE_VERSION':
      return 'It changed since it was loaded. It has been reloaded: check it and try again.';
    case 'INVALID_STATE':
      return INVALID_STATE_TEXT[action] ?? null;
    case 'APPRAISAL_NOT_CONFIGURED':
      return 'Set the cycle start month first: cycles cannot be created until it is set.';
    case 'CYCLE_START_NOT_ALIGNED': {
      const month = MONTH_NAME[Number(d.cycleStartMonth)];
      return `A cycle starts on the 1st of ${month ?? 'the configured cycle start month'}${month ? ', the configured cycle start month' : ''}.`;
    }
    case 'INVALID_CODE':
      return 'Use 1 to 40 letters, digits, hyphens or underscores for the code.';
    case 'CYCLE_CODE_EXISTS':
      return 'A cycle with this code already exists.';
    case 'INVALID_WINDOW':
      return `The ${stageOf(d.stage)} window closes before it opens.`;
    case 'WINDOW_ORDER':
      return `Windows follow the process order: goal setting, then self-entry, then manager rating. The ${stageOf(d.later)} window opens or closes before the ${stageOf(d.earlier)} window.`;
    case 'LEVELS_FIXED':
      return 'The reviewer levels cannot change once an appraisal of this cycle has been submitted.';
    case 'RULES_FIXED':
      return 'The goal review and the rating mode cannot change once an appraisal of this cycle has been submitted.';
    // I-86: the result split, competencies and sections.
    case 'SPLIT_NOT_100':
      return 'The goal and competency percentages are whole numbers that add up to exactly 100 (goals at least 1).';
    case 'APPRAISAL_SCORING_NOT_CONFIGURED':
      return 'No goal and competency split is in force on the cycle start date. Set one in the competency settings, or give the cycle its own.';
    case 'COMPETENCY_USE_FIXED':
      return 'Whether this cycle assesses competencies cannot change: an appraisal is already enrolled in it. The split itself can still change until one is submitted.';
    case 'UNKNOWN_SECTION':
    case 'DUPLICATE_SECTION':
      return 'Choose each section once, from the section list.';
    case 'SECTION_NOT_INCLUDED':
      return `This cycle does not include the ${sectionTitle(d.section)} section.`;
    case 'SECTION_NOT_FILLED_BY_YOU':
      return `The ${sectionTitle(d.section)} section is filled by ${action === 'self-entry' ? 'the manager' : 'the employee'}.`;
    case 'UNKNOWN_COMPETENCY':
    case 'DUPLICATE_COMPETENCY':
      return action === 'competency-set' ? 'Choose each competency once, from the competency list.' : 'The competencies changed since this was loaded. Reload and try again.';
    case 'INVALID_INDICATORS':
      return 'Describe each proficiency level 1 to 5 with one behavioural indicator.';
    case 'COMPETENCY_CODE_EXISTS':
      return 'A competency with this code already exists.';
    case 'COMPETENCY_IN_USE':
      return 'This competency is used in a set that is still in force: replace or end that set first. The start of a competency in use is fixed.';
    case 'COMPETENCY_ENDED':
      return 'An ended competency stays ended; add a new competency instead.';
    case 'COMPETENCY_NOT_ACTIVE':
      return 'Each competency in a set is active from the set’s start date and has no end date.';
    case 'COMPETENCIES_REQUIRED':
      return 'A set holds 1 to 50 competencies.';
    case 'UNKNOWN_GRADE':
      return 'Choose a grade.';
    case 'UNKNOWN_DESIGNATION':
      return 'Choose a designation, or none.';
    case 'SET_ALREADY_PLANNED':
      return 'A set for this grade and designation already starts on or after that date; choose a later start date.';
    case 'SET_OVERLAP':
      return 'A set for this grade and designation is already in force past that date.';
    case 'SET_ENDED':
      return 'This set already has its end date.';
    case 'EFFECTIVE_DATE_IN_PAST':
      return 'A new revision starts today or later; earlier periods are not changed.';
    case 'REVISION_ALREADY_PLANNED':
      return 'A split already starts on or after that date; choose a later start date.';
    case 'INVALID_DATE_RANGE':
      return 'The end date is after the start date.';
    case 'REVIEW_DUE_REQUIRED':
      return 'Set the review due date: with reviewer levels, the date reviewer confirmations are due is required.';
    case 'REVIEW_DUE_NOT_USED':
      return 'A cycle without reviewer levels has no reviewer confirmations, so leave the review due date empty.';
    case 'REVIEW_DUE_BEFORE_RATING':
      return `Reviewer confirmations cannot be due before the manager-rating window closes${typeof d.ratingClosesOn === 'string' ? ` (${formatDate(d.ratingClosesOn)})` : ''}.`;
    case 'GOALS_NOT_REVIEWED':
      return 'Your goals have not been reviewed yet, so they have not taken effect. You can enter your self-entry once they are.';
    case 'GOAL_REVIEW_NOT_REQUIRED':
      return 'This cycle does not review goals: they take effect when set.';
    case 'GOAL_REVIEW_NOT_INDEPENDENT':
      return 'You set these goals, so someone else reviews them.';
    case 'GOALS_ALREADY_REVIEWED':
      return 'These goals have already been reviewed.';
    case 'GOALS_SETTER_UNKNOWN':
      return 'These goals were set before goal reviews were recorded. Save the goals again, then someone else reviews them.';
    case 'OVERALL_RATING_REQUIRED':
      return 'Choose and save the overall rating before submitting the rating: this cycle rates manually.';
    case 'OVERALL_RATING_NOT_USED':
      return 'This cycle rates by the weighted formula, so there is no overall rating to enter.';
    case 'REVIEWER_SCORE_REQUIRED':
      return 'Choose your overall score (1 to 5) to confirm the rating.';
    case 'REVIEWER_SCORE_NOT_USED':
      return 'A reviewer score is given only with a confirmation.';
    case 'CYCLE_CLOSED':
      return action === 'cycle-close' ? 'The cycle is already closed.' : 'The appraisal cycle is closed.';
    case 'OPEN_APPRAISALS': {
      const open = Number(d.open);
      return `Complete or cancel every appraisal of the cycle before closing it${Number.isFinite(open) ? `: ${open} ${open === 1 ? 'is' : 'are'} still open` : ''}.`;
    }
    case 'SELF_ACTION_NOT_ALLOWED':
      return 'You cannot manage your own appraisal: another authorised user does that.';
    case 'EMPLOYEE_NOT_ACTIVE':
      return 'Only an active employee can be appraised.';
    case 'JOINED_AFTER_CYCLE':
      return 'The employee joined after this cycle ends.';
    case 'APPRAISAL_EXISTS':
      return 'The employee already has an appraisal in this cycle.';
    case 'CYCLE_OVERLAP':
      return 'The employee already has an appraisal in an overlapping cycle.';
    case 'INVALID_SEQUENCE':
      return 'Goal sequences are whole numbers from 1 to 100.';
    case 'DUPLICATE_SEQUENCE':
      return `Each goal needs its own sequence number${d.sequence !== undefined ? `: ${String(d.sequence)} is used twice` : ''}.`;
    case 'INVALID_WEIGHT':
      return 'Goal weights are whole numbers from 1 to 100.';
    case 'FIELD_REQUIRED':
      return d.sequence !== undefined ? `Goal ${String(d.sequence)} needs a description.` : d.field === 'reason' ? 'Enter a reason.' : 'Fill in every required field.';
    case 'GOALS_FIXED':
      return action === 'goal-review' ? 'Goals are reviewed before the appraisal is first submitted.' : 'Goals are fixed once the appraisal has been submitted.';
    case 'WINDOW_CLOSED':
      return `The ${stageOf(d.stage)} window is not open today (${windowText({ opensOn: (d.opensOn as string | null) ?? null, closesOn: (d.closesOn as string | null) ?? null }).toLowerCase()}) and no exception is recorded${action === 'self-entry' || action === 'submit' ? '. Ask HR for an exception if you need more time.' : '.'}`;
    case 'INVALID_DATE':
      return d.field === 'validUntil' ? 'An exception is valid through today or a later date.' : 'Enter a valid calendar date.';
    case 'TASK_CLOSED':
      return 'This task has already been decided.';
    case 'NOT_RATING_TASK':
      return 'Only the rating step enters manager scores.';
    case 'UNKNOWN_GOAL':
    case 'DUPLICATE_GOAL':
      return 'The goals changed since this was loaded. Reload and try again.';
    case 'RATING_INCOMPLETE': {
      const goals = goalList(d.goals);
      if (goalList(d.competencies) || (Array.isArray(d.sections) && d.sections.length > 0)) {
        return `Score every goal and competency and fill every included section, and save, before submitting the rating${missingText(d)}.`;
      }
      return `Score every goal and save before submitting the rating${goals ? `: goal ${goals} ${Array.isArray(d.goals) && d.goals.length > 1 ? 'have' : 'has'} no saved score` : ''}.`;
    }
    case 'EMPLOYEE_MESSAGE_REQUIRED':
      return 'Tell the employee what to revise before returning the appraisal.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'Nothing was recorded: this attempt was matched to a different decision. Send your decision again.';
    case 'GOALS_REQUIRED':
      return 'The appraisal has no goals yet. Ask HR or your manager to set them.';
    case 'WEIGHT_TOTAL_NOT_100': {
      const total = typeof d.total === 'number' ? d.total : null;
      if (action === 'competency-set') return `The competency weights total ${total ?? 'something other than 100'}; they must total exactly 100.`;
      return `The goal weights total ${total ?? 'something other than 100'}; they must total exactly 100 before the appraisal can be submitted.${action === 'submit' ? ' Ask HR or your manager to correct the goals.' : ''}`;
    }
    case 'SELF_ENTRY_INCOMPLETE': {
      const goals = goalList(d.goals);
      if (goalList(d.competencies) || (Array.isArray(d.sections) && d.sections.length > 0)) {
        return `Score every goal and competency and fill every section this cycle asks of you, and save, before submitting${missingText(d)}.`;
      }
      return `Score every goal and save before submitting${goals ? `: goal ${goals} ${Array.isArray(d.goals) && d.goals.length > 1 ? 'have' : 'has'} no saved score` : ''}.`;
    }
    case 'NO_ELIGIBLE_REVIEWER':
      return action === 'decide'
        ? 'No eligible reviewer is left for the next step. Ask HR to add a reviewer to the appraisal reviewer list; your decision was not recorded.'
        : 'No eligible rater or reviewer is set up for this appraisal. Ask HR to repair the reviewer list; nothing was submitted.';
    case 'WORKFLOW_NOT_CONFIGURED':
      return 'No approval route is set up for appraisals yet. Ask HR to configure it; nothing was submitted.';
    case 'EMPLOYEE_CONTEXT_REQUIRED':
      return 'Select your Employee role to work on your own appraisal.';
    case 'EXPORT_TOO_LARGE':
      return `An export holds at most ${typeof d.limit === 'number' ? d.limit.toLocaleString('en-IN') : 'a limited number of'} rows; narrow it with the department filter. Nothing was cut off.`;
    case 'INVALID_HEADER':
      return 'The file’s first line is not the APPRAISAL_GOALS_V1 header: cycleCode,employeeCode,sequence,description,target,weight.';
    case 'IDEMPOTENCY_KEY_IN_USE':
      return 'This upload attempt was already used. Choose the file again and upload it.';
    // FR-106: an upload is read only once the malware scan has released it (imports/jobs.ts).
    case 'FILE_QUARANTINED':
      return 'The malware scan flagged this file, so nothing in it was read or applied. Upload a clean copy of the file.';
    case 'FILE_NOT_RELEASED':
      return 'The file is still waiting for the malware scan, so it cannot be committed yet. Check the scan again later.';
    case 'FILE_INTEGRITY':
      return 'The file stored for this upload no longer matches what was uploaded, so it was not read. Discard this upload and upload the file again.';
    case 'RETRY':
      return 'Your change met another change at the same moment. Try again.';
    default:
      return null;
  }
}

function Refusal({ error, action }: { error: unknown; action: Act }) {
  if (!error) return null;
  const text = refusalText(error, action);
  return text === null ? (
    <ErrorNote error={error} />
  ) : (
    <p role="alert" className="error">
      {text}
    </p>
  );
}

function NotPermitted({ children }: { children: ReactNode }) {
  return (
    <p role="note">
      <Badge tone="warn">not permitted</Badge> {children}
    </p>
  );
}

function QueryProblem({ error, forbidden }: { error: unknown; forbidden: string }) {
  if (!error) return null;
  if (isForbidden(error)) return <NotPermitted>{forbidden}</NotPermitted>;
  if (error instanceof ApiError && error.code === 'EMPLOYEE_CONTEXT_REQUIRED') return <Empty>{refusalText(error, 'submit')}</Empty>;
  return <ErrorNote error={error} />;
}

function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Notice({ notice }: { notice: { text: string; ok: boolean } | null }) {
  if (!notice) return null;
  return (
    <p className={notice.ok ? 'ok' : 'error'} role={notice.ok ? 'status' : 'alert'}>
      {notice.text}
    </p>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Lookups: cycles, departments, employees
// ---------------------------------------------------------------------------------------------------------

function useCycles(enabled = true) {
  const { can } = useSession();
  const keys = useKeys();
  return useQuery({
    queryKey: keys.cycleList(''),
    queryFn: () => api<{ items: Cycle[] }>('/v1/appraisal-cycles'),
    enabled: enabled && can(CYCLE_READ),
    retry: retryTransient,
  });
}

function useDepartments() {
  const { can } = useSession();
  const keys = useKeys();
  return useQuery({
    queryKey: keys.departments,
    queryFn: () => api<{ items: MasterItem[] }>('/v1/org/departments'),
    enabled: can(ORG_READ),
    retry: retryTransient,
    staleTime: 5 * 60_000,
  });
}

function CycleSelect({ label, value, onChange, openOnly, allLabel }: { label: string; value: string; onChange: (id: string) => void; openOnly?: boolean; allLabel?: string }) {
  const cycles = useCycles();
  const items = (shown(cycles)?.items ?? []).filter((c) => !openOnly || c.state === 'OPEN');
  return (
    <>
      <label>
        {label}
        <select value={value} onChange={(e) => onChange(e.target.value)} required={!allLabel}>
          <option value="">{cycles.isLoading ? 'Loading…' : (allLabel ?? 'Choose…')}</option>
          {items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code}: {c.name} ({c.state === 'OPEN' ? 'open' : 'closed'})
            </option>
          ))}
        </select>
      </label>
      {cycles.error ? <QueryProblem error={cycles.error} forbidden="The selected role cannot list appraisal cycles." /> : null}
    </>
  );
}

function DepartmentSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { can } = useSession();
  const departments = useDepartments();
  if (!can(ORG_READ)) return null;
  return (
    <label>
      Department
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All in scope</option>
        {(shown(departments)?.items ?? []).map((d) => (
          <option key={d.id} value={d.id}>
            {d.name} ({d.code})
          </option>
        ))}
      </select>
    </label>
  );
}

/** Whom to enrol: an employee found by an employee search (the server checks row scope and refuses one's own record). */
function EmployeePicker({ value, onChange }: { value: EmployeeHit | null; onChange: (e: EmployeeHit | null) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const canSearch = can(EMPLOYEE_LIST);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const hits = useQuery({
    queryKey: keys.employeeSearch(term),
    queryFn: () => api<{ items: EmployeeHit[]; total: number }>(`/v1/employees?${new URLSearchParams({ search: term, page: '1', pageSize: '25' }).toString()}`),
    enabled: canSearch && term !== '',
    retry: retryTransient,
  });
  if (!canSearch) return <NotPermitted>The selected role cannot search employees, so it cannot choose whom to enrol.</NotPermitted>;
  const found = term !== '' ? shown(hits) : undefined;
  return (
    <div className="wide">
      <p style={FLUSH}>
        Employee to appraise: <strong>{value ? personLabel(value) : 'none chosen yet'}</strong>{' '}
        {value && (
          <button type="button" className="secondary" onClick={() => onChange(null)}>
            Clear
          </button>
        )}
      </p>
      <label>
        Find the employee
        <input type="search" value={search} maxLength={100} placeholder="Name, employee code or work email" onChange={(e) => setSearch(e.target.value)} />
      </label>
      {term !== '' && hits.isLoading && <p className="hint">Searching…</p>}
      <QueryProblem error={hits.error} forbidden="The selected role cannot search employees." />
      {found && found.items.length === 0 && <Empty>No employees match “{term}”.</Empty>}
      {found && found.items.length > 0 && (
        <ul className="choices" aria-label="Matching employees">
          {found.items.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                aria-label={`Choose ${personLabel(e)}`}
                onClick={() => {
                  onChange(e);
                  setSearch('');
                  setTerm('');
                }}
              >
                {personLabel(e)} · {readable(e.status).toLowerCase()}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Goals: the editor (FR-041) and read-only tables
// ---------------------------------------------------------------------------------------------------------
interface GoalDraft {
  key: number;
  sequence: string;
  description: string;
  target: string;
  weight: string;
}
const draftsOf = (goals: Goal[]): GoalDraft[] =>
  goals.map((g, i) => ({ key: i + 1, sequence: String(g.sequence), description: g.description, target: g.target ?? '', weight: String(g.weight) }));
const wholeIn = (text: string, min: number, max: number) => WHOLE.test(text.trim()) && Number(text) >= min && Number(text) <= max;

/** The goals as the API takes them, or what to correct first (the server checks every rule again). */
function goalsBody(drafts: GoalDraft[]): { goals: GoalInput[] } | { problem: string } {
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

function GoalsEditor({ drafts, onChange }: { drafts: GoalDraft[]; onChange: (next: GoalDraft[]) => void }) {
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

function GoalsTable({ a, label }: { a: Appraisal; label: string }) {
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
function EntriesTable({ goals, set, label }: { goals: Goal[]; set: EntrySet; label: string }) {
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

// ---------------------------------------------------------------------------------------------------------
// FR-041 competencies and FR-042 sections (I-86): the copied competencies with their behavioural indicators, their
// scores as the server returned them, the section texts, and the results the formula combined
// ---------------------------------------------------------------------------------------------------------

/** The behavioural indicator of each proficiency level 1 to 5 (the F1 scale). */
function IndicatorList({ item }: { item: Pick<CompetencyItem, 'name' | 'description' | 'indicators'> }) {
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

function CompetenciesTable({ a, label }: { a: Appraisal; label: string }) {
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

function CompetencyEntriesTable({ items, entries, label }: { items: CompetencyItem[]; entries: CompetencyEntry[]; label: string }) {
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

function SectionTexts({ sections, texts, label }: { sections: SectionInfo[]; texts: SectionText[] | undefined; label: string }) {
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
function SectionsTable({ a, label }: { a: Appraisal; label: string }) {
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
function RatingResults({ rating }: { rating: ManagerRating }) {
  return (
    <p style={FLUSH}>
      Weighted manager result: <strong>{rating.weightedResult ?? 'not calculated yet (calculated when the rating is submitted)'}</strong>
      {rating.split && rating.goalResult && rating.competencyResult && (
        <>
          {' '}
          = ({rating.split.goalWeightPercent} × goal result {rating.goalResult} + {rating.split.competencyWeightPercent} × competency result {rating.competencyResult}) / 100, rounded half up to two
          decimals
        </>
      )}
      {!rating.split && rating.goalResult && <> (the goal result alone: no competencies)</>}
    </p>
  );
}

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
function ScoreForm({
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
    <form aria-label={label} onSubmit={submit} noValidate style={SPACED}>
      {goals.map((g) => {
        const d = drafts[g.id] ?? { score: '', comment: '' };
        return (
          <fieldset key={g.id} style={GROUP} aria-label={`Goal ${g.sequence}`}>
            <legend>
              Goal {g.sequence}: {g.description} (weight {g.weight})
            </legend>
            {g.target && <p className="hint" style={FLUSH}>Target: {g.target}</p>}
            {hiddenSaved(g) && d.score === '' && (
              <p className="hint" style={FLUSH}>
                A score is already saved for this goal but is not shown to the selected role; choosing a score here replaces it.
              </p>
            )}
            <div className="row">
              <label>
                Score (1 to 5)
                <select value={d.score} onChange={(e) => set(g.id, { score: e.target.value })}>
                  <option value="">Not scored</option>
                  {SCORES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Comment on goal {g.sequence} (optional)
              <textarea rows={2} maxLength={2000} value={d.comment} onChange={(e) => set(g.id, { comment: e.target.value })} style={TEXTAREA} />
            </label>
          </fieldset>
        );
      })}
      {competencyItems.map((k) => {
        const d = competencyDrafts[k.id] ?? { score: '', comment: '' };
        return (
          <fieldset key={k.id} style={GROUP} aria-label={`Competency ${k.sequence}`}>
            <legend>
              Competency {k.sequence}: {k.name} (weight {k.weight})
            </legend>
            <IndicatorList item={k} />
            <div className="row">
              <label>
                Score for {k.name} (1 to 5)
                <select value={d.score} onChange={(e) => setCompetency(k.id, { score: e.target.value })}>
                  <option value="">Not scored</option>
                  {SCORES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Comment on {k.name} (optional)
              <textarea rows={2} maxLength={2000} value={d.comment} onChange={(e) => setCompetency(k.id, { comment: e.target.value })} style={TEXTAREA} />
            </label>
          </fieldset>
        );
      })}
      {sectionItems.map((s) => (
        <label key={s.code} className="wide">
          {s.title} (required in this cycle)
          <span className="hint" style={{ display: 'block' }}>
            {s.prompts[sections!.party] ?? s.meaning}
          </span>
          <textarea rows={3} maxLength={4000} value={texts[s.code] ?? ''} onChange={(e) => setTexts((prev) => ({ ...prev, [s.code]: e.target.value }))} style={TEXTAREA} />
        </label>
      ))}
      {overall !== undefined && (
        <div className="row">
          <label>
            Overall rating (1 to 5)
            <select value={overallDraft} onChange={(e) => setOverallDraft(e.target.value)}>
              <option value="">Not rated</option>
              {SCORES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <span className="hint">This cycle rates manually: the overall rating becomes the final rating; the weighted result is kept beside it.</span>
        </div>
      )}
      <label>
        Overall comment (optional)
        <textarea rows={3} maxLength={4000} value={comment} onChange={(e) => setComment(e.target.value)} style={TEXTAREA} />
      </label>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : saveLabel}
        </button>
        {dirty && <span className="hint">Unsaved changes</span>}
      </div>
      {children}
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screen: cycles (setting, register, a new cycle) and a cycle's detail
// ---------------------------------------------------------------------------------------------------------

function CyclesScreen() {
  const { can } = useSession();
  if (!can(CYCLE_READ)) {
    return (
      <Section title="Appraisal cycles">
        <NotPermitted>The selected role cannot view appraisal cycles.</NotPermitted>
      </Section>
    );
  }
  return (
    <div className="stack">
      <SettingSection />
      <CycleRegister />
      {can(CYCLE_MANAGE) && <NewCycleSection />}
    </div>
  );
}

function useSetting() {
  const keys = useKeys();
  return useQuery({ queryKey: keys.setting, queryFn: () => api<Setting>('/v1/appraisal-settings'), retry: retryTransient });
}

function SettingSection() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const setting = useSetting();
  const [month, setMonth] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: { cycleStartMonth: number; expectedVersion?: number }) => api<Setting>('/v1/appraisal-settings', { method: 'PUT', body }),
    onSuccess: (s) => {
      setMonth('');
      setNotice(`Saved: cycles start on the 1st of ${MONTH_NAME[s.cycleStartMonth ?? 0] ?? 'the chosen month'}.`);
      void qc.invalidateQueries({ queryKey: keys.setting });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'STALE_VERSION') void qc.invalidateQueries({ queryKey: keys.setting });
    },
  });
  const data = shown(setting);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!data || !month || save.isPending) return;
    setNotice(null);
    save.mutate({ cycleStartMonth: Number(month), ...(data.configured && data.version !== null ? { expectedVersion: data.version } : {}) });
  };
  return (
    <Section title="Cycle start month">
      {setting.isPending && <p className="hint">Loading the setting…</p>}
      <QueryProblem error={setting.error} forbidden="The selected role cannot view the appraisal setting." />
      {data &&
        (data.configured && data.cycleStartMonth !== null ? (
          <p>
            Cycles start on the 1st of <strong>{MONTH_NAME[data.cycleStartMonth] ?? data.cycleStartMonth}</strong> and run twelve months.
          </p>
        ) : (
          <p role="note">
            <Badge tone="warn">not set</Badge> No cycle start month is set, so cycles cannot be created yet. There is no default.
          </p>
        ))}
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
      {data && can(CYCLE_MANAGE) && (
        <form className="grid-form" aria-label="Set the cycle start month" onSubmit={submit} noValidate>
          <label>
            Cycle start month
            <select value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="">Choose…</option>
              {START_MONTHS.map(([m, label]) => (
                <option key={m} value={String(m)}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button type="submit" disabled={save.isPending || !month}>
              {save.isPending ? 'Saving…' : 'Save the start month'}
            </button>
          </div>
          <Refusal error={save.error} action="setting" />
        </form>
      )}
    </Section>
  );
}

function CycleRegister() {
  const keys = useKeys();
  const [state, setState] = useState('');
  const cycles = useQuery({
    queryKey: keys.cycleList(state),
    queryFn: () => api<{ items: Cycle[] }>(`/v1/appraisal-cycles${state ? `?state=${state}` : ''}`),
    retry: retryTransient,
  });
  const data = shown(cycles);
  return (
    <Section title="Cycles">
      <div className="row">
        <label>
          State
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All</option>
            <option value="OPEN">Open</option>
            <option value="CLOSED">Closed</option>
          </select>
        </label>
      </div>
      {cycles.isPending && <p className="hint">Loading cycles…</p>}
      <QueryProblem error={cycles.error} forbidden="The selected role cannot view appraisal cycles." />
      {data && data.items.length === 0 && <Empty>No cycles yet.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Appraisal cycles">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Period</th>
                <th>Reviewer levels</th>
                <th>Goal setting</th>
                <th>Self-entry</th>
                <th>Manager rating</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={PATHS.cycle(c.id)}>{c.code}</Link>
                  </td>
                  <td>{c.name}</td>
                  <td>{periodText(c)}</td>
                  <td>{c.approvalLevels}</td>
                  {WINDOWS.map((w) => (
                    <td key={w.key}>
                      {windowText(c.windows[w.key])}
                      {c.windows[w.key]?.openToday ? ' (open today)' : ''}
                    </td>
                  ))}
                  <td>
                    <StateBadge state={c.state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

type WindowDraft = Record<WindowKey, { opensOn: string; closesOn: string }>;
interface CycleBody {
  code?: string;
  name: string;
  startDate?: string;
  approvalLevels: 0 | 1 | 2;
  windows: Record<WindowKey, { opensOn: string; closesOn: string } | null>;
  goalReviewRequired: boolean;
  ratingMode: RatingMode;
  /** Required with reviewer levels; null without them. */
  reviewDueOn: string | null;
  /** I-86: both or neither (a new cycle without them takes the company split in force on its start date). */
  goalWeightPercent?: number;
  competencyWeightPercent?: number;
  /** FR-042 sections included (omitted: unchanged, or none on a new cycle). */
  sections?: string[];
}

/** FR-042 section catalogue (GET /v1/appraisal-sections). */
function useSectionCatalogue(enabled = true) {
  const keys = useKeys();
  return useQuery({ queryKey: keys.sections, queryFn: () => api<{ items: SectionInfo[] }>('/v1/appraisal-sections'), enabled, retry: retryTransient, staleTime: 5 * 60_000 });
}

/**
 * A new cycle (code, name, start date, levels, windows, process rules) or an open cycle's name, levels, windows and rules.
 * Process rules decided under owner delegation (I-77): goal review is on and the rating mode is the formula unless HR says
 * otherwise; reviewer levels may be none (the manager's approval completes the appraisal); with reviewer levels the review
 * due date is required.
 */
function CycleForm({
  initial,
  label,
  submitLabel,
  busy,
  startMonth,
  onSubmit,
  children,
}: {
  initial: Cycle | null;
  label: string;
  submitLabel: string;
  busy: boolean;
  startMonth: number | null;
  onSubmit: (body: CycleBody) => void;
  children?: ReactNode;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState(initial?.name ?? '');
  const [startDate, setStartDate] = useState('');
  const [levels, setLevels] = useState(String(initial?.approvalLevels ?? 1));
  const [goalReview, setGoalReview] = useState(initial?.goalReviewRequired ?? true);
  const [ratingMode, setRatingMode] = useState<RatingMode>(initial?.ratingMode ?? 'FORMULA');
  const [reviewDueOn, setReviewDueOn] = useState(initial?.reviewDueOn ?? '');
  const [windows, setWindows] = useState<WindowDraft>(
    () => Object.fromEntries(WINDOWS.map((w) => [w.key, { opensOn: initial?.windows[w.key]?.opensOn ?? '', closesOn: initial?.windows[w.key]?.closesOn ?? '' }])) as WindowDraft,
  );
  // I-86: the cycle's own split (blank on a new cycle: the company split in force on its start date) and FR-042 sections.
  const [goalPercent, setGoalPercent] = useState(initial?.scoring ? String(initial.scoring.goalWeightPercent) : '');
  const [competencyPercent, setCompetencyPercent] = useState(initial?.scoring ? String(initial.scoring.competencyWeightPercent) : '');
  const [sections, setSections] = useState<string[]>(initial?.sections?.map((s) => s.code) ?? []);
  const catalogue = useSectionCatalogue();
  const [problem, setProblem] = useState<string | null>(null);
  const setWindow = (key: WindowKey, patch: Partial<{ opensOn: string; closesOn: string }>) => setWindows((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!initial && !code.trim()) return setProblem('Enter a code for the cycle.');
    if (!name.trim()) return setProblem('Enter a name for the cycle.');
    if (!initial && !startDate) return setProblem('Enter the start date.');
    const out = {} as CycleBody['windows'];
    for (const w of WINDOWS) {
      const v = windows[w.key];
      if (!v.opensOn && !v.closesOn) out[w.key] = null;
      else if (v.opensOn && v.closesOn) out[w.key] = { opensOn: v.opensOn, closesOn: v.closesOn };
      else return setProblem(`Enter both dates of the ${w.label.toLowerCase()} window, or neither to leave it unscheduled.`);
    }
    const approvalLevels = levels === '2' ? 2 : levels === '0' ? 0 : 1;
    if (approvalLevels > 0 && !reviewDueOn) return setProblem('Enter the review due date: the date reviewer confirmations are due.');
    const g = goalPercent.trim();
    const c = competencyPercent.trim();
    let split: { goalWeightPercent: number; competencyWeightPercent: number } | null = null;
    if (g !== '' || c !== '') {
      if (!wholeIn(g, 1, 100) || !wholeIn(c, 0, 99) || Number(g) + Number(c) !== 100) {
        return setProblem('The goal and competency percentages are whole numbers that add up to exactly 100 (or leave both empty for the company split).');
      }
      split = { goalWeightPercent: Number(g), competencyWeightPercent: Number(c) };
    }
    // Sent only when changed: omitted means unchanged (or, on a new cycle, the company split and no sections).
    if (split && initial?.scoring && split.goalWeightPercent === initial.scoring.goalWeightPercent && split.competencyWeightPercent === initial.scoring.competencyWeightPercent) split = null;
    const initialSections = initial?.sections?.map((s) => s.code) ?? [];
    const sectionsChanged = sections.length !== initialSections.length || sections.some((s) => !initialSections.includes(s));
    setProblem(null);
    onSubmit({
      ...(initial ? {} : { code: code.trim(), startDate }),
      name: name.trim(),
      approvalLevels,
      windows: out,
      goalReviewRequired: goalReview,
      ratingMode,
      reviewDueOn: approvalLevels > 0 ? reviewDueOn : null,
      ...(split ?? {}),
      ...(sectionsChanged ? { sections } : {}),
    });
  };
  return (
    <form className="grid-form" aria-label={label} onSubmit={submit} noValidate>
      {!initial && (
        <label>
          Code
          <input value={code} maxLength={40} onChange={(e) => setCode(e.target.value)} />
        </label>
      )}
      <label>
        Name
        <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </label>
      {!initial && (
        <div>
          <label>
            Start date
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <p className="hint" style={FLUSH}>
            {startMonth ? `The 1st of ${MONTH_NAME[startMonth] ?? 'the configured month'}; the cycle runs twelve months.` : 'Set the cycle start month first.'}
          </p>
        </div>
      )}
      <label>
        Reviewer levels
        <select value={levels} onChange={(e) => setLevels(e.target.value)}>
          <option value="1">{levelsText(1)}</option>
          <option value="2">{levelsText(2)}</option>
          <option value="0">{levelsText(0)}</option>
        </select>
      </label>
      {levels !== '0' && (
        <div>
          <label>
            Review due date
            <input type="date" value={reviewDueOn} onChange={(e) => setReviewDueOn(e.target.value)} />
          </label>
          <p className="hint" style={FLUSH}>
            Reviewer confirmations are due on this date (on or after the manager-rating window closes); later ones count as overdue.
          </p>
        </div>
      )}
      <label>
        Rating mode
        <select value={ratingMode} onChange={(e) => setRatingMode(e.target.value === 'MANUAL' ? 'MANUAL' : 'FORMULA')}>
          <option value="FORMULA">{ratingModeText('FORMULA')}</option>
          <option value="MANUAL">{ratingModeText('MANUAL')}</option>
        </select>
      </label>
      <label>
        <input type="checkbox" checked={goalReview} onChange={(e) => setGoalReview(e.target.checked)} /> Goals are reviewed before they take effect (KRA review)
      </label>
      <fieldset style={GROUP} className="wide">
        <legend>Result split (whole percentages adding to 100)</legend>
        <div className="row">
          <label>
            Goals %
            <input inputMode="numeric" value={goalPercent} maxLength={3} onChange={(e) => setGoalPercent(e.target.value)} />
          </label>
          <label>
            Competencies %
            <input inputMode="numeric" value={competencyPercent} maxLength={2} onChange={(e) => setCompetencyPercent(e.target.value)} />
          </label>
        </div>
        <p className="hint" style={FLUSH}>
          {initial
            ? 'Competencies 0 means the cycle does not assess them. Whether it does is fixed once an appraisal is enrolled; the split is fixed once one is submitted.'
            : 'Leave both empty to use the company split in force on the start date. Competencies 0 means the cycle does not assess them.'}
        </p>
      </fieldset>
      <fieldset style={GROUP} className="wide">
        <legend>Sections included (none is scored)</legend>
        {catalogue.isPending && <p className="hint">Loading the sections…</p>}
        {(shown(catalogue)?.items ?? []).map((s) => (
          <label key={s.code}>
            <input
              type="checkbox"
              checked={sections.includes(s.code)}
              onChange={(e) => setSections((prev) => (e.target.checked ? [...prev, s.code] : prev.filter((x) => x !== s.code)))}
            />{' '}
            {s.title}: {s.meaning} Filled by {s.filledBy.map((p) => (p === 'EMPLOYEE' ? 'the employee' : 'the manager')).join(' and ')}.
          </label>
        ))}
        <p className="hint" style={FLUSH}>
          An included section must be filled by its party before they submit; an excluded one never blocks a submission.
        </p>
      </fieldset>
      <fieldset style={GROUP} className="wide">
        <legend>Windows (inclusive dates; leave both dates empty to leave a window unscheduled)</legend>
        {WINDOWS.map((w) => (
          <div className="row" key={w.key}>
            <label>
              {w.label} opens
              <input type="date" value={windows[w.key].opensOn} onChange={(e) => setWindow(w.key, { opensOn: e.target.value })} />
            </label>
            <label>
              {w.label} closes
              <input type="date" value={windows[w.key].closesOn} onChange={(e) => setWindow(w.key, { closesOn: e.target.value })} />
            </label>
          </div>
        ))}
      </fieldset>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
      {children}
    </form>
  );
}

function NewCycleSection() {
  const keys = useKeys();
  const qc = useQueryClient();
  const setting = useSetting();
  const [formKey, setFormKey] = useState(0);
  const [created, setCreated] = useState<Cycle | null>(null);
  const create = useMutation({
    mutationFn: (body: CycleBody) => api<Cycle>('/v1/appraisal-cycles', { body }),
    onSuccess: (c) => {
      setCreated(c);
      setFormKey((k) => k + 1);
      void qc.invalidateQueries({ queryKey: keys.cycles });
    },
  });
  const startMonth = shown(setting)?.cycleStartMonth ?? null;
  return (
    <Section title="New cycle">
      {created && (
        <p className="ok" role="status">
          Created cycle <Link to={PATHS.cycle(created.id)}>{created.code}</Link> for {periodText(created)}.
        </p>
      )}
      <CycleForm
        key={formKey}
        initial={null}
        label="New cycle"
        submitLabel="Create the cycle"
        busy={create.isPending}
        startMonth={startMonth}
        onSubmit={(body) => {
          setCreated(null);
          create.mutate(body);
        }}
      >
        <Refusal error={create.error} action="cycle-create" />
      </CycleForm>
    </Section>
  );
}

function CycleDetailScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(CYCLE_READ)) {
    return (
      <Section title="Appraisal cycle">
        <NotPermitted>The selected role cannot view appraisal cycles.</NotPermitted>
      </Section>
    );
  }
  if (!UUID.test(id)) {
    return (
      <Section title="Appraisal cycle">
        <Empty>This cycle does not exist.</Empty>
      </Section>
    );
  }
  return <CycleDetailView id={id} />;
}

function CycleDetailView({ id }: { id: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const cycle = useQuery({ queryKey: keys.cycle(id), queryFn: () => api<Cycle>(`/v1/appraisal-cycles/${id}`), retry: retryTransient });
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.cycles });
  };
  const update = useMutation({
    mutationFn: (body: CycleBody & { expectedVersion: number }) => api<Cycle>(`/v1/appraisal-cycles/${id}`, { method: 'PUT', body }),
    onSuccess: () => {
      setNotice({ text: 'Saved the cycle.', ok: true });
      refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'STALE_VERSION' || e.code === 'CYCLE_CLOSED')) refresh();
    },
  });
  const close = useMutation({
    mutationFn: (expectedVersion: number) => api<Cycle>(`/v1/appraisal-cycles/${id}/close`, { body: { expectedVersion } }),
    onSuccess: () => {
      setNotice({ text: 'Closed the cycle.', ok: true });
      refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'STALE_VERSION') refresh();
    },
  });
  const c = shown(cycle);
  if (cycle.isPending) return <Section title="Appraisal cycle">{<p className="hint">Loading the cycle…</p>}</Section>;
  if (!c) {
    return (
      <Section title="Appraisal cycle">
        {isNotFound(cycle.error) ? <Empty>This cycle does not exist.</Empty> : <QueryProblem error={cycle.error} forbidden="The selected role cannot view appraisal cycles." />}
      </Section>
    );
  }
  const open = c.state === 'OPEN';
  const busy = update.isPending || close.isPending;
  return (
    <div className="stack">
      <Section title={`Cycle ${c.code}`} actions={<Link to={PATHS.cycles}>All cycles</Link>}>
        <Notice notice={notice} />
        <dl className="kv">
          <Item term="Name">{c.name}</Item>
          <Item term="Period">{periodText(c)}</Item>
          <Item term="Reviewer levels">{levelsText(c.approvalLevels)}</Item>
          {c.approvalLevels > 0 && <Item term="Review due date">{c.reviewDueOn ? formatDate(c.reviewDueOn) : 'Not set: reviewer tasks have no due date until it is'}</Item>}
          <Item term="Goal review">{c.goalReviewRequired ? 'Goals take effect once someone other than their setter reviews them' : 'None: goals take effect when set'}</Item>
          <Item term="Rating mode">{ratingModeText(c.ratingMode)}</Item>
          {c.scoring && (
            <Item term="Result split">
              {c.scoring.competencyWeightPercent > 0
                ? `Goals ${c.scoring.goalWeightPercent}% and competencies ${c.scoring.competencyWeightPercent}% (without mapped competencies, the goal result alone)`
                : 'Goals only: the cycle does not assess competencies'}
            </Item>
          )}
          {c.sections && (
            <Item term="Sections">{c.sections.length > 0 ? c.sections.map((s) => s.title).join(', ') : 'None (only goals and competencies)'}</Item>
          )}
          <Item term="State">
            <StateBadge state={c.state} />
          </Item>
        </dl>
        <div style={SCROLL}>
          <table aria-label="Windows">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Window</th>
                <th>Open today</th>
              </tr>
            </thead>
            <tbody>
              {WINDOWS.map((w) => (
                <tr key={w.key}>
                  <td>{w.label}</td>
                  <td>{windowText(c.windows[w.key])}</td>
                  <td>{c.windows[w.key] ? yesNo(c.windows[w.key]!.openToday) : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">Reviewer confirmation is a decision, not a windowed entry: it falls due on the review due date but is never refused for lateness. Window exceptions are recorded per appraisal.</p>
        {can(READ) && (
          <p>
            <Link to={`${PATHS.appraisals}?cycleId=${c.id}`}>Appraisals in this cycle</Link>
          </p>
        )}
        {can(CYCLE_MANAGE) && open && (
          <div className="row">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                setNotice(null);
                close.mutate(c.version);
              }}
            >
              {close.isPending ? 'Closing…' : 'Close the cycle'}
            </button>
          </div>
        )}
        <Refusal error={close.error} action="cycle-close" />
      </Section>
      {can(CYCLE_MANAGE) && open && (
        <Section title="Change the cycle">
          <p className="hint">
            The code and period never change. Reviewer levels, the goal review, the rating mode, the result split and the sections are fixed once an appraisal of the cycle has been submitted.
          </p>
          <CycleForm
            key={c.version}
            initial={c}
            label="Change the cycle"
            submitLabel="Save the cycle"
            busy={busy}
            startMonth={null}
            onSubmit={(body) => {
              setNotice(null);
              update.mutate({
                name: body.name,
                approvalLevels: body.approvalLevels,
                windows: body.windows,
                goalReviewRequired: body.goalReviewRequired,
                ratingMode: body.ratingMode,
                reviewDueOn: body.reviewDueOn,
                ...(body.goalWeightPercent !== undefined && body.competencyWeightPercent !== undefined
                  ? { goalWeightPercent: body.goalWeightPercent, competencyWeightPercent: body.competencyWeightPercent }
                  : {}),
                ...(body.sections !== undefined ? { sections: body.sections } : {}),
                expectedVersion: c.version,
              });
            }}
          >
            <Refusal error={update.error} action="cycle-update" />
          </CycleForm>
        </Section>
      )}
      {can(REPORT) && <CycleReport cycleId={c.id} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screen: the appraisal register (FR-044 lists within row scope) and enrolment
// ---------------------------------------------------------------------------------------------------------

interface ListFilters {
  cycleId: string;
  state: string;
  departmentId: string;
  page: number;
  pageSize: number;
}
/** FR-041 KRA review: complete goal sets waiting for their review (GET /v1/appraisals?stateGroup=AWAITING_GOAL_REVIEW). */
const GOAL_REVIEW_GROUP = 'AWAITING_GOAL_REVIEW';
function readFilters(params: URLSearchParams): ListFilters {
  const cycleId = params.get('cycleId') ?? '';
  const departmentId = params.get('departmentId') ?? '';
  const state = params.get('stateGroup') === GOAL_REVIEW_GROUP ? GOAL_REVIEW_GROUP : (params.get('state') ?? '');
  const page = Number(params.get('page') ?? '1');
  const pageSize = Number(params.get('pageSize') ?? '25');
  return {
    cycleId: UUID.test(cycleId) ? cycleId : '',
    departmentId: UUID.test(departmentId) ? departmentId : '',
    state: state === GOAL_REVIEW_GROUP || (APPRAISAL_STATES as readonly string[]).includes(state) ? state : '',
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    pageSize: (PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : 25,
  };
}
function listQuery(f: ListFilters): string {
  const q = new URLSearchParams();
  if (f.cycleId) q.set('cycleId', f.cycleId);
  if (f.state === GOAL_REVIEW_GROUP) q.set('stateGroup', f.state);
  else if (f.state) q.set('state', f.state);
  if (f.departmentId) q.set('departmentId', f.departmentId);
  q.set('page', String(f.page));
  q.set('pageSize', String(f.pageSize));
  return q.toString();
}

function AppraisalsScreen() {
  const { can } = useSession();
  if (!can(READ)) {
    return (
      <Section title="Appraisals">
        <NotPermitted>The selected role cannot view appraisals.</NotPermitted>
      </Section>
    );
  }
  return (
    <div className="stack">
      <AppraisalRegister />
      {can(MANAGE) && <EnrolSection />}
    </div>
  );
}

function AppraisalRegister() {
  const keys = useKeys();
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const query = listQuery(filters);
  const list = useQuery({ queryKey: keys.appraisalList(query), queryFn: () => api<AppraisalPage>(`/v1/appraisals?${query}`), retry: retryTransient });
  const data = shown(list);
  const setFilter = (patch: Partial<ListFilters>) => setParams(listQuery({ ...filters, page: 1, ...patch }));
  const withRating = (data?.items ?? []).some((r) => 'finalRating' in r || 'weightedResult' in r);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <Section title="Appraisals">
      <div className="row">
        {can(CYCLE_READ) && <CycleSelect label="Cycle" allLabel="All cycles" value={filters.cycleId} onChange={(cycleId) => setFilter({ cycleId })} />}
        <label>
          State
          <select value={filters.state} onChange={(e) => setFilter({ state: e.target.value })}>
            <option value="">All states</option>
            {APPRAISAL_STATES.map((s) => (
              <option key={s} value={s}>
                {readable(s)}
              </option>
            ))}
            <option value={GOAL_REVIEW_GROUP}>{taskStatusText(GOAL_REVIEW_GROUP)}</option>
          </select>
        </label>
        <DepartmentSelect value={filters.departmentId} onChange={(departmentId) => setFilter({ departmentId })} />
        <label>
          Rows per page
          <select value={String(filters.pageSize)} onChange={(e) => setFilter({ pageSize: Number(e.target.value) })}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={String(n)}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {list.isPending && <p className="hint">Loading appraisals…</p>}
      <QueryProblem error={list.error} forbidden="The selected role cannot view appraisals." />
      {data && data.items.length === 0 && <Empty>No appraisals match.</Empty>}
      {data && data.items.length > 0 && (
        <>
          <div style={SCROLL}>
            <table aria-label="Appraisal register">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Department</th>
                  <th>Cycle</th>
                  <th>State</th>
                  <th>Task status</th>
                  <th>Goals</th>
                  <th>Weight total</th>
                  <th>Revision</th>
                  <th>Source</th>
                  {withRating && <th>Weighted manager result</th>}
                  {withRating && <th>Final rating</th>}
                  <th>Completed</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={PATHS.appraisal(r.id)}>{personLabel(r.employee)}</Link>
                    </td>
                    <td>{r.employee.department?.name ?? '—'}</td>
                    <td>{r.cycle.code}</td>
                    <td>
                      <StateBadge state={r.state} />
                    </td>
                    <td>{taskStatusText(r.taskStatus)}</td>
                    <td>{r.goalCount}</td>
                    <td>{r.goalWeightTotal === 100 ? '100' : `${r.goalWeightTotal} (must be 100)`}</td>
                    <td>{r.revision}</td>
                    <td>{SOURCE_LABEL[r.source] ?? readable(r.source)}</td>
                    {withRating && <td>{r.weightedResult ?? '—'}</td>}
                    {withRating && <td>{r.finalRating ?? '—'}</td>}
                    <td>
                      <When at={r.completedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <button type="button" className="secondary" disabled={filters.page <= 1} onClick={() => setParams(listQuery({ ...filters, page: filters.page - 1 }))}>
              Previous page
            </button>
            <span>
              Page {data.page} of {pages} · {data.total} appraisal{data.total === 1 ? '' : 's'}
            </span>
            <button type="button" className="secondary" disabled={filters.page >= pages} onClick={() => setParams(listQuery({ ...filters, page: filters.page + 1 }))}>
              Next page
            </button>
          </div>
        </>
      )}
    </Section>
  );
}

function EnrolSection() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [cycleId, setCycleId] = useState('');
  const [employee, setEmployee] = useState<EmployeeHit | null>(null);
  const [drafts, setDrafts] = useState<GoalDraft[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: { cycleId: string; employeeId: string; goals?: GoalInput[] }) => api<Appraisal>('/v1/appraisals', { body }),
    onSuccess: (a) => {
      setCycleId('');
      setEmployee(null);
      setDrafts([]);
      void qc.invalidateQueries({ queryKey: keys.appraisals });
      navigate(PATHS.appraisal(a.id));
    },
  });
  if (!can(CYCLE_READ)) {
    return (
      <Section title="Enrol an employee">
        <NotPermitted>The selected role cannot list appraisal cycles, so it cannot choose one to enrol in.</NotPermitted>
      </Section>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    if (!cycleId) return setProblem('Choose an open cycle.');
    if (!employee) return setProblem('Choose the employee to appraise.');
    const g = goalsBody(drafts);
    if ('problem' in g) return setProblem(g.problem);
    setProblem(null);
    create.mutate({ cycleId, employeeId: employee.id, ...(g.goals.length > 0 ? { goals: g.goals } : {}) });
  };
  return (
    <Section title="Enrol an employee">
      <p className="hint">
        Enrols the employee in an open cycle as a draft appraisal. Goals are optional here and can be set later, inside the goal-setting window. Nobody enrols themselves.
      </p>
      <form className="grid-form" aria-label="Enrol an employee" onSubmit={submit} noValidate>
        <CycleSelect label="Cycle" openOnly value={cycleId} onChange={setCycleId} />
        <EmployeePicker value={employee} onChange={setEmployee} />
        <GoalsEditor drafts={drafts} onChange={setDrafts} />
        {problem && (
          <p role="alert" className="error">
            {problem}
          </p>
        )}
        <div className="row">
          <button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Enrolling…' : 'Enrol as a draft'}
          </button>
        </div>
        <Refusal error={create.error} action="enrol" />
      </form>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screen: one appraisal (staff view): goals, windows, revisions, decision history, exceptions, cancellation
// ---------------------------------------------------------------------------------------------------------

function AppraisalDetailScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(READ)) {
    return (
      <Section title="Appraisal">
        <NotPermitted>The selected role cannot view appraisals.</NotPermitted>
      </Section>
    );
  }
  if (!UUID.test(id)) {
    return (
      <Section title="Appraisal">
        <Empty>This appraisal does not exist.</Empty>
      </Section>
    );
  }
  return <AppraisalDetailView id={id} />;
}

const finished = (a: Pick<Appraisal, 'state'>) => a.state === 'APPROVED' || a.state === 'CANCELLED';

function AppraisalDetailView({ id }: { id: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const query = useQuery({ queryKey: keys.appraisal(id), queryFn: () => api<Appraisal>(`/v1/appraisals/${id}`), retry: retryTransient });
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const a = shown(query);
  if (query.isPending) return <Section title="Appraisal">{<p className="hint">Loading the appraisal…</p>}</Section>;
  if (!a) {
    return (
      <Section title="Appraisal">
        {isNotFound(query.error) ? <Empty>This appraisal is not available in the selected role’s scope.</Empty> : <QueryProblem error={query.error} forbidden="The selected role cannot view appraisals." />}
      </Section>
    );
  }
  const myUserId = me?.userId ?? null;
  const own = me?.employeeId !== null && me?.employeeId !== undefined && me.employeeId === a.employee.id;
  const showRemark = a.decisions.some((d) => 'remark' in d);
  const showDecider = a.decisions.some((d) => d.decidedBy !== undefined);
  return (
    <div className="stack">
      <Section title={`Appraisal of ${personLabel(a.employee)}`} actions={<Link to={PATHS.appraisals}>All appraisals</Link>}>
        <Notice notice={notice} />
        {own && <p role="note">This is your own appraisal: it is shown without ratings, decider identities or rating progress. Your self-entry is on My ESS in your Employee role.</p>}
        <dl className="kv">
          <Item term="Department">{a.employee.department?.name ?? '—'}</Item>
          <Item term="Cycle">{can(CYCLE_READ) ? <Link to={PATHS.cycle(a.cycle.id)}>{`${a.cycle.code}: ${a.cycle.name}`}</Link> : `${a.cycle.code}: ${a.cycle.name}`}</Item>
          <Item term="Period">{periodText(a.cycle)}</Item>
          <Item term="State">
            <StateBadge state={a.state} />
          </Item>
          <Item term="Task status">{taskStatusText(a.taskStatus)}</Item>
          <Item term="Revision">{a.revision}</Item>
          <Item term="Source">{SOURCE_LABEL[a.source] ?? readable(a.source)}</Item>
          <Item term="Waiting for">
            {a.pending ? (
              <>
                {stepText(a.pending.stage, a.pending.level)}: {userLabel(a.pending.with, myUserId)}, since <When at={a.pending.assignedAt} />
              </>
            ) : (
              'Nobody'
            )}
          </Item>
          {'finalRating' in a && (
            <Item term={a.cycle.ratingMode === 'MANUAL' ? 'Final rating (confirmed overall rating of the manager)' : 'Final rating (confirmed weighted manager result)'}>
              {a.finalRating ?? 'Not final yet'}
            </Item>
          )}
          <Item term="Completed">
            <When at={a.completedAt} />
          </Item>
          {a.cancelledAt && (
            <Item term="Cancelled">
              <When at={a.cancelledAt} />
            </Item>
          )}
          {a.cancelReason !== undefined && a.cancelReason !== null && <Item term="Cancellation reason">{a.cancelReason}</Item>}
        </dl>
      </Section>

      <Section title="Goals">
        <GoalsTable a={a} label="Goals" />
        {a.goalReview?.required && <GoalReviewBlock a={a} myUserId={myUserId} canReview={can(MANAGE) && !own} onNotice={setNotice} />}
        {can(MANAGE) && !own && a.state === 'DRAFT' && a.revision === 1 && <GoalsForm key={a.version} a={a} onNotice={setNotice} />}
        {a.state !== 'DRAFT' && <p className="hint">Goals are fixed once the appraisal has been submitted.</p>}
      </Section>

      {a.competencies !== undefined && (
        <Section title="Competencies">
          <CompetenciesTable a={a} label="Competencies" />
        </Section>
      )}

      {a.sections !== undefined && a.sections.length > 0 && (
        <Section title="Sections">
          <SectionsTable a={a} label="Sections" />
        </Section>
      )}

      <Section title="Windows">
        <div style={SCROLL}>
          <table aria-label="Entry windows">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Window</th>
                <th>Open today</th>
                <th>Exception through</th>
                <th>Entries accepted today</th>
              </tr>
            </thead>
            <tbody>
              {WINDOWS.map((w) => {
                const s = a.windows[w.key];
                return (
                  <tr key={w.key}>
                    <td>{w.label}</td>
                    <td>{windowText(s)}</td>
                    <td>{s ? yesNo(s.openToday) : '—'}</td>
                    <td>{s?.exceptionUntil ? formatDate(s.exceptionUntil) : '—'}</td>
                    <td>{s ? yesNo(s.entryAllowed) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Revisions">
        {a.revisions.map((r) => (
          <RevisionBlock key={r.revision} a={a} r={r} />
        ))}
      </Section>

      <Section title="Decision history">
        {a.decisions.length === 0 ? (
          <Empty>No decisions yet.</Empty>
        ) : (
          <div style={SCROLL}>
            <table aria-label="Decision history">
              <thead>
                <tr>
                  <th>Revision</th>
                  <th>Step</th>
                  <th>Decision</th>
                  {showDecider && <th>Decided by</th>}
                  {showRemark && <th>Private remark</th>}
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {a.decisions.map((d, i) => (
                  <tr key={`${d.revision}-${d.step}-${i}`}>
                    <td>{d.revision}</td>
                    <td>{stepText(d.stage, d.level)}</td>
                    <td>{decisionText(d.decision, d.stage)}</td>
                    {showDecider && <td>{userLabel(d.decidedBy, myUserId)}</td>}
                    {showRemark && <td>{d.remark ?? '—'}</td>}
                    <td>
                      <When at={d.decidedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Window exceptions">
        <ExceptionsTable a={a} myUserId={myUserId} />
        {can(GRANT_EXCEPTION) && !own && !finished(a) && <ExceptionForm a={a} onNotice={setNotice} />}
      </Section>

      {can(CANCEL) && !own && !finished(a) && (
        <Section title="Cancel the appraisal">
          <CancelForm a={a} onNotice={setNotice} />
        </Section>
      )}
    </div>
  );
}

function RevisionBlock({ a, r }: { a: Appraisal; r: Revision }) {
  return (
    <div style={GROUP} role="group" aria-label={`Revision ${r.revision}`}>
      <h3 style={H3}>
        Revision {r.revision}: <StateBadge state={r.state} />
      </h3>
      <dl className="kv">
        <Item term="Submitted">
          <When at={r.submittedAt} />
        </Item>
        {'ratedAt' in r && (
          <Item term="Rated">
            <When at={r.ratedAt} />
          </Item>
        )}
        <Item term="Returned">
          <When at={r.returnedAt} />
        </Item>
        <Item term="Confirmed">
          <When at={r.confirmedAt} />
        </Item>
        {r.approvalLevels !== undefined && r.approvalLevels !== null && <Item term="Reviewer levels (pinned at submission)">{r.approvalLevels}</Item>}
      </dl>
      {r.employeeMessage && <p style={FLUSH}>Message to the employee: {r.employeeMessage}</p>}
      {r.selfEntry && (
        <>
          <h4 style={H3}>Self-entry</h4>
          <EntriesTable goals={a.goals} set={r.selfEntry} label={`Self-entry of revision ${r.revision}`} />
          <CompetencyEntriesTable items={a.competencies ?? []} entries={r.selfEntry.competencies ?? []} label={`Competency self-entry of revision ${r.revision}`} />
          <SectionTexts sections={a.sections ?? []} texts={r.selfEntry.sections} label={`Employee sections of revision ${r.revision}`} />
        </>
      )}
      {r.managerRating && (
        <>
          <h4 style={H3}>Manager rating</h4>
          <EntriesTable goals={a.goals} set={r.managerRating} label={`Manager rating of revision ${r.revision}`} />
          <CompetencyEntriesTable items={a.competencies ?? []} entries={r.managerRating.competencies ?? []} label={`Competency rating of revision ${r.revision}`} />
          <SectionTexts sections={a.sections ?? []} texts={r.managerRating.sections} label={`Manager sections of revision ${r.revision}`} />
          <RatingResults rating={r.managerRating} />
          {a.cycle.ratingMode === 'MANUAL' && (
            <p style={FLUSH}>
              Overall rating of the manager (the final rating in this cycle): <strong>{r.managerRating.overallRating ?? 'not entered yet'}</strong>
            </p>
          )}
        </>
      )}
      {r.reviewerScores && r.reviewerScores.length > 0 && (
        <>
          <h4 style={H3}>Reviewer scores</h4>
          <ul aria-label={`Reviewer scores of revision ${r.revision}`} style={FLUSH}>
            {r.reviewerScores.map((s) => (
              <li key={s.level}>
                Level {s.level}: <strong>{s.score}</strong> (kept apart; the final rating is the manager’s)
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * FR-041 KRA review (I-77 item 3): whether the goals took effect, who set and reviewed them (staff views), and the review
 * itself for an eligible user other than the setter. The server refuses the setter and anyone out of scope.
 */
function GoalReviewBlock({
  a,
  myUserId,
  canReview,
  onNotice,
}: {
  a: Appraisal;
  myUserId: string | null;
  canReview: boolean;
  onNotice: (n: { text: string; ok: boolean } | null) => void;
}) {
  const keys = useKeys();
  const qc = useQueryClient();
  const review = a.goalReview!;
  const mine = review.setBy?.userId !== undefined && review.setBy.userId === myUserId;
  const reviewable = !review.reviewed && a.state === 'DRAFT' && a.revision === 1 && a.goals.length > 0 && a.goalWeightTotal === 100;
  const submit = useMutation({
    mutationFn: () => api<Appraisal>(`/v1/appraisals/${a.id}/goal-review`, { body: { expectedVersion: a.version } }),
    onSuccess: () => {
      onNotice({ text: 'Reviewed the goals: they have taken effect, and the employee can enter the self-entry.', ok: true });
      void qc.invalidateQueries({ queryKey: keys.appraisals });
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'STALE_VERSION' || e.code === 'GOALS_ALREADY_REVIEWED')) void qc.invalidateQueries({ queryKey: keys.appraisal(a.id) });
    },
  });
  return (
    <div role="group" aria-label="Goal review" style={GROUP}>
      <dl className="kv">
        <Item term="Goal review">
          {review.reviewed ? (
            <>
              Reviewed <When at={review.reviewedAt} />
            </>
          ) : (
            'Waiting: the goals take effect once someone other than their setter reviews them'
          )}
        </Item>
        {review.setBy !== undefined && <Item term="Goals set by">{review.setBy ? userLabel(review.setBy, myUserId) : 'Not recorded'}</Item>}
        {review.reviewedBy !== undefined && review.reviewedBy !== null && <Item term="Goals reviewed by">{userLabel(review.reviewedBy, myUserId)}</Item>}
      </dl>
      {canReview && reviewable && (
        mine ? (
          <p className="hint" style={FLUSH}>
            You set these goals, so someone else reviews them.
          </p>
        ) : (
          <div className="row">
            <button
              type="button"
              disabled={submit.isPending}
              onClick={() => {
                onNotice(null);
                submit.mutate();
              }}
            >
              {submit.isPending ? 'Reviewing…' : 'Review the goals'}
            </button>
          </div>
        )
      )}
      {canReview && !review.reviewed && a.goalWeightTotal !== 100 && <p className="hint" style={FLUSH}>Only a complete goal set (weights totalling 100) is reviewed.</p>}
      <Refusal error={submit.error} action="goal-review" />
    </div>
  );
}

function GoalsForm({ a, onNotice }: { a: Appraisal; onNotice: (n: { text: string; ok: boolean } | null) => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<GoalDraft[]>(() => draftsOf(a.goals));
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (goals: GoalInput[]) => api<Appraisal>(`/v1/appraisals/${a.id}/goals`, { method: 'PUT', body: { goals, expectedVersion: a.version } }),
    onSuccess: (view) => {
      onNotice({ text: `Saved ${view.goals.length} goal${view.goals.length === 1 ? '' : 's'}; the weights total ${view.goalWeightTotal}.`, ok: true });
      void qc.invalidateQueries({ queryKey: keys.appraisals });
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'STALE_VERSION' || e.code === 'GOALS_FIXED')) void qc.invalidateQueries({ queryKey: keys.appraisal(a.id) });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    const g = goalsBody(drafts);
    if ('problem' in g) return setProblem(g.problem);
    setProblem(null);
    onNotice(null);
    save.mutate(g.goals);
  };
  return (
    <form className="grid-form" aria-label="Set the goals" onSubmit={submit} noValidate style={SPACED}>
      <p className="hint wide" style={FLUSH}>
        The goals are replaced as a set, inside the goal-setting window or an exception. They are fixed from the first submission.
        {a.goalReview?.required ? ' Where the cycle reviews goals, a changed set is yours and starts unreviewed.' : ''}
      </p>
      <GoalsEditor drafts={drafts} onChange={setDrafts} />
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save the goals'}
        </button>
      </div>
      <Refusal error={save.error} action="goals" />
    </form>
  );
}

function ExceptionsTable({ a, myUserId }: { a: Appraisal; myUserId: string | null }) {
  if (a.exceptions.length === 0) return <Empty>No exceptions recorded.</Empty>;
  const showBy = a.exceptions.some((x) => x.recordedBy !== undefined);
  const showReason = a.exceptions.some((x) => 'reason' in x);
  return (
    <div style={SCROLL}>
      <table aria-label="Window exceptions">
        <thead>
          <tr>
            <th>Stage</th>
            <th>Valid through</th>
            {showBy && <th>Recorded by</th>}
            {showReason && <th>Reason</th>}
            <th>Recorded</th>
          </tr>
        </thead>
        <tbody>
          {a.exceptions.map((x, i) => (
            <tr key={`${x.stage}-${x.recordedAt}-${i}`}>
              <td>{STAGE_LABEL[x.stage] ?? readable(x.stage)}</td>
              <td>{formatDate(x.validUntil)}</td>
              {showBy && <td>{userLabel(x.recordedBy, myUserId)}</td>}
              {showReason && <td>{x.reason ?? '—'}</td>}
              <td>
                <When at={x.recordedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExceptionForm({ a, onNotice }: { a: Appraisal; onNotice: (n: { text: string; ok: boolean } | null) => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [stage, setStage] = useState<Stage | ''>('');
  const [validUntil, setValidUntil] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const record = useMutation({
    mutationFn: (body: { stage: Stage; validUntil: string; reason: string }) => api<Appraisal>(`/v1/appraisals/${a.id}/window-exceptions`, { body }),
    onSuccess: (_view, body) => {
      setStage('');
      setValidUntil('');
      setReason('');
      onNotice({ text: `Recorded an exception: ${STAGE_LABEL[body.stage]?.toLowerCase()} entries are accepted through ${formatDate(body.validUntil)}.`, ok: true });
      void qc.invalidateQueries({ queryKey: keys.appraisal(a.id) });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (record.isPending) return;
    if (!stage) return setProblem('Choose the stage the exception is for.');
    if (!validUntil) return setProblem('Enter the date the exception is valid through.');
    if (!reason.trim()) return setProblem('Enter the reason for the exception.');
    setProblem(null);
    onNotice(null);
    record.mutate({ stage, validUntil, reason: reason.trim() });
  };
  return (
    <form className="grid-form" aria-label="Record a window exception" onSubmit={submit} noValidate style={SPACED}>
      <p className="hint wide" style={FLUSH}>
        Admits entries at one stage of this appraisal outside its window, through the date given (inclusive). The reason is confidential. Exceptions are kept; they are never changed or removed.
      </p>
      <label>
        Stage
        <select value={stage} onChange={(e) => setStage(e.target.value as Stage | '')}>
          <option value="">Choose…</option>
          {WINDOWS.map((w) => (
            <option key={w.stage} value={w.stage}>
              {w.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Valid through
        <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
      </label>
      <label className="wide">
        Reason (confidential)
        <textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
      </label>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={record.isPending}>
          {record.isPending ? 'Recording…' : 'Record the exception'}
        </button>
      </div>
      <Refusal error={record.error} action="exception" />
    </form>
  );
}

function CancelForm({ a, onNotice }: { a: Appraisal; onNotice: (n: { text: string; ok: boolean } | null) => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: (text: string) => api<Appraisal>(`/v1/appraisals/${a.id}/cancel`, { body: { reason: text, expectedVersion: a.version } }),
    onSuccess: () => {
      setReason('');
      onNotice({ text: 'Cancelled the appraisal. It and its history are kept.', ok: true });
      void qc.invalidateQueries({ queryKey: keys.appraisals });
      void qc.invalidateQueries({ queryKey: keys.tasks });
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'STALE_VERSION' || e.code === 'INVALID_STATE')) void qc.invalidateQueries({ queryKey: keys.appraisal(a.id) });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (cancel.isPending) return;
    if (!reason.trim()) return setProblem('Enter the reason for cancelling.');
    setProblem(null);
    onNotice(null);
    cancel.mutate(reason.trim());
  };
  return (
    <form className="grid-form" aria-label="Cancel the appraisal" onSubmit={submit} noValidate>
      <p className="hint wide" style={FLUSH}>
        An unfinished appraisal can be cancelled with a confidential reason; any open rating or review task closes. A cancelled appraisal no longer blocks a new one.
      </p>
      <label className="wide">
        Reason for cancelling (confidential)
        <textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
      </label>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="row">
        <button type="submit" className="danger" disabled={cancel.isPending}>
          {cancel.isPending ? 'Cancelling…' : 'Cancel the appraisal'}
        </button>
      </div>
      <Refusal error={cancel.error} action="cancel" />
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Decision queues (FR-043): the manager's rating, then the independent reviewer confirmation
// ---------------------------------------------------------------------------------------------------------
type QueueKind = 'MANAGER_RATING' | 'REVIEW';
const QUEUES: Record<QueueKind, { title: string; hint: string; list: string; empty: string; forbidden: string }> = {
  MANAGER_RATING: {
    title: 'Appraisal ratings',
    hint: 'Submitted appraisals waiting for your rating: score every goal from 1 to 5 and save, then submit the rating or return the appraisal to the employee.',
    list: 'Appraisals waiting for your rating',
    empty: 'No appraisals are waiting for your rating.',
    forbidden: 'The selected role cannot rate appraisals.',
  },
  REVIEW: {
    title: 'Appraisal reviews',
    hint: 'Rated appraisals waiting for your independent confirmation: confirm the rating or return the appraisal to the employee.',
    list: 'Appraisals waiting for your review',
    empty: 'No appraisals are waiting for your review.',
    forbidden: 'The selected role cannot review appraisals.',
  },
};

function RatingQueue() {
  return <AppraisalQueue kind="MANAGER_RATING" />;
}
function ReviewQueue() {
  return <AppraisalQueue kind="REVIEW" />;
}

function AppraisalQueue({ kind }: { kind: QueueKind }) {
  const queue = QUEUES[kind];
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const region = useRef<HTMLDivElement>(null);
  // GET /v1/appraisal-tasks/mine checks appraisal.read (operational or rating); the decision duty alone lists nothing.
  const canList = can(READ) || can(READ_RATING);
  // Both queues read the same route under the same key: one request, each listing its own stage's tasks.
  const tasks = useQuery({ queryKey: keys.tasks, queryFn: () => api<{ items: AppraisalTask[] }>('/v1/appraisal-tasks/mine'), retry: retryTransient, enabled: canList });
  /** Tasks seen decided here, or found closed: they leave the queue at once, before it has reloaded. */
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const data = shown(tasks);
  const items = (data?.items ?? []).filter((t) => (kind === 'REVIEW' ? t.stage === 'REVIEW' : t.stage === 'MANAGER_RATING') && !gone.has(t.taskId));
  const done = (t: AppraisalTask, text: string, ok: boolean) => {
    setGone((prev) => new Set(prev).add(t.taskId));
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: keys.tasks });
    void qc.invalidateQueries({ queryKey: keys.appraisals });
    const active = document.activeElement;
    if (!active || active === document.body || region.current?.contains(active)) region.current?.focus();
  };
  if (!canList) {
    return (
      <Section title={queue.title}>
        <NotPermitted>The selected role cannot read appraisals, so it cannot list the appraisals waiting for it.</NotPermitted>
      </Section>
    );
  }
  return (
    <div ref={region} role="region" aria-label={queue.title} tabIndex={-1}>
      <Section title={`${queue.title}${data ? ` (${items.length})` : ''}`}>
        <p className="hint">{queue.hint}</p>
        {tasks.isPending && <p className="hint">Loading the appraisals waiting for you…</p>}
        <QueryProblem error={tasks.error} forbidden={queue.forbidden} />
        <Notice notice={notice} />
        {data && items.length === 0 && <Empty>{queue.empty}</Empty>}
        {items.length > 0 && (
          <ul className="tasks" aria-label={queue.list}>
            {items.map((t) => (
              <TaskItem key={t.taskId} task={t} onFinished={done} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function decidedText(name: string, decision: 'APPROVE' | 'RETURN', stage: string, r: DecisionResult): string {
  if (r.replayed) return `Your earlier decision on the appraisal of ${name} had already been recorded, so nothing was applied twice. Its state is now: ${readable(r.state).toLowerCase()}.`;
  if (decision === 'RETURN') return `Returned the appraisal of ${name} to the employee; revision ${r.revision} is open for the self-entry.`;
  // BR-013 one-level manager review (I-77 item 2): the manager's approval completes the appraisal.
  if (stage === 'MANAGER_RATING' && r.state === 'APPROVED') return `Submitted the rating of ${name}: this cycle has no reviewer level, so the appraisal is complete.`;
  if (stage === 'MANAGER_RATING') return `Submitted the rating of ${name}. It now waits for the independent reviewer confirmation.`;
  if (r.state === 'APPROVED') return `Confirmed the rating of ${name}: the appraisal is complete.`;
  if (r.pendingStep === 3) return `Confirmed the rating of ${name} at level 1. It now waits for the level-2 reviewer.`;
  return `The appraisal of ${name} is now ${readable(r.state).toLowerCase()}.`;
}

function TaskItem({ task: t, onFinished }: { task: AppraisalTask; onFinished: (t: AppraisalTask, text: string, ok: boolean) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const id = useId();
  const rating = t.stage === 'MANAGER_RATING';
  const permitted = can(rating ? RATE : CONFIRM);
  /** The answer to the last save (the server's view of the appraisal), until the queue has reloaded past it. */
  const [saved, setSaved] = useState<Appraisal | null>(null);
  const a = saved && (!t.appraisal || saved.version > t.appraisal.version) ? saved : t.appraisal;
  const [dirty, setDirty] = useState(false);
  const [remark, setRemark] = useState('');
  const [message, setMessage] = useState('');
  /** FR-043 / DF04 (I-77 item 1): the reviewer's overall score, given with a confirmation. */
  const [reviewerScore, setReviewerScore] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  /**
   * The decision last sent and its idempotency key (ZT07). Sending that same decision again after a failure, whose
   * answer may have been lost, carries the same key: the server answers from what it recorded and never applies it
   * twice. Any other decision, remark, message or score is a new action with a new key.
   */
  const attempt = useRef<{ decision: string; remark: string; message: string; score: string; key: string } | null>(null);
  const name = a ? personLabel(a.employee) : 'this employee';
  const working = a?.revisions.find((r) => r.revision === a.revision);
  const save = useMutation({
    mutationFn: (body: EntryChanges & { expectedVersion: number }) => api<Appraisal>(`/v1/appraisal-tasks/${encodeURIComponent(t.taskId)}/rating`, { method: 'PUT', body }),
    onSuccess: (view) => {
      setSaved(view);
      setSavedNote('Scores saved.');
      void qc.invalidateQueries({ queryKey: keys.tasks });
    },
    onError: (e) => {
      if (!(e instanceof ApiError)) return;
      if (e.code === 'TASK_CLOSED' || e.code === 'INVALID_STATE' || e.status === 404) onFinished(t, refusalText(e, 'rating') ?? e.message, false);
      else if (e.code === 'STALE_VERSION' || e.code === 'UNKNOWN_GOAL') void qc.invalidateQueries({ queryKey: keys.tasks });
    },
  });
  const decide = useMutation({
    mutationFn: (body: { decision: 'APPROVE' | 'RETURN'; reason?: string; employeeMessage?: string; reviewerScore?: number; idempotencyKey: string }) =>
      api<DecisionResult>(`/v1/appraisal-tasks/${encodeURIComponent(t.taskId)}/decision`, { body }),
    onSuccess: (result, body) => {
      attempt.current = null;
      onFinished(t, decidedText(name, body.decision, t.stage, result), true);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.current = null;
      else if (error.code === 'TASK_CLOSED' || error.code === 'INVALID_STATE' || error.status === 404) onFinished(t, refusalText(error, 'decide') ?? error.message, false);
    },
  });
  const busy = save.isPending || decide.isPending;
  const send = (decision: 'APPROVE' | 'RETURN') => {
    if (!permitted || busy || !a) return;
    const msg = message.trim();
    const rem = remark.trim();
    if (decision === 'RETURN' && !msg) {
      setProblem('Tell the employee what to revise before returning the appraisal.');
      decide.reset();
      return;
    }
    if (decision === 'APPROVE' && rating && dirty) {
      setProblem('Save the scores first: the rating is submitted as saved.');
      decide.reset();
      return;
    }
    const confirming = decision === 'APPROVE' && !rating;
    if (confirming && !reviewerScore) {
      setProblem('Choose your overall score (1 to 5) to confirm the rating.');
      decide.reset();
      return;
    }
    setProblem(null);
    const sentMessage = decision === 'RETURN' ? msg : '';
    const sentScore = confirming ? reviewerScore : '';
    const last = attempt.current;
    const key =
      last !== null && last.decision === decision && last.remark === rem && last.message === sentMessage && last.score === sentScore ? last.key : idempotencyKey('appraisal-decision');
    attempt.current = { decision, remark: rem, message: sentMessage, score: sentScore, key };
    decide.mutate({
      decision,
      idempotencyKey: key,
      ...(rem ? { reason: rem } : {}),
      ...(decision === 'RETURN' ? { employeeMessage: msg } : {}),
      ...(confirming ? { reviewerScore: Number(sentScore) } : {}),
    });
  };
  const titleId = `${id}-title`;
  return (
    <li aria-labelledby={titleId}>
      <h3 id={titleId} style={H3}>
        {a ? `${personLabel(a.employee)} · ${a.cycle.code}` : 'Appraisal'}
      </h3>
      <DelegatedBadge taskId={t.taskId} />
      <p className="hint" style={FLUSH}>
        {stepText(t.stage, t.level)} · assigned <When at={t.assignedAt} />
        {t.dueOn ? ` · due ${formatDate(t.dueOn)}` : ' · no due date'}
        {a ? ` · revision ${a.revision}` : ''}
      </p>
      {t.overdue && <Badge tone="warn">overdue</Badge>}
      {!a ? (
        <Empty>This appraisal is not available in the selected role’s scope.</Empty>
      ) : (
        <>
          <GoalsTable a={a} label={`Goals of ${name}`} />
          {a.competencies !== undefined && a.competencies.length > 0 && <CompetenciesTable a={a} label={`Competencies of ${name}`} />}
          {working?.selfEntry ? (
            <>
              <h4 style={H3}>The employee’s self-entry</h4>
              <EntriesTable goals={a.goals} set={working.selfEntry} label={`Self-entry of ${name}`} />
              <CompetencyEntriesTable items={a.competencies ?? []} entries={working.selfEntry.competencies ?? []} label={`Competency self-entry of ${name}`} />
              <SectionTexts sections={a.sections ?? []} texts={working.selfEntry.sections} label={`Sections filled by ${name}`} />
            </>
          ) : (
            <p className="hint">The self-entry is confidential and not shown to the selected role.</p>
          )}
          {!rating && working?.managerRating && (
            <>
              <h4 style={H3}>The manager’s rating</h4>
              <EntriesTable goals={a.goals} set={working.managerRating} label={`Manager rating of ${name}`} />
              <CompetencyEntriesTable items={a.competencies ?? []} entries={working.managerRating.competencies ?? []} label={`Competency rating of ${name}`} />
              <SectionTexts sections={a.sections ?? []} texts={working.managerRating.sections} label={`Manager sections of ${name}`} />
              <RatingResults rating={working.managerRating} />
              {a.cycle.ratingMode === 'MANUAL' && (
                <p style={FLUSH}>
                  Overall rating of the manager (the final rating in this cycle): <strong>{working.managerRating.overallRating ?? '—'}</strong>
                </p>
              )}
            </>
          )}
          {!rating && !working?.managerRating && <p className="hint">The manager’s rating is confidential and not shown to the selected role.</p>}
          <p style={FLUSH}>
            <Link to={PATHS.appraisal(a.id)}>Open the appraisal</Link>
          </p>
        </>
      )}
      {a &&
        (permitted ? (
          <>
            {rating && (
              <ScoreForm
                key={`${a.id}:${a.version}`}
                goals={a.goals}
                saved={working?.managerRating}
                label={`Rating of ${name}`}
                saveLabel="Save the scores"
                busy={busy}
                hiddenSaved={(g) => !working?.managerRating && g.managerRatingComplete === true}
                overall={a.cycle.ratingMode === 'MANUAL' ? { saved: working?.managerRating?.overallRating ?? null } : undefined}
                competencies={a.competencies}
                sections={{ party: 'MANAGER', items: a.sections ?? [] }}
                onDirty={setDirty}
                onSave={(changes) => {
                  setSavedNote(null);
                  save.mutate({ ...changes, expectedVersion: a.version });
                }}
              >
                {savedNote && !dirty && (
                  <p className="ok" role="status">
                    {savedNote}
                  </p>
                )}
                <Refusal error={save.error} action="rating" />
              </ScoreForm>
            )}
            <div style={SPACED}>
              {!rating && (
                <label>
                  Your overall score (1 to 5; required to confirm, kept apart from the manager’s rating)
                  <select value={reviewerScore} onChange={(e) => setReviewerScore(e.target.value)}>
                    <option value="">Not scored</option>
                    {SCORES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Private remark (optional; never shown to the employee)
                <textarea rows={2} maxLength={1000} value={remark} onChange={(e) => setRemark(e.target.value)} style={TEXTAREA} />
              </label>
              <label>
                Message to the employee (required to return)
                <textarea rows={2} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} style={TEXTAREA} />
              </label>
              {problem && (
                <p role="alert" className="error">
                  {problem}
                </p>
              )}
              <div className="row">
                <button type="button" disabled={busy} onClick={() => send('APPROVE')}>
                  {rating ? 'Submit the rating' : 'Confirm the rating'}
                </button>
                <button type="button" className="secondary" disabled={busy} onClick={() => send('RETURN')}>
                  Return to the employee
                </button>
              </div>
              <Refusal error={decide.error} action="decide" />
            </div>
          </>
        ) : (
          <p className="hint">{QUEUES[rating ? 'MANAGER_RATING' : 'REVIEW'].forbidden}</p>
        ))}
    </li>
  );
}

function RatingsScreen() {
  const { can } = useSession();
  if (!can(RATE)) {
    return (
      <Section title="Appraisal ratings">
        <NotPermitted>The selected role cannot rate appraisals.</NotPermitted>
      </Section>
    );
  }
  return <RatingQueue />;
}

function ReviewsScreen() {
  const { can } = useSession();
  if (!can(CONFIRM)) {
    return (
      <Section title="Appraisal reviews">
        <NotPermitted>The selected role cannot review appraisals.</NotPermitted>
      </Section>
    );
  }
  return <ReviewQueue />;
}

// ---------------------------------------------------------------------------------------------------------
// Screen: reports (FR-044) within row scope, and the export
// ---------------------------------------------------------------------------------------------------------

function ReportsScreen() {
  const { can } = useSession();
  const [cycleId, setCycleId] = useState('');
  if (!can(REPORT)) {
    return (
      <Section title="Appraisal reports">
        <NotPermitted>The selected role cannot view appraisal reports.</NotPermitted>
      </Section>
    );
  }
  return (
    <div className="stack">
      <Section title="Appraisal reports">
        {can(CYCLE_READ) ? (
          <div className="row">
            <CycleSelect label="Cycle" value={cycleId} onChange={setCycleId} />
          </div>
        ) : (
          <NotPermitted>The selected role cannot list appraisal cycles, so it cannot choose one to report on.</NotPermitted>
        )}
        {!cycleId && can(CYCLE_READ) && <p className="hint">Choose a cycle to see its report.</p>}
      </Section>
      {cycleId && <CycleReport key={cycleId} cycleId={cycleId} />}
    </div>
  );
}

function CycleReport({ cycleId }: { cycleId: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const [departmentId, setDepartmentId] = useState('');
  const query = departmentId ? `?departmentId=${departmentId}` : '';
  const report = useQuery({ queryKey: keys.report(cycleId, departmentId), queryFn: () => api<Report>(`/v1/appraisal-cycles/${cycleId}/report${query}`), retry: retryTransient });
  const exportCsv = useMutation({ mutationFn: () => download(`/v1/appraisal-cycles/${cycleId}/export${query}`) });
  const data = shown(report);
  return (
    <Section title="Cycle report">
      <div className="row">
        <DepartmentSelect value={departmentId} onChange={setDepartmentId} />
      </div>
      {report.isPending && <p className="hint">Loading the report…</p>}
      <QueryProblem error={report.error} forbidden="The selected role cannot view appraisal reports." />
      {data && (
        <>
          <p>
            {data.cycle.code}: {data.cycle.name} ({periodText(data.cycle)}). Scope: {readable(data.scope).toLowerCase()}
            {data.filters.departmentId ? ', one department' : ', all departments in scope'}. Generated <When at={data.generatedAt} />.
          </p>
          {data.ownAppraisalExcluded && <p className="hint">Your own appraisal is never included in reports or exports.</p>}
          <p>
            Appraisals in the population: <strong>{data.population}</strong> (cancelled ones are counted apart).
          </p>
          <div style={SCROLL}>
            <table aria-label="Appraisals by state">
              <thead>
                <tr>
                  <th>State</th>
                  <th>Appraisals</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.byState).map(([state, n]) => (
                  <tr key={state}>
                    <td>{readable(state)}</td>
                    <td>{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.ratings && (
            <>
              <h3 style={H3}>Final ratings of completed appraisals</h3>
              <p className="hint" style={FLUSH}>
                Exact final ratings, counted as they are: no bins, targets or expected shares. The counts add up to the {data.ratings.completed} completed appraisal
                {data.ratings.completed === 1 ? '' : 's'}.
              </p>
              {data.ratings.distribution.length === 0 ? (
                <Empty>No completed appraisals yet.</Empty>
              ) : (
                <div style={SCROLL}>
                  <table aria-label="Final rating distribution">
                    <thead>
                      <tr>
                        <th>Final rating</th>
                        <th>Appraisals</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.ratings.distribution.map((r) => (
                        <tr key={r.finalRating}>
                          <td>{r.finalRating}</td>
                          <td>{r.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
      {can(EXPORT) && (
        <div style={SPACED}>
          <div className="row">
            <button type="button" className="secondary" disabled={exportCsv.isPending} onClick={() => exportCsv.mutate()}>
              {exportCsv.isPending ? 'Preparing the export…' : 'Export as CSV'}
            </button>
          </div>
          <p className="hint">The export covers the same population; rating columns are included only when the selected role may see them.</p>
          <Refusal error={exportCsv.error} action="export" />
        </div>
      )}
      {can(REPORT_RATING) && <TrainingNeeds cycleId={cycleId} departmentId={departmentId} />}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screen: the KRA upload (FR-041, template APPRAISAL_GOALS_V1): new DRAFT appraisals only, after a preview
// ---------------------------------------------------------------------------------------------------------
const ROW_PROBLEMS: Record<string, string> = {
  WEIGHT_TOTAL_NOT_100: 'This employee’s goal weights in the file do not total exactly 100.',
  DUPLICATE_SEQUENCE: 'This goal sequence is already on an earlier row for the same employee and cycle.',
  INVALID_SEQUENCE: 'The sequence is not a whole number from 1 to 100.',
  INVALID_WEIGHT: 'The weight is not a whole number from 1 to 100.',
  INVALID_DESCRIPTION: 'The description is empty or longer than 500 characters.',
  INVALID_TARGET: 'The target is longer than 1,000 characters.',
  UNKNOWN_CYCLE: 'No cycle has this code.',
  UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code.',
  APPRAISAL_EXISTS: 'The employee already has an appraisal in this cycle; an upload only creates new ones.',
  CYCLE_OVERLAP: 'The employee already has an appraisal in an overlapping cycle.',
  CYCLE_CLOSED: 'The cycle is closed.',
  WINDOW_CLOSED: 'The cycle’s goal-setting window is not open today.',
  EMPLOYEE_NOT_ACTIVE: 'The employee is not active.',
  JOINED_AFTER_CYCLE: 'The employee joined after the cycle ends.',
  SELF_ACTION_NOT_ALLOWED: 'This is your own appraisal; you cannot set your own goals.',
  OUT_OF_SCOPE: 'The employee is outside the scope of your role.',
  APPRAISAL_NOT_ENROLLED: 'The first row of this employee and cycle did not enrol an appraisal.',
  COLUMN_COUNT: 'The row does not have exactly one cell for each column of the header.',
  BATCH_REJECTED: 'Not applied, because another row of the file has a problem (all or nothing).',
};

function GoalUploadScreen() {
  const { can } = useSession();
  if (!can(IMPORT) || !can(MANAGE)) {
    return (
      <Section title="KRA upload">
        <NotPermitted>The selected role cannot upload goals: it needs both the appraisal import duty and the goal-setting duty.</NotPermitted>
      </Section>
    );
  }
  return <GoalUpload />;
}

/** The goal upload's batch routes (goal-import.ts; the list and resume routes come from imports/routes.ts). */
const GOAL_IMPORTS = '/v1/appraisal-goal-imports';

function GoalUpload() {
  const keys = useKeys();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  /** One idempotency key per chosen file: uploading the same file again returns the same job. */
  const uploadKey = useRef<string | null>(null);
  // A held upload checked again from the file the server stored (POST /:id/resume), or one of the user's uploads
  // opened from the list.
  const { resume, open, refresh, watch } = useBatchFollowUp(
    GOAL_IMPORTS,
    {
      show: setJob,
      closed: (id) => setJob((shown) => (shown?.id === id ? null : shown)),
      onStart: () => {
        upload.reset();
        act.reset();
        setNotice(null);
      },
    },
    job,
  );
  const upload = useMutation({
    mutationFn: async (f: File) => api<ImportJob>(GOAL_IMPORTS, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: uploadKey.current! } }),
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: (j) => {
      setJob(j);
      setFile(null);
      setInputKey((k) => k + 1);
      uploadKey.current = null;
    },
    onSettled: refresh,
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'commit' | 'cancel' }) => api<ImportJob>(`${GOAL_IMPORTS}/${id}/${action}`, { method: 'POST' }),
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSettled: refresh,
    onSuccess: (j, v) => {
      setJob(j);
      // A row that fails when applied rejects the whole batch: the answer is then the REJECTED job (200), not an error.
      if (v.action === 'commit' && j.state !== 'COMMITTED') {
        setNotice({ text: 'Nothing was applied: a row failed when the upload was committed, so the whole file was rejected. See the row problems below.', ok: false });
        void qc.invalidateQueries({ queryKey: keys.appraisals });
      } else if (v.action === 'commit') {
        setNotice({
          text: `Applied ${j.acceptedCount ?? 0} row${j.acceptedCount === 1 ? '' : 's'}: the draft appraisals were created with their goals. Nothing was submitted, rated or approved.`,
          ok: true,
        });
        void qc.invalidateQueries({ queryKey: keys.appraisals });
      } else setNotice({ text: 'Discarded the upload; nothing was applied.', ok: true });
    },
  });
  const busy = upload.isPending || act.isPending || resume.isPending || open.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file || busy) return;
    setNotice(null);
    if (!uploadKey.current) uploadKey.current = idempotencyKey('appraisal-goals');
    upload.mutate(file);
  };
  const problems = job ? job.rows.filter((r) => r.errorCode) : [];
  const held = job?.state === 'UPLOADED';
  const rowCount = job ? (job.rowCount ?? job.rows.length) : 0;
  return (
    <div className="stack">
      <Section title="KRA upload">
        <p className="hint">
          One row per goal: <code>cycleCode,employeeCode,sequence,description,target,weight</code> (template APPRAISAL_GOALS_V1). The rows of one employee and cycle become one new draft appraisal with
          those goals; each employee’s weights must total exactly 100. An upload never submits, rates or approves anything: each employee still enters a self-assessment and the review route decides.
        </p>
        <TemplateDownload base={GOAL_IMPORTS} code="APPRAISAL_GOALS_V1" />
        <form className="grid-form" aria-label="Upload goals" onSubmit={submit} noValidate>
          <label>
            Goal file (CSV)
            <input
              key={inputKey}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                uploadKey.current = null;
              }}
            />
          </label>
          <div className="row">
            <button type="submit" disabled={busy || !file}>
              {upload.isPending ? 'Checking…' : 'Upload and preview'}
            </button>
          </div>
          <Refusal error={upload.error ?? resume.error} action="upload" />
        </form>
        <Notice notice={notice} />
      </Section>
      {job && (
        <Section title={`Upload ${job.fileName ?? ''}`.trim()}>
          <p>
            State: <StateBadge state={job.state} />
            {held ? null : ` · ${rowCount} row${rowCount === 1 ? '' : 's'}`}
          </p>
          {held && (
            <>
              <p role="status">
                The file is waiting for the malware scan, so nothing in it has been read yet. This is usually a short wait. You can discard the upload meanwhile; it stays in your uploads below, so it
                can be opened again after you leave this page.
              </p>
              <div className="row">
                <HeldBatchWatchNote watch={watch} />
                <button type="button" className="secondary" disabled={busy} onClick={() => resume.mutate(job.id)}>
                  Check the scan again
                </button>
                <button type="button" className="secondary" disabled={busy} onClick={() => act.mutate({ id: job.id, action: 'cancel' })}>
                  Discard the upload
                </button>
                {resume.data?.id === job.id && resume.data.state === 'UPLOADED' && !resume.isPending && <span role="status">Still waiting for the malware scan.</span>}
              </div>
            </>
          )}
          {job.state === 'PREVIEWED' && <p>Every row is valid. Committing creates the draft appraisals in one go; nothing is applied before that.</p>}
          {job.state === 'REJECTED' && <p className="error">The file was rejected as a whole: correct the rows below and upload it again. Nothing was applied.</p>}          {job.rows.length > 0 && (
            <div style={SCROLL}>
              <table aria-label="Upload rows">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Cycle / employee # sequence</th>
                    <th>State</th>
                    <th>Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {job.rows.map((r) => (
                    <tr key={r.rowNumber}>
                      <td>{r.rowNumber}</td>
                      <td>{r.businessKey ?? '—'}</td>
                      <td>{readable(r.state)}</td>
                      <td>{r.errorCode ? (ROW_PROBLEMS[r.errorCode] ?? r.errorCode) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {problems.length === 0 && job.state === 'REJECTED' && <Empty>No row-level problem was reported.</Empty>}
          {job.state === 'PREVIEWED' && (
            <div className="row">
              <button type="button" disabled={busy} onClick={() => act.mutate({ id: job.id, action: 'commit' })}>
                {act.isPending ? 'Working…' : 'Commit: create the draft appraisals'}
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => act.mutate({ id: job.id, action: 'cancel' })}>
                Discard the upload
              </button>
            </div>
          )}
          <Refusal error={act.error} action={act.variables?.action === 'cancel' ? 'discard' : 'commit'} />
        </Section>
      )}
      <ImportBatches base={GOAL_IMPORTS} title="Your KRA uploads" openedId={job?.id ?? null} busy={busy} onOpen={(id) => open.mutate(id)} error={open.error} />
    </div>
  );
}

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

function MyAppraisalsPanel() {
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
        {list.isPending && <p className="hint">Loading your appraisals…</p>}
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
  if (query.isPending) return <Section title="Appraisal">{<p className="hint">Loading your appraisal…</p>}</Section>;
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
              The self-entry window is not open today ({windowText(selfWindow).toLowerCase()}) and no exception is recorded, so entries are not accepted. Ask HR if you need an exception.
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

// ---------------------------------------------------------------------------------------------------------
// Screen: competencies and the result split (Appraisal Config: FR-041 "grade-mapped competencies"; I-86). The dated
// goals / competencies split, the competency master with its five behavioural indicators, and the dated competency sets
// mapped to a grade (optionally one designation). Operational configuration in the cycle duty; the server checks every rule.
// ---------------------------------------------------------------------------------------------------------
interface ScoringRevision {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  goalWeightPercent: number;
  competencyWeightPercent: number;
  reason: string;
  version: number;
}
interface CompetencyMaster {
  id: string;
  code: string;
  name: string;
  description: string | null;
  indicators: { level: number; text: string }[];
  activeFrom: string;
  activeTo: string | null;
  activeToday: boolean;
  usedInSets: number;
  version: number;
}
interface CompetencySet {
  id: string;
  grade: { id: string; code: string; name: string };
  designation: { id: string; code: string; name: string } | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  inForceToday: boolean;
  reason: string;
  items: { competencyId: string; code: string; name: string; sequence: number; weight: number }[];
  weightTotal: number;
  version: number;
}
const LEVELS = [1, 2, 3, 4, 5] as const;

function CompetencyConfigScreen() {
  const { can } = useSession();
  if (!can(CYCLE_READ)) {
    return (
      <Section title="Appraisal competencies">
        <NotPermitted>The selected role cannot view the appraisal configuration.</NotPermitted>
      </Section>
    );
  }
  return (
    <div className="stack">
      <ScoringSection />
      <CompetencyMasterSection />
      <CompetencySetsSection />
    </div>
  );
}

function ScoringSection() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: keys.scoring,
    queryFn: () => api<{ businessDate: string; inForce: Scoring | null; items: ScoringRevision[] }>('/v1/appraisal-scoring-settings'),
    retry: retryTransient,
  });
  const [from, setFrom] = useState('');
  const [goal, setGoal] = useState('');
  const [competency, setCompetency] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: { effectiveFrom: string; goalWeightPercent: number; competencyWeightPercent: number; reason: string }) => api<ScoringRevision>('/v1/appraisal-scoring-settings', { body }),
    onSuccess: (r) => {
      setNotice(`Saved: from ${formatDate(r.effectiveFrom)}, goals ${r.goalWeightPercent}% and competencies ${r.competencyWeightPercent}%.`);
      setFrom('');
      setGoal('');
      setCompetency('');
      setReason('');
      void qc.invalidateQueries({ queryKey: keys.scoring });
    },
  });
  const data = shown(query);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    if (!from) return setProblem('Enter the date the new split starts.');
    if (!wholeIn(goal, 1, 100) || !wholeIn(competency, 0, 99) || Number(goal) + Number(competency) !== 100) return setProblem('The percentages are whole numbers that add up to exactly 100.');
    if (!reason.trim()) return setProblem('Enter a reason.');
    setProblem(null);
    setNotice(null);
    create.mutate({ effectiveFrom: from, goalWeightPercent: Number(goal), competencyWeightPercent: Number(competency), reason: reason.trim() });
  };
  return (
    <Section title="Result split">
      <p className="hint">
        How the weighted result combines goals and competencies: (goals % × goal result + competencies % × competency result) / 100, rounded once, half up, to two decimals. Without competencies the result is the goal result
        alone. A new cycle takes the split in force on its start date and keeps its own copy.
      </p>
      {query.isPending && <p className="hint">Loading the split…</p>}
      <QueryProblem error={query.error} forbidden="The selected role cannot view the result split." />
      {data && (
        <>
          <p>
            In force today:{' '}
            <strong>{data.inForce ? `goals ${data.inForce.goalWeightPercent}%, competencies ${data.inForce.competencyWeightPercent}%` : 'none (cycles cannot take a split until one is set)'}</strong>
          </p>
          <div style={SCROLL}>
            <table aria-label="Result split revisions">
              <thead>
                <tr>
                  <th>From</th>
                  <th>Until</th>
                  <th>Goals %</th>
                  <th>Competencies %</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td>{formatDate(r.effectiveFrom)}</td>
                    <td>{r.effectiveTo ? formatDate(r.effectiveTo) : 'Open'}</td>
                    <td>{r.goalWeightPercent}</td>
                    <td>{r.competencyWeightPercent}</td>
                    <td>{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
      {can(CYCLE_MANAGE) && (
        <form className="grid-form" aria-label="New result split" onSubmit={submit} noValidate>
          <label>
            Starts on
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            Goals %
            <input inputMode="numeric" value={goal} maxLength={3} onChange={(e) => setGoal(e.target.value)} />
          </label>
          <label>
            Competencies %
            <input inputMode="numeric" value={competency} maxLength={2} onChange={(e) => setCompetency(e.target.value)} />
          </label>
          <label className="wide">
            Reason
            <textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
          </label>
          {problem && (
            <p role="alert" className="error">
              {problem}
            </p>
          )}
          <div className="row">
            <button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Saving…' : 'Save the new split'}
            </button>
          </div>
          <p className="hint" style={FLUSH}>
            It starts today or later and ends the split in force that day; earlier periods and cycles already created keep theirs.
          </p>
          <Refusal error={create.error} action="scoring" />
        </form>
      )}
    </Section>
  );
}

function CompetencyMasterSection() {
  const { can } = useSession();
  const keys = useKeys();
  const query = useQuery({ queryKey: keys.competencies, queryFn: () => api<{ items: CompetencyMaster[] }>('/v1/appraisal-competencies'), retry: retryTransient });
  const [editing, setEditing] = useState<string | null>(null);
  const data = shown(query);
  const current = data?.items.find((k) => k.id === editing) ?? null;
  return (
    <Section title="Competencies">
      {query.isPending && <p className="hint">Loading competencies…</p>}
      <QueryProblem error={query.error} forbidden="The selected role cannot view competencies." />
      {data && data.items.length === 0 && <Empty>No competencies yet.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Competency master">
            <thead>
              <tr>
                <th>Code</th>
                <th>Competency</th>
                <th>Active</th>
                <th>Used in sets</th>
                {can(CYCLE_MANAGE) && <th>Change</th>}
              </tr>
            </thead>
            <tbody>
              {data.items.map((k) => (
                <tr key={k.id}>
                  <td>{k.code}</td>
                  <td>
                    {k.name}
                    <IndicatorList item={k} />
                  </td>
                  <td>
                    {formatDate(k.activeFrom)} to {k.activeTo ? formatDate(k.activeTo) : 'open'}
                    {k.activeToday ? '' : ' (not active today)'}
                  </td>
                  <td>{k.usedInSets}</td>
                  {can(CYCLE_MANAGE) && (
                    <td>
                      <button type="button" className="secondary" aria-pressed={editing === k.id} onClick={() => setEditing(editing === k.id ? null : k.id)}>
                        Change {k.code}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can(CYCLE_MANAGE) && current && <CompetencyForm key={`${current.id}:${current.version}`} initial={current} onDone={() => setEditing(null)} />}
      {can(CYCLE_MANAGE) && !current && <CompetencyForm key="new" initial={null} onDone={() => undefined} />}
    </Section>
  );
}

function CompetencyForm({ initial, onDone }: { initial: CompetencyMaster | null; onDone: () => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [indicators, setIndicators] = useState<string[]>(initial ? initial.indicators.map((i) => i.text) : ['', '', '', '', '']);
  const [activeFrom, setActiveFrom] = useState(initial?.activeFrom ?? '');
  const [activeTo, setActiveTo] = useState(initial?.activeTo ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      initial ? api<CompetencyMaster>(`/v1/appraisal-competencies/${initial.id}`, { method: 'PUT', body }) : api<CompetencyMaster>('/v1/appraisal-competencies', { body }),
    onSuccess: (k) => {
      setNotice(initial ? `Saved ${k.code}.` : `Added ${k.code}.`);
      if (!initial) {
        setCode('');
        setName('');
        setDescription('');
        setIndicators(['', '', '', '', '']);
        setActiveFrom('');
      }
      void qc.invalidateQueries({ queryKey: keys.competencies });
      if (initial) onDone();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'STALE_VERSION') void qc.invalidateQueries({ queryKey: keys.competencies });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    if (!initial && !code.trim()) return setProblem('Enter a code.');
    if (!name.trim()) return setProblem('Enter a name.');
    if (indicators.some((t) => !t.trim())) return setProblem('Describe each proficiency level 1 to 5.');
    if (!activeFrom) return setProblem('Enter the date the competency is active from.');
    setProblem(null);
    setNotice(null);
    const common = { name: name.trim(), description: description.trim() === '' ? null : description.trim(), indicators: indicators.map((t) => t.trim()), activeFrom };
    save.mutate(initial ? { ...common, activeTo: activeTo === '' ? null : activeTo, expectedVersion: initial.version } : { ...common, code: code.trim() });
  };
  return (
    <form className="grid-form" aria-label={initial ? `Change ${initial.code}` : 'New competency'} onSubmit={submit} noValidate style={SPACED}>
      <h3 style={H3}>{initial ? `Change ${initial.code}` : 'New competency'}</h3>
      {!initial && (
        <label>
          Code
          <input value={code} maxLength={40} onChange={(e) => setCode(e.target.value)} />
        </label>
      )}
      <label>
        Name
        <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="wide">
        Description (optional)
        <textarea rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} style={TEXTAREA} />
      </label>
      {LEVELS.map((level, i) => (
        <label key={level} className="wide">
          Level {level} behaviour
          <textarea rows={2} maxLength={1000} value={indicators[i] ?? ''} onChange={(e) => setIndicators((prev) => prev.map((t, n) => (n === i ? e.target.value : t)))} style={TEXTAREA} />
        </label>
      ))}
      <label>
        Active from
        <input type="date" value={activeFrom} onChange={(e) => setActiveFrom(e.target.value)} />
      </label>
      {initial && (
        <label>
          Active until (exclusive; empty: open)
          <input type="date" value={activeTo} onChange={(e) => setActiveTo(e.target.value)} />
        </label>
      )}
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : initial ? 'Save the competency' : 'Add the competency'}
        </button>
      </div>
      <p className="hint" style={FLUSH}>
        Appraisals keep the competencies as they were copied at enrolment; a change here applies to later enrolments only.
      </p>
      <Refusal error={save.error} action="competency" />
    </form>
  );
}

function useMasterList(kind: 'grades' | 'designations') {
  const { can } = useSession();
  const keys = useKeys();
  return useQuery({
    queryKey: kind === 'grades' ? keys.grades : keys.designations,
    queryFn: () => api<{ items: MasterItem[] }>(`/v1/org/${kind}`),
    enabled: can(ORG_READ),
    retry: retryTransient,
    staleTime: 5 * 60_000,
  });
}

function CompetencySetsSection() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: keys.competencySets, queryFn: () => api<{ items: CompetencySet[] }>('/v1/appraisal-competency-sets'), retry: retryTransient });
  const competencies = useQuery({ queryKey: keys.competencies, queryFn: () => api<{ items: CompetencyMaster[] }>('/v1/appraisal-competencies'), retry: retryTransient });
  const grades = useMasterList('grades');
  const designations = useMasterList('designations');
  const [gradeId, setGradeId] = useState('');
  const [designationId, setDesignationId] = useState('');
  const [from, setFrom] = useState('');
  const [rows, setRows] = useState<{ key: number; competencyId: string; weight: string }[]>([{ key: 1, competencyId: '', weight: '' }]);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ending, setEnding] = useState<{ id: string; date: string; reason: string } | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.config });
  };
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<CompetencySet>('/v1/appraisal-competency-sets', { body }),
    onSuccess: (s) => {
      setNotice(`Saved the set for ${s.grade.name}${s.designation ? ` (${s.designation.name})` : ''} from ${formatDate(s.effectiveFrom)}.`);
      setRows([{ key: 1, competencyId: '', weight: '' }]);
      setReason('');
      refresh();
    },
  });
  const end = useMutation({
    mutationFn: (p: { id: string; body: Record<string, unknown> }) => api<CompetencySet>(`/v1/appraisal-competency-sets/${p.id}/end`, { body: p.body }),
    onSuccess: (s) => {
      setNotice(`The set for ${s.grade.name} ends on ${s.effectiveTo ? formatDate(s.effectiveTo) : '—'}.`);
      setEnding(null);
      refresh();
    },
  });
  const data = shown(query);
  const choices = (shown(competencies)?.items ?? []).filter((k) => k.activeTo === null);
  const total = rows.reduce((t, r) => t + (wholeIn(r.weight, 1, 100) ? Number(r.weight) : 0), 0);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    if (!gradeId) return setProblem('Choose a grade.');
    if (!from) return setProblem('Enter the date the set starts.');
    if (rows.some((r) => !r.competencyId || !wholeIn(r.weight, 1, 100))) return setProblem('Choose a competency and a whole-number weight from 1 to 100 on every row.');
    if (total !== 100) return setProblem(`The weights total ${total}; they must total exactly 100.`);
    if (!reason.trim()) return setProblem('Enter a reason.');
    setProblem(null);
    setNotice(null);
    create.mutate({
      gradeId,
      ...(designationId ? { designationId } : {}),
      effectiveFrom: from,
      items: rows.map((r) => ({ competencyId: r.competencyId, weight: Number(r.weight) })),
      reason: reason.trim(),
    });
  };
  return (
    <Section title="Competency sets by grade">
      <p className="hint">
        Each set maps competencies, with weights totalling exactly 100, to a grade (optionally one designation, which then takes precedence). When an employee is enrolled, the set in force for their grade that day is copied
        into the appraisal and fixed.
      </p>
      {query.isPending && <p className="hint">Loading the sets…</p>}
      <QueryProblem error={query.error} forbidden="The selected role cannot view competency sets." />
      {data && data.items.length === 0 && <Empty>No competency sets yet: appraisals are scored on goals alone.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Competency sets">
            <thead>
              <tr>
                <th>Grade</th>
                <th>Designation</th>
                <th>From</th>
                <th>Until</th>
                <th>Competencies (weight)</th>
                {can(CYCLE_MANAGE) && <th>End</th>}
              </tr>
            </thead>
            <tbody>
              {data.items.map((s) => (
                <tr key={s.id}>
                  <td>{s.grade.name}</td>
                  <td>{s.designation?.name ?? 'Any'}</td>
                  <td>{formatDate(s.effectiveFrom)}</td>
                  <td>{s.effectiveTo ? formatDate(s.effectiveTo) : 'Open'}</td>
                  <td>{s.items.map((i) => `${i.name} (${i.weight})`).join(', ')}</td>
                  {can(CYCLE_MANAGE) && (
                    <td>
                      {s.effectiveTo === null && (
                        <button type="button" className="secondary" onClick={() => setEnding({ id: s.id, date: '', reason: '' })}>
                          End the {s.grade.name} set
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
      {can(CYCLE_MANAGE) && ending && (
        <form
          className="grid-form"
          aria-label="End a competency set"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const s = data?.items.find((x) => x.id === ending.id);
            if (!s || !ending.date || !ending.reason.trim()) return;
            end.mutate({ id: s.id, body: { effectiveTo: ending.date, reason: ending.reason.trim(), expectedVersion: s.version } });
          }}
        >
          <label>
            Ends on
            <input type="date" value={ending.date} onChange={(e) => setEnding({ ...ending, date: e.target.value })} />
          </label>
          <label className="wide">
            Reason
            <textarea rows={2} maxLength={1000} value={ending.reason} onChange={(e) => setEnding({ ...ending, reason: e.target.value })} style={TEXTAREA} />
          </label>
          <div className="row">
            <button type="submit" disabled={end.isPending || !ending.date || !ending.reason.trim()}>
              {end.isPending ? 'Saving…' : 'End the set'}
            </button>
            <button type="button" className="secondary" onClick={() => setEnding(null)}>
              Keep it
            </button>
          </div>
          <Refusal error={end.error} action="competency-set" />
        </form>
      )}
      {can(CYCLE_MANAGE) && (
        <form className="grid-form" aria-label="New competency set" onSubmit={submit} noValidate style={SPACED}>
          <h3 style={H3}>New competency set</h3>
          {!can(ORG_READ) ? (
            <NotPermitted>The selected role cannot list grades and designations, so it cannot map a set.</NotPermitted>
          ) : (
            <>
              <label>
                Grade
                <select value={gradeId} onChange={(e) => setGradeId(e.target.value)}>
                  <option value="">Choose…</option>
                  {(shown(grades)?.items ?? []).map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({g.code})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Designation (optional)
                <select value={designationId} onChange={(e) => setDesignationId(e.target.value)}>
                  <option value="">Any designation of the grade</option>
                  {(shown(designations)?.items ?? []).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.code})
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label>
            Starts on
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          {rows.map((r, i) => (
            <div className="row wide" key={r.key}>
              <label>
                Competency {i + 1}
                <select value={r.competencyId} onChange={(e) => setRows((prev) => prev.map((x) => (x.key === r.key ? { ...x, competencyId: e.target.value } : x)))}>
                  <option value="">Choose…</option>
                  {choices.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name} ({k.code})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Weight of competency {i + 1}
                <input inputMode="numeric" maxLength={3} value={r.weight} onChange={(e) => setRows((prev) => prev.map((x) => (x.key === r.key ? { ...x, weight: e.target.value } : x)))} />
              </label>
              {rows.length > 1 && (
                <button type="button" className="secondary" onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}>
                  Remove competency {i + 1}
                </button>
              )}
            </div>
          ))}
          <div className="row">
            <button type="button" className="secondary" disabled={rows.length >= 50} onClick={() => setRows((prev) => [...prev, { key: prev.reduce((m, x) => Math.max(m, x.key), 0) + 1, competencyId: '', weight: '' }])}>
              Add a competency
            </button>
            <span className="hint" role="status">
              Weights entered: {total} of 100.
            </span>
          </div>
          <label className="wide">
            Reason
            <textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
          </label>
          {problem && (
            <p role="alert" className="error">
              {problem}
            </p>
          )}
          <div className="row">
            <button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Saving…' : 'Save the set'}
            </button>
          </div>
          <p className="hint" style={FLUSH}>
            It starts today or later and ends the set in force for the same grade and designation that day.
          </p>
          <Refusal error={create.error} action="competency-set" />
        </form>
      )}
    </Section>
  );
}

/** FR-042 training needs from completed appraisals, offered to training planning as a suggestion only (nobody is enrolled). */
function TrainingNeeds({ cycleId, departmentId }: { cycleId: string; departmentId: string }) {
  const keys = useKeys();
  const query = useQuery({
    queryKey: keys.trainingNeeds(cycleId, departmentId),
    queryFn: () =>
      api<{
        sectionIncluded: boolean;
        population: number;
        items: { appraisalId: string; employee: { employeeCode: string; displayName: string }; employeeStated: string | null; managerRecommended: string | null }[];
      }>(`/v1/appraisal-cycles/${cycleId}/training-needs${departmentId ? `?departmentId=${departmentId}` : ''}`),
    retry: retryTransient,
  });
  const data = shown(query);
  return (
    <div style={SPACED}>
      <h3 style={H3}>Training needs (suggestions for training planning)</h3>
      {query.isPending && <p className="hint">Loading training needs…</p>}
      <QueryProblem error={query.error} forbidden="Training needs are confidential: the selected role cannot see them." />
      {data && !data.sectionIncluded && <Empty>This cycle does not include the training needs section.</Empty>}
      {data && data.sectionIncluded && data.items.length === 0 && <Empty>No completed appraisal in scope has training needs yet.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Training needs">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Stated by the employee</th>
                <th>Recommended by the manager</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.appraisalId}>
                  <td>{personLabel(r.employee)}</td>
                  <td>{r.employeeStated ?? '—'}</td>
                  <td>{r.managerRecommended ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint" style={FLUSH}>
        A suggestion only: nominate people from the training module; nobody is enrolled from here.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (App.tsx wires these)
// ---------------------------------------------------------------------------------------------------------

/**
 * Screens of the appraisal module; detail screens are reached through links (nav: false). The register's menu entry is
 * keyed to appraisal_cycle.read (held by HR and the Reporting Manager, whose cycle filter needs it) rather than
 * appraisal.read, which the Employee role also holds for its own appraisal on My ESS TN18; the screen itself checks
 * appraisal.read, as the API does.
 */
export const APPRAISAL_SCREENS: ScreenRoute[] = [
  { path: PATHS.cycles, title: 'Appraisal cycles', permission: CYCLE_READ, nav: true, component: CyclesScreen },
  { path: '/appraisal/cycles/:id', title: 'Appraisal cycle', permission: CYCLE_READ, nav: false, component: CycleDetailScreen },
  { path: PATHS.appraisals, title: 'Appraisals', permission: CYCLE_READ, nav: true, component: AppraisalsScreen },
  { path: '/appraisal/appraisals/:id', title: 'Appraisal', permission: READ, nav: false, component: AppraisalDetailScreen },
  { path: PATHS.ratings, title: 'Appraisal ratings', permission: RATE, nav: true, component: RatingsScreen },
  { path: PATHS.reviews, title: 'Appraisal reviews', permission: CONFIRM, nav: true, component: ReviewsScreen },
  { path: PATHS.reports, title: 'Appraisal reports', permission: REPORT, nav: true, component: ReportsScreen },
  { path: PATHS.goalUpload, title: 'KRA upload', permission: IMPORT, nav: true, component: GoalUploadScreen },
  // FR-041 / I-86: the result split, the competency master and the grade mapping (Appraisal Config).
  { path: PATHS.competencies, title: 'Appraisal competencies', permission: CYCLE_READ, nav: true, component: CompetencyConfigScreen },
];

/** H3 TN18 in the Employee OWN context (registration essTabs: GET /v1/me/appraisals). */
export const APPRAISAL_ESS_PANELS: EssPanel[] = [{ tabId: 'TN18', component: MyAppraisalsPanel }];

/**
 * The decision queues, also shown on the ratings and reviews screens. Tasks are listed by GET /v1/appraisal-tasks/mine
 * (appraisal.read) and decided with their step's own duty: the manager rating (appraisal.rate.rating) and the
 * independent reviewer confirmation at either level (appraisal.confirm.rating).
 */
export const APPRAISAL_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [
  { permission: RATE, title: 'Appraisal ratings', component: RatingQueue },
  { permission: CONFIRM, title: 'Appraisal reviews', component: ReviewQueue },
];
