// An employee's items (Admin, row scope): what they hold and have returned, and their custody requests.

import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, NotPermitted, Section, When } from '../../ui';
import { RaisedAgainHint } from '../requests';
import { QueryProblem } from './refusals';
import { ASSET_READ, DECISION_LABEL, holderLabel, optional, PATHS, REQUEST_READ, RequestState, SCROLL, shown, useKeys } from './shared';
import type { AssetRequest, Custody } from './types';

// ---------------------------------------------------------------------------------------------------------
// An employee's items (Admin, row scope): what they hold and have returned, e.g. for exit clearance
// ---------------------------------------------------------------------------------------------------------
export function EmployeeAssetsScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const keys = useKeys();
  const [status, setStatus] = useState('');
  const items = useQuery({
    queryKey: keys.employeeAssets(id, status),
    queryFn: () =>
      api<{ employee?: { id: string; employeeCode: string; employeeName: string }; items: Custody[] }>(`/v1/employees/${id}/assets${status ? `?status=${status}` : ''}`),
    enabled: can(ASSET_READ) && id !== '',
    retry: retryTransient,
  });
  const requests = useQuery({
    queryKey: keys.employeeRequests(id),
    queryFn: () => api<{ items: AssetRequest[] }>(`/v1/employees/${id}/asset-requests`),
    enabled: can(REQUEST_READ) && id !== '',
    retry: retryTransient,
  });
  if (!can(ASSET_READ)) {
    return (
      <div className="stack">
        <h1>Employee’s items</h1>
        <NotPermitted>The selected role cannot read asset custody.</NotPermitted>
      </div>
    );
  }
  const data = shown(items);
  const asked = shown(requests);
  return (
    <div className="stack">
      <h1>Employee’s items</h1>
      {data?.employee && <p>{holderLabel(data.employee)}</p>}
      <Section title="Items held and returned">
        <label>
          Show
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Held and returned items</option>
            <option value="HELD">Held now</option>
            <option value="RETURNED">Returned</option>
          </select>
        </label>
        {items.isPending && <p className="hint loading">Loading the items…</p>}
        <QueryProblem error={items.error} forbidden="The selected role cannot read this employee’s items." />
        {data && <CustodyTable items={data.items} label="The employee’s items" empty="No items match." />}
      </Section>
      {can(REQUEST_READ) && (
        <Section title="Custody requests">
          <QueryProblem error={requests.error} forbidden="The selected role cannot read custody requests." />
          {asked && <RequestHistory requests={asked.items} label="The employee’s custody requests" empty="The employee has no custody requests." showEmployee={false} />}
        </Section>
      )}
    </div>
  );
}

/** Items of one employee with their issue and return records (newest first, held items first, as the API orders them). */
export function CustodyTable({ items, label, empty, acknowledge }: { items: Custody[]; label: string; empty: string; acknowledge?: (k: Custody) => ReactNode }) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div style={SCROLL}>
      <table aria-label={label}>
        <thead>
          <tr>
            <th>Item</th>
            <th>Category</th>
            <th>Description</th>
            <th>Identifier</th>
            <th>Issued on</th>
            <th>Condition at issue</th>
            <th>Returned on</th>
            <th>Condition at return</th>
            <th>Status</th>
            <th>Receipt</th>
          </tr>
        </thead>
        <tbody>
          {items.map((k) => (
            <tr key={k.custodyId}>
              <td>{optional(k.assetCode)}</td>
              <td>{k.category?.label ?? '—'}</td>
              <td>{optional(k.description)}</td>
              <td>{optional(k.identifier)}</td>
              <td>{formatDate(k.issuedOn)}</td>
              <td>{k.issueCondition}</td>
              <td>{formatDate(k.returnedOn)}</td>
              <td>{optional(k.returnCondition)}</td>
              <td>
                <Badge tone={k.status === 'HELD' ? 'warn' : 'neutral'}>{k.status === 'HELD' ? 'Held' : 'Returned'}</Badge>
              </td>
              <td>{k.acknowledgedAt ? <>Acknowledged <When at={k.acknowledgedAt} /></> : (acknowledge?.(k) ?? 'Not acknowledged')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function decisionsText(r: AssetRequest): ReactNode {
  if (r.decisions.length === 0) return r.state === 'WITHDRAWN' ? 'Withdrawn before a decision' : '—';
  return r.decisions.map((d, i) => (
    <span key={`${d.decision}-${i}`}>
      {i > 0 && '; '}
      {DECISION_LABEL[d.decision] ?? readable(d.decision)} <When at={d.decidedAt} />
    </span>
  ));
}

/** Custody requests with their state, who they wait for, the decision outcomes (never the reviewer's note) and the item issued for them. */
export function RequestHistory({
  requests,
  label,
  empty,
  showEmployee,
  withdraw,
}: {
  requests: AssetRequest[];
  label: string;
  empty: string;
  showEmployee: boolean;
  withdraw?: (r: AssetRequest) => ReactNode;
}) {
  if (requests.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div style={SCROLL}>
      <table aria-label={label}>
        <thead>
          <tr>
            <th>Submitted</th>
            {showEmployee && <th>Employee</th>}
            <th>Category</th>
            <th>Item asked for</th>
            <th>Reason</th>
            <th>Status</th>
            <th>Decision</th>
            <th>Item issued</th>
            {withdraw && <th>Action</th>}
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td>
                <When at={r.submittedAt} />
              </td>
              {showEmployee && (
                <td>
                  <Link to={PATHS.employee(r.employeeId)}>{holderLabel(r)}</Link>
                </td>
              )}
              <td>{r.category.label}</td>
              <td>{optional(r.itemDescription)}</td>
              <td>{r.reason}</td>
              <td>
                <RequestState state={r.state} />
                {r.state === 'SUBMITTED' && r.pendingWith && <span className="hint"> · with {r.pendingWith}</span>}
                <RaisedAgainHint predecessorRequestId={r.predecessorRequestId} />
              </td>
              <td>{decisionsText(r)}</td>
              <td>
                {r.fulfilment
                  ? `${r.fulfilment.assetCode}, issued ${formatDate(r.fulfilment.issuedOn)}`
                  : r.state === 'APPROVED'
                    ? 'Not issued yet (an administrator issues the item separately)'
                    : '—'}
              </td>
              {withdraw && <td>{withdraw(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
