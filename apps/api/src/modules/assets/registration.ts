// Asset register, custody and custody requests (FR-110; H3 TN16; H1/BR-053; DF02; DF03; DF04). Migration
// 0049_assets.sql.
//
// Every group is operational (code, category, description, identifier, state, custody dates and condition notes,
// the employee's business reason for a custody request); nothing confidential is stored, so the Employee role gains
// no own-ESS confidential group. The Employee OWN context (H3 TN16) reads its own items and history, acknowledges
// receipt and asks for an item; it never issues, returns, retires, transfers or writes off anything (FR-110).
// The Admin duties are ceiling-only grants of the two eligible Admin roles: the BRD names no role for asset
// administration, and DF02 seeds only the specified role duties, so each Admin assignment that keeps the register
// or decides custody requests receives the duty through an independently approved grant (DB109).
import type { PermissionKey } from '../access/baseline.js';
import type { ModuleRegistration } from '../registry-types.js';

const ADMIN_DUTIES: PermissionKey[] = [
  'asset.read.operational',
  'asset.manage.operational',
  'asset.custody.operational',
  'asset_request.read.operational',
  'asset_request.decide.operational',
];

export const assetsRegistration: ModuleRegistration = {
  key: 'assets',
  active: true,
  // F2 "own pending requests": a custody request waits for the reviewer until it is decided or withdrawn.
  transactionKinds: { asset_request: ['SUBMITTED'] },
  roleGrants: {
    EMPLOYEE: { defaultDuties: ['asset.read.operational', 'asset.acknowledge.operational', 'asset_request.submit.operational', 'asset_request.read.operational'] },
    HR_ADMINISTRATOR: { ceiling: ADMIN_DUTIES },
    SYSTEM_ADMINISTRATOR: { ceiling: ADMIN_DUTIES },
  },
  operationalFieldGroups: [
    { resource: 'asset', fieldGroup: 'operational' },
    { resource: 'asset_request', fieldGroup: 'operational' },
  ],
  // An independent eligible Admin from the explicit list decides (the requester is never eligible, C4).
  workflows: [{ kind: 'asset_request', steps: [{ sequence: 1, permission: 'asset_request.decide.operational', selectionRule: 'HR_FALLBACK_LIST' }] }],
  // DF04 controlled list: the BRD names no asset category catalogue, so one neutral value is seeded and companies add their own.
  referenceValues: { ASSET_CATEGORY: { GENERAL: 'General item' } },
  // DF12: category and employee identity only; the employee's reason, the item description and reviewer notes never travel.
  notifications: [
    {
      code: 'ASSET_REQUEST_SUBMITTED',
      eventType: 'ASSET_REQUEST_SUBMITTED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'Custody request waiting for your decision',
      body: 'A custody request for {{category}} from {{employeeName}} ({{employeeCode}}) is waiting for your decision.',
      placeholders: ['category', 'employeeName', 'employeeCode'],
    },
    {
      code: 'ASSET_REQUEST_DECIDED',
      eventType: 'ASSET_REQUEST_DECIDED',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'Your custody request was {{outcome}}',
      body: 'Your custody request for {{category}} was {{outcome}}.',
      placeholders: ['category', 'outcome'],
    },
  ],
  // H3 TN16: own items, issue/return history and acknowledgment; custody request only.
  essTabs: [
    {
      tab: 'TN16',
      permissions: ['asset.read.operational', 'asset_request.submit.operational'],
      links: [
        { rel: 'assets', method: 'GET', href: '/v1/employees/{employeeId}/assets' },
        { rel: 'acknowledge', method: 'POST', href: '/v1/me/asset-acknowledgments' },
        { rel: 'requests', method: 'GET', href: '/v1/employees/{employeeId}/asset-requests' },
        { rel: 'categories', method: 'GET', href: '/v1/me/asset-categories' },
        { rel: 'submitRequest', method: 'POST', href: '/v1/me/asset-requests' },
        { rel: 'decisionHistory', method: 'GET', href: '/v1/me/requests?kind=asset_request' },
      ],
    },
  ],
};
