// An employee's items (Admin, row scope): what they hold and have returned, and their custody requests.

import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, NotPermitted, Section, When } from '../../ui';
import { RaisedAgainHint } from '../requests';
import { QueryProblem } from './refusals';
import { ASSET_READ, DECISION_LABEL, holderLabel, optional, PATHS, REQUEST_READ, RequestState, shown, useKeys } from './shared';
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
      <div className="flex flex-col gap-3">
        <h1>Employee’s items</h1>
        <NotPermitted>The selected role cannot read asset custody.</NotPermitted>
      </div>
    );
  }
  const data = shown(items);
  const asked = shown(requests);
  return (
    <div className="flex flex-col gap-3">
      <h1>Employee’s items</h1>
      {data?.employee && <p>{holderLabel(data.employee)}</p>}
      <Section title="Items held and returned">
        <FormField>
          Show
          <NativeSelect value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Held and returned items</option>
            <option value="HELD">Held now</option>
            <option value="RETURNED">Returned</option>
          </NativeSelect>
        </FormField>
        {items.isPending && <LoadingLine>Loading the items…</LoadingLine>}
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
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Item</TableHead>
          <TableHead scope="col">Category</TableHead>
          <TableHead scope="col">Description</TableHead>
          <TableHead scope="col">Identifier</TableHead>
          <TableHead scope="col">Issued on</TableHead>
          <TableHead scope="col">Condition at issue</TableHead>
          <TableHead scope="col">Returned on</TableHead>
          <TableHead scope="col">Condition at return</TableHead>
          <TableHead scope="col">Status</TableHead>
          <TableHead scope="col">Receipt</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((k) => (
          <TableRow key={k.custodyId}>
            <TableCell>{optional(k.assetCode)}</TableCell>
            <TableCell>{k.category?.label ?? '—'}</TableCell>
            <TableCell>{optional(k.description)}</TableCell>
            <TableCell>{optional(k.identifier)}</TableCell>
            <TableCell>{formatDate(k.issuedOn)}</TableCell>
            <TableCell>{k.issueCondition}</TableCell>
            <TableCell>{formatDate(k.returnedOn)}</TableCell>
            <TableCell>{optional(k.returnCondition)}</TableCell>
            <TableCell>
              <Badge tone={k.status === 'HELD' ? 'warn' : 'neutral'}>{k.status === 'HELD' ? 'Held' : 'Returned'}</Badge>
            </TableCell>
            <TableCell>{k.acknowledgedAt ? <>Acknowledged <When at={k.acknowledgedAt} /></> : (acknowledge?.(k) ?? 'Not acknowledged')}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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

/** The item issued for a request, or what is still to come for an approved one. */
function issuedText(r: AssetRequest): string {
  if (r.fulfilment) return `${r.fulfilment.assetCode}, issued ${formatDate(r.fulfilment.issuedOn)}`;
  return r.state === 'APPROVED' ? 'Not issued yet (an administrator issues the item separately)' : '—';
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
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Submitted</TableHead>
          {showEmployee && <TableHead scope="col">Employee</TableHead>}
          <TableHead scope="col">Category</TableHead>
          <TableHead scope="col">Item asked for</TableHead>
          <TableHead scope="col">Reason</TableHead>
          <TableHead scope="col">Status</TableHead>
          <TableHead scope="col">Decision</TableHead>
          <TableHead scope="col">Item issued</TableHead>
          {withdraw && <TableHead scope="col">Action</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {requests.map((r) => (
          <TableRow key={r.id}>
            <TableCell>
              <When at={r.submittedAt} />
            </TableCell>
            {showEmployee && (
              <TableCell>
                <Link to={PATHS.employee(r.employeeId)}>{holderLabel(r)}</Link>
              </TableCell>
            )}
            <TableCell>{r.category.label}</TableCell>
            <TableCell>{optional(r.itemDescription)}</TableCell>
            <TableCell>{r.reason}</TableCell>
            <TableCell>
              <RequestState state={r.state} />
              {r.state === 'SUBMITTED' && r.pendingWith && <Hint as="span"> · with {r.pendingWith}</Hint>}
              <RaisedAgainHint predecessorRequestId={r.predecessorRequestId} />
            </TableCell>
            <TableCell>{decisionsText(r)}</TableCell>
            <TableCell>{issuedText(r)}</TableCell>
            {withdraw && (
              <RowActionsCell>
                <RowActions>{withdraw(r)}</RowActions>
              </RowActionsCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
