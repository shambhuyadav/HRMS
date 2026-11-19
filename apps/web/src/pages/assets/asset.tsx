// One item (Admin): details, custody history, issue, return, change and retirement.

import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, type EmployeeHit, formatDate, personLabel, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Item, Notice, NotPermitted, Section, When } from '../../ui';
import { CategorySelect, EmployeePicker, useCategories } from './lookups';
import { Problem, QueryProblem, Refusal } from './refusals';
import { ASSET_CUSTODY, ASSET_MANAGE, ASSET_READ, AssetState, FLUSH, holderLabel, optional, PATHS, REQUEST_READ, SCROLL, shown, TEXTAREA, useAttemptKey, useKeys, useRefetchAll } from './shared';
import type { Asset, AssetDetail, AssetRequest } from './types';

// ---------------------------------------------------------------------------------------------------------
// One item (Admin): details, custody history, issue, return, change and retirement
// ---------------------------------------------------------------------------------------------------------
export function AssetDetailScreen() {
  const { id = '' } = useParams();
  const { can, me } = useSession();
  const keys = useKeys();
  const allowed = can(ASSET_READ) && me?.scopeKind !== 'OWN';
  const detail = useQuery({ queryKey: keys.asset(id), queryFn: () => api<AssetDetail>(`/v1/assets/${id}`), enabled: allowed && id !== '', retry: retryTransient });
  const a = shown(detail);
  if (!allowed) {
    return (
      <div className="stack">
        <h1>Asset</h1>
        <NotPermitted>The asset register needs an unrestricted company-scope Admin assignment.</NotPermitted>
      </div>
    );
  }
  return (
    <div className="stack">
      <p style={FLUSH}>
        <Link to={PATHS.register}>Back to the register</Link>
      </p>
      <h1>{a ? `${a.assetCode}: ${a.description}` : 'Asset'}</h1>
      {detail.isPending && <p className="hint loading">Loading the item…</p>}
      <QueryProblem error={detail.error} forbidden="The asset register needs an unrestricted company-scope Admin assignment." />
      {a && <AssetBody a={a} />}
    </div>
  );
}

function AssetBody({ a }: { a: AssetDetail }) {
  const { can } = useSession();
  const inStock = a.state === 'IN_STOCK' || a.state === 'RETURNED_TO_STOCK';
  // Kept here: an issue or return changes the state, which swaps the form that recorded it for the other one.
  const [done, setDone] = useState<string | null>(null);
  return (
    <>
      <Notice notice={done ? { text: done, ok: true } : null} />
      <Section title="Item">
        <dl className="kv">
          <Item term="Asset code">{a.assetCode}</Item>
          <Item term="Category">{a.category.label}</Item>
          <Item term="Description">{a.description}</Item>
          <Item term="Identifier">{optional(a.identifier)}</Item>
          <Item term="State">
            <AssetState state={a.state} />
          </Item>
          <Item term="Held by">{a.holder ? <Link to={PATHS.employee(a.holder.employeeId)}>{holderLabel(a.holder)}</Link> : 'Nobody'}</Item>
          {a.holder && <Item term="Issued on">{formatDate(a.holder.issuedOn)}</Item>}
          {a.holder && <Item term="Receipt">{a.holder.acknowledgedAt ? <>Acknowledged <When at={a.holder.acknowledgedAt} /></> : 'Not acknowledged yet'}</Item>}
          {a.state === 'RETIRED' && <Item term="Retired on">{formatDate(a.retiredOn)}</Item>}
          {a.state === 'RETIRED' && a.retirementNote !== null && <Item term="Retirement note">{a.retirementNote}</Item>}
          <Item term="Added">
            <When at={a.createdAt} />
          </Item>
        </dl>
      </Section>
      {can(ASSET_CUSTODY) && inStock && <IssueForm a={a} onDone={setDone} />}
      {can(ASSET_CUSTODY) && a.state === 'ISSUED' && <ReturnForm a={a} onDone={setDone} />}
      <CustodyHistory a={a} />
      {can(ASSET_MANAGE) && a.state !== 'RETIRED' && <EditForm a={a} />}
      {can(ASSET_MANAGE) && inStock && <RetireForm a={a} />}
    </>
  );
}

function CustodyHistory({ a }: { a: AssetDetail }) {
  return (
    <Section title="Custody history">
      {a.custody.length === 0 ? (
        <Empty>The item has never been issued.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Custody history">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Issued on</th>
                <th>Condition at issue</th>
                <th>Receipt</th>
                <th>Returned on</th>
                <th>Condition at return</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {a.custody.map((k) => (
                <tr key={k.custodyId}>
                  <td>
                    <Link to={PATHS.employee(k.employeeId)}>{holderLabel(k)}</Link>
                  </td>
                  <td>{formatDate(k.issuedOn)}</td>
                  <td>{k.issueCondition}</td>
                  <td>{k.acknowledgedAt ? <>Acknowledged <When at={k.acknowledgedAt} /></> : 'Not acknowledged'}</td>
                  <td>{formatDate(k.returnedOn)}</td>
                  <td>{optional(k.returnCondition)}</td>
                  <td>
                    <Badge tone={k.status === 'HELD' ? 'warn' : 'neutral'}>{k.status === 'HELD' ? 'Held' : 'Returned'}</Badge>
                    {k.requestId && <span className="hint"> · fulfils a custody request</span>}
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

function IssueForm({ a, onDone: setDone }: { a: AssetDetail; onDone: (text: string | null) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const refetchAll = useRefetchAll();
  const attempt = useAttemptKey('asset-issue');
  const [employee, setEmployee] = useState<EmployeeHit | null>(null);
  const [issuedOn, setIssuedOn] = useState('');
  const [condition, setCondition] = useState('');
  const [requestId, setRequestId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const canReadRequests = can(REQUEST_READ);
  const requests = useQuery({
    queryKey: keys.employeeRequests(employee?.id ?? '-'),
    queryFn: () => api<{ items: AssetRequest[] }>(`/v1/employees/${employee!.id}/asset-requests`),
    enabled: canReadRequests && employee !== null,
    retry: retryTransient,
  });
  const open = (shown(requests)?.items ?? []).filter((r) => r.state === 'APPROVED' && r.fulfilment === null);
  const issue = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ custodyId: string; issuedOn: string }>(`/v1/assets/${a.id}/issue`, { method: 'POST', body }),
    onSuccess: (result, body) => {
      attempt.reset();
      setDone(`${a.assetCode} was issued to ${employee ? personLabel(employee) : 'the employee'} on ${formatDate(result.issuedOn ?? (body.issuedOn as string | undefined))}.`);
      setEmployee(null);
      setIssuedOn('');
      setCondition('');
      setRequestId('');
      void refetchAll();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.reset();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setDone(null);
    if (!employee) return setProblem('Choose the employee who receives the item.');
    if (!condition.trim()) return setProblem('Record the condition of the item.');
    setProblem(null);
    const content = { employeeId: employee.id, ...(issuedOn ? { issuedOn } : {}), condition: condition.trim(), ...(requestId ? { requestId } : {}) };
    issue.mutate({ ...content, idempotencyKey: attempt.keyFor(JSON.stringify([a.id, content])) });
  };
  return (
    <Section title="Issue the item">
      <form className="grid-form" aria-label="Issue the item" onSubmit={submit} noValidate>
        <EmployeePicker
          value={employee}
          onChange={(e) => {
            setEmployee(e);
            setRequestId('');
          }}
        />
        <label>
          Issued on (empty for today)
          <input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
        </label>
        {employee && canReadRequests && (
          <label>
            Fulfils the approved custody request (optional)
            <select value={requestId} onChange={(e) => setRequestId(e.target.value)}>
              <option value="">No request</option>
              {open.map((r) => (
                <option key={r.id} value={r.id}>
                  {`${r.category.label}${r.itemDescription ? `: ${r.itemDescription}` : ''} (approved ${formatDate(r.decidedAt)})`}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="wide">
          Condition at issue
          <textarea style={TEXTAREA} rows={2} value={condition} maxLength={1000} onChange={(e) => setCondition(e.target.value)} />
        </label>
        <p className="hint wide">Items go only from stock to an active employee, dated today or earlier and not before the last return.</p>
        <div className="wide">
          <button type="submit" disabled={issue.isPending}>
            {issue.isPending ? 'Issuing…' : 'Issue the item'}
          </button>
        </div>
      </form>
      <Problem text={problem} />
      <Refusal error={issue.error} action="issue" />
    </Section>
  );
}

function ReturnForm({ a, onDone: setDone }: { a: AssetDetail; onDone: (text: string | null) => void }) {
  const refetchAll = useRefetchAll();
  const attempt = useAttemptKey('asset-return');
  const [returnedOn, setReturnedOn] = useState('');
  const [condition, setCondition] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const giveBack = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ returnedOn: string }>(`/v1/assets/${a.id}/return`, { method: 'POST', body }),
    onSuccess: (result) => {
      attempt.reset();
      setDone(`The return of ${a.assetCode} on ${formatDate(result.returnedOn)} was recorded. The item is back in stock.`);
      setReturnedOn('');
      setCondition('');
      void refetchAll();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.reset();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setDone(null);
    if (!condition.trim()) return setProblem('Record the condition of the item.');
    setProblem(null);
    const content = { ...(returnedOn ? { returnedOn } : {}), condition: condition.trim() };
    giveBack.mutate({ ...content, idempotencyKey: attempt.keyFor(JSON.stringify([a.id, a.holder?.custodyId ?? null, content])) });
  };
  return (
    <Section title="Record the return">
      <form className="grid-form" aria-label="Record the return" onSubmit={submit} noValidate>
        <p className="hint wide">
          Held by {a.holder ? holderLabel(a.holder) : 'an employee'} since {formatDate(a.holder?.issuedOn)}. A return is recorded whatever the employee’s status, so
          clearance works after separation.
        </p>
        <label>
          Returned on (empty for today)
          <input type="date" value={returnedOn} onChange={(e) => setReturnedOn(e.target.value)} />
        </label>
        <label className="wide">
          Condition at return
          <textarea style={TEXTAREA} rows={2} value={condition} maxLength={1000} onChange={(e) => setCondition(e.target.value)} />
        </label>
        <div className="wide">
          <button type="submit" disabled={giveBack.isPending}>
            {giveBack.isPending ? 'Recording…' : 'Record the return'}
          </button>
        </div>
      </form>
      <Problem text={problem} />
      <Refusal error={giveBack.error} action="return" />
    </Section>
  );
}

function EditForm({ a }: { a: AssetDetail }) {
  const refetchAll = useRefetchAll();
  const categories = useCategories(false, true);
  const [categoryCode, setCategoryCode] = useState(a.category.code);
  const [description, setDescription] = useState(a.description);
  const [identifier, setIdentifier] = useState(a.identifier ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Asset>(`/v1/assets/${a.id}`, { method: 'PATCH', body }),
    onSettled: (_data, error) => {
      // A success, or a refusal because the item changed, both reload it.
      if (!error || (error instanceof ApiError && (error.code === 'STALE_VERSION' || error.code === 'ASSET_RETIRED'))) void refetchAll();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const changes: Record<string, unknown> = {};
    if (categoryCode !== a.category.code) changes.categoryCode = categoryCode;
    if (description.trim() !== a.description) changes.description = description.trim();
    const nextIdentifier = identifier.trim() === '' ? null : identifier.trim();
    if (nextIdentifier !== a.identifier) changes.identifier = nextIdentifier;
    if (!description.trim()) return setProblem('Describe the item.');
    if (Object.keys(changes).length === 0) return setProblem('Nothing differs from the register entry.');
    setProblem(null);
    save.mutate({ expectedVersion: a.version, ...changes });
  };
  return (
    <Section title="Correct the register entry">
      <form className="grid-form" aria-label="Correct the register entry" onSubmit={submit} noValidate>
        <CategorySelect label="Category" value={categoryCode} onChange={setCategoryCode} categories={shown(categories)?.items} current={a.category} />
        <label>
          Identifier (optional)
          <input value={identifier} maxLength={200} onChange={(e) => setIdentifier(e.target.value)} />
        </label>
        <label className="wide">
          Description
          <input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="wide">
          <button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save the correction'}
          </button>
        </div>
      </form>
      <Problem text={problem} />
      <Refusal error={save.error} action="update" />
      {save.isSuccess && (
        <p role="status" className="ok">
          The register entry was corrected.
        </p>
      )}
    </Section>
  );
}

function RetireForm({ a }: { a: AssetDetail }) {
  const refetchAll = useRefetchAll();
  const [retiredOn, setRetiredOn] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const retire = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Asset>(`/v1/assets/${a.id}/retire`, { method: 'POST', body }),
    onSettled: (_data, error) => {
      if (!error || (error instanceof ApiError && ['STALE_VERSION', 'ASSET_RETIRED', 'ASSET_ISSUED'].includes(error.code))) void refetchAll();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return setProblem('Record why the item is retired.');
    setProblem(null);
    retire.mutate({ ...(retiredOn ? { retiredOn } : {}), note: note.trim(), expectedVersion: a.version });
  };
  return (
    <Section title="Retire the item">
      <form className="grid-form" aria-label="Retire the item" onSubmit={submit} noValidate>
        <p className="hint wide">Retirement is final: the item stays in the register and is never issued again. There is no write-off or transfer here.</p>
        <label>
          Retired on (empty for today)
          <input type="date" value={retiredOn} onChange={(e) => setRetiredOn(e.target.value)} />
        </label>
        <label className="wide">
          Why the item is retired
          <textarea style={TEXTAREA} rows={2} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="wide">
          <button type="submit" className="danger" disabled={retire.isPending}>
            {retire.isPending ? 'Retiring…' : 'Retire the item'}
          </button>
        </div>
      </form>
      <Problem text={problem} />
      <Refusal error={retire.error} action="retire" />
    </Section>
  );
}
