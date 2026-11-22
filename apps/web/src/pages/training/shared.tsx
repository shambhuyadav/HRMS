// Shared parts of the training screens: permission keys, paths, labels, query keys and small helpers.

import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { formatAmount, isForbidden, isNotFound, readable } from '../../api';
import { type MeContext, useSession } from '../../session';
import { Badge } from '../../ui';
import type { Plan } from './types';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (modules/training/registration.ts, routes.ts; migration 0036_training.sql) and screen paths
// ---------------------------------------------------------------------------------------------------------
/** GET /v1/training-plans, /:id, /v1/training-modes, /v1/training-feedback-questions. */
export const PLAN_READ = 'training_plan.read.operational';
/** POST /v1/training-plans, PATCH /:id, POST /:id/cancel (unrestricted company scope). */
export const PLAN_MANAGE = 'training_plan.manage.operational';
/** GET /v1/training-plans/export. */
export const PLAN_EXPORT = 'training_plan.export.operational';
/** A cost in a create or change request needs this group as well. */
export const COST_MANAGE = 'training_plan.manage.cost';
/** GET /v1/training-plans/:id/participants, /v1/training-participants/:id, /v1/employees/:id/training. */
export const PART_READ = 'training_participant.read.operational';
/** POST /v1/training-plans/:id/participants and /participant-actions. */
export const PART_MANAGE = 'training_participant.manage.operational';
/** GET /v1/me/training-plans, POST /v1/me/training-nominations and its withdrawal (Employee OWN context). */
export const PART_ENROL = 'training_participant.enrol.operational';
/** GET /v1/training-plans/:id/feedback-summary and /feedback; GET /v1/me/training-feedback. */
export const FEEDBACK_READ = 'training_feedback.read.operational';
/** POST /v1/me/training-feedback. */
export const FEEDBACK_SUBMIT = 'training_feedback.submit.operational';
/** A comment in the own feedback needs this confidential group as well. */
export const COMMENT_SUBMIT = 'training_feedback.submit.comment';
/** GET /v1/training-plans/:id/feedback/export. */
export const FEEDBACK_EXPORT = 'training_feedback.export.operational';
/** GET /v1/employees: whom to nominate, who owns a plan. */
export const EMPLOYEE_LIST = 'employee.list.operational';
/** Own training is served only in the Employee OWN context (BR-055). */
const OWN_ESS_ROLE = 'EMPLOYEE';

export const PATHS = {
  plans: '/training/plans',
  plan: (id: string) => `/training/plans/${id}`,
  feedback: (id: string) => `/training/plans/${id}/feedback`,
  participant: (id: string) => `/training/participants/${id}`,
  employee: (id: string) => `/training/employees/${id}`,
} as const;

export const PAGE_SIZE = 25;
export const VIEWS = ['FUTURE', 'CURRENT', 'PAST', 'CANCELLED'] as const;
export const VIEW_LABEL: Record<string, string> = { FUTURE: 'Future', CURRENT: 'Current', PAST: 'Past', CANCELLED: 'Cancelled' };
const VIEW_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { FUTURE: 'neutral', CURRENT: 'good', PAST: 'neutral', CANCELLED: 'bad' };
export const STATES = ['NOMINATED', 'CONFIRMED', 'ATTENDED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'] as const;
export const STATE_LABEL: Record<string, string> = {
  NOMINATED: 'Nominated, waiting for confirmation',
  CONFIRMED: 'Confirmed',
  ATTENDED: 'Attended',
  COMPLETED: 'Completed',
  NO_SHOW: 'No-show',
  CANCELLED: 'Cancelled',
};
const STATE_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = {
  NOMINATED: 'warn',
  CONFIRMED: 'good',
  ATTENDED: 'good',
  COMPLETED: 'good',
  NO_SHOW: 'bad',
  CANCELLED: 'neutral',
};
export const FEEDBACK_LABEL: Record<string, string> = { RESPONDED: 'Responded', MISSING: 'Missing response', NOT_APPLICABLE: 'Not applicable (not completed)' };
const FEEDBACK_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { RESPONDED: 'good', MISSING: 'warn', NOT_APPLICABLE: 'neutral' };
export const HISTORY_LABEL: Record<string, string> = {
  NOMINATE: 'Nominated by the coordinator',
  SELF_NOMINATE: 'Self-nominated',
  CONFIRM: 'Confirmed',
  MARK_ATTENDED: 'Marked attended',
  MARK_NO_SHOW: 'Marked no-show',
  COMPLETE: 'Completed',
  CANCEL: 'Cancelled',
  WITHDRAW: 'Withdrawn by the employee',
  PLAN_CANCELLED: 'Cancelled with the plan',
};
export type TransitionAction = 'CONFIRM' | 'MARK_ATTENDED' | 'MARK_NO_SHOW' | 'COMPLETE' | 'CANCEL';
export const TRANSITIONS: readonly (readonly [action: TransitionAction, label: string, done: string])[] = [
  ['CONFIRM', 'Confirm', 'confirmed'],
  ['MARK_ATTENDED', 'Mark attended', 'marked attended'],
  ['MARK_NO_SHOW', 'Mark no-show', 'marked no-show'],
  ['COMPLETE', 'Mark completed', 'marked completed'],
  ['CANCEL', 'Cancel participation', 'cancelled'],
];
export const SCORES = ['1', '2', '3', '4', '5'] as const;

// ---------------------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------------------

/**
 * Query keys carry the selected company and assignment: the app keeps one query cache across role switches, and an
 * answer given to one assignment (costs, reasons, comments) must never be shown under another.
 */
export function useKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(() => {
    const base = ['training', context] as const;
    return {
      all: base,
      modes: [...base, 'modes'] as const,
      questions: [...base, 'questions'] as const,
      plans: (query: string) => [...base, 'plans', query] as const,
      plan: (id: string) => [...base, 'plan', id] as const,
      participants: (id: string, query: string) => [...base, 'participants', id, query] as const,
      participant: (id: string) => [...base, 'participant', id] as const,
      employee: (id: string) => [...base, 'employee', id] as const,
      summary: (id: string) => [...base, 'summary', id] as const,
      register: (id: string, status: string) => [...base, 'register', id, status] as const,
      openPlans: [...base, 'open-plans'] as const,
      ownFeedback: [...base, 'own-feedback'] as const,
      employeeSearch: (term: string) => [...base, 'employee-search', term] as const,
    };
  }, [context]);
}

/** After any change everything this module shows in the selected context is fetched again (never optimistic). */
export function useRefetchAll() {
  const qc = useQueryClient();
  const keys = useKeys();
  return () => qc.invalidateQueries({ queryKey: keys.all });
}

/** The latest answer, unless the server has since refused it (403/404): what the role may no longer see is not kept. */
export function shown<T>(query: { data: T | undefined; error: unknown }): T | undefined {
  return isForbidden(query.error) || isNotFound(query.error) ? undefined : query.data;
}

export const inOwnContext = (me: MeContext | null) => me !== null && me.roleCode === OWN_ESS_ROLE && me.scopeKind === 'OWN' && me.employeeId !== null;
export const participantLabel = (p: { employeeName: string; employeeCode: string }) => `${p.employeeName} (${p.employeeCode})`;
export const optional = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? '—' : v);
export const has = <T extends object>(row: T, key: string) => Object.prototype.hasOwnProperty.call(row, key);

export function ViewBadge({ view }: { view: string }) {
  return <Badge tone={VIEW_TONE[view] ?? 'neutral'}>{VIEW_LABEL[view] ?? readable(view)}</Badge>;
}
export function ParticipationState({ state }: { state: string }) {
  return <Badge tone={STATE_TONE[state] ?? 'neutral'}>{STATE_LABEL[state] ?? readable(state)}</Badge>;
}
export function FeedbackState({ status }: { status: string }) {
  return <Badge tone={FEEDBACK_TONE[status] ?? 'neutral'}>{FEEDBACK_LABEL[status] ?? readable(status)}</Badge>;
}

/** The plan cost as returned: nothing when the caller has no cost group, "No cost" for null, else the exact amount. */
export function CostText({ plan }: { plan: Pick<Plan, 'cost'> }) {
  if (!has(plan, 'cost') || plan.cost === undefined) return null;
  return <>{plan.cost === null ? 'No cost recorded' : formatAmount(plan.cost.amount, plan.cost.currency)}</>;
}
