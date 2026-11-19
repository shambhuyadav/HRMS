// Types of the asset routes: exactly what the API returns (items, custody, requests and tasks).

// ---------------------------------------------------------------------------------------------------------
// Types: exactly what the API returns (modules/assets/service.ts and requests.ts views)
// ---------------------------------------------------------------------------------------------------------
export interface Category {
  code: string;
  label: string;
}
interface Holder {
  custodyId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  issuedOn: string;
  acknowledgedAt: string | null;
}
export interface Asset {
  id: string;
  assetCode: string;
  category: Category;
  description: string;
  identifier: string | null;
  state: string;
  retiredOn: string | null;
  retirementNote: string | null;
  holder: Holder | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export interface Custody {
  custodyId: string;
  assetId: string;
  employeeId: string;
  issuedOn: string;
  issueCondition: string;
  acknowledgedAt: string | null;
  returnedOn: string | null;
  returnCondition: string | null;
  requestId: string | null;
  status: 'HELD' | 'RETURNED';
  /** The item's custody history names the employee. */
  employeeCode?: string;
  employeeName?: string;
  /** An employee's items name the item. */
  assetCode?: string;
  category?: Category;
  description?: string;
  identifier?: string | null;
}
export interface AssetDetail extends Asset {
  custody: Custody[];
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
interface HeldItem {
  assetCode: string;
  category: string;
  description: string;
  issuedOn: string;
}
export interface AssetRequest {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  category: Category;
  itemDescription: string | null;
  reason: string;
  state: string;
  submittedAt: string;
  decidedAt: string | null;
  version: number;
  pendingWith: string | null;
  decisions: { decision: string; decidedAt: string }[];
  fulfilment: { custodyId: string; assetId: string; assetCode: string; issuedOn: string } | null;
  /** Present only when the reviewer's assignment may also read asset custody. */
  currentlyHeld?: HeldItem[];
  /** DF03: the rejected request this one raises again. */
  predecessorRequestId?: string | null;
}
export interface RequestTask {
  taskId: string;
  transactionId: string;
  ownerEmployeeId: string;
  ownerEmployeeCode?: string | null;
  ownerName?: string | null;
  assignedAt?: string;
  /** null when the request's employee is outside the reviewer's row scope. */
  request: AssetRequest | null;
}
