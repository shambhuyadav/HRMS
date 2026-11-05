// Outbox topics of registered business modules and how each becomes a notification event. The dispatcher
// consults this map for topics it does not describe itself. A describer reads only operational fields
// (never reasons, amounts or private data) and returns null when the event should produce nothing.
import type { Queryable } from '../db/queryable.js';
import { APPRAISAL_EVENTS } from './appraisal/events.js';
import { ASSETS_EVENTS } from './assets/events.js';
import { BIOMETRIC_EVENTS } from './biometric/events.js';
import { EXPENSE_EVENTS } from './expense/events.js';
import { HIRING_EVENTS } from './hiring/events.js';
import { INCREMENT_EVENTS } from './increment/events.js';
import { LIFECYCLE_EVENTS } from './lifecycle/events.js';
import type { EventSpec } from './notification/dispatcher.js';
import { PAYROLL_EVENTS } from './payroll/events.js';
import { PAYROLL_ADJUSTMENT_EVENTS } from './payroll-adjustments/events.js';
import { PAYROLL_OUTPUTS_EVENTS } from './payroll-outputs/events.js';
import { isModuleActive } from './registry.js';
import { SENSITIVE_CHANGE_EVENTS } from './sensitive-change/events.js';
import { TAX_DECLARATION_EVENTS } from './tax-declarations/events.js';
import { TIMESHEET_EVENTS } from './timesheet/events.js';
import { TRAINING_EVENTS } from './training/events.js';

export interface ModuleOutboxEvent {
  companyId: string;
  topic: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export type EventDescriber = (tx: Queryable, event: ModuleOutboxEvent) => Promise<EventSpec | null>;

const ALL_EVENTS: readonly { key: string; describers: Readonly<Record<string, EventDescriber>> }[] = [
  { key: 'sensitive-change', describers: SENSITIVE_CHANGE_EVENTS },
  { key: 'hiring', describers: HIRING_EVENTS },
  { key: 'appraisal', describers: APPRAISAL_EVENTS },
  { key: 'training', describers: TRAINING_EVENTS },
  { key: 'timesheet', describers: TIMESHEET_EVENTS },
  { key: 'lifecycle', describers: LIFECYCLE_EVENTS },
  { key: 'payroll', describers: PAYROLL_EVENTS },
  { key: 'payroll-outputs', describers: PAYROLL_OUTPUTS_EVENTS },
  { key: 'payroll-adjustments', describers: PAYROLL_ADJUSTMENT_EVENTS },
  { key: 'tax-declarations', describers: TAX_DECLARATION_EVENTS },
  { key: 'assets', describers: ASSETS_EVENTS },
];

/** Core modules that are not registrations of their own (modules/registry.ts), so they are always active. */
const CORE_EVENTS: readonly Readonly<Record<string, EventDescriber>>[] = [EXPENSE_EVENTS, INCREMENT_EVENTS, BIOMETRIC_EVENTS];

export const MODULE_EVENT_DESCRIBERS: Readonly<Record<string, EventDescriber>> = Object.assign(
  {},
  ...CORE_EVENTS,
  ...ALL_EVENTS.filter((e) => isModuleActive(e.key)).map((e) => e.describers),
) as Record<string, EventDescriber>;
