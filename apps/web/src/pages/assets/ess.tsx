// My ESS TN16 (Employee OWN context): own items, acknowledgment of receipt and custody requests.

import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Notice, NotPermitted, Section } from '../../ui';
import { canRaiseAgain, followedRequests, RaiseAgainNote } from '../requests';
import { CustodyTable, RequestHistory } from './employee-assets';
import { CategorySelect, useCategories } from './lookups';
import { Problem, QueryProblem, Refusal } from './refusals';
import { ASSET_ACKNOWLEDGE, ASSET_READ, inOwnContext, REQUEST_READ, REQUEST_SUBMIT, shown, useAttemptKey, useKeys, useRefetchAll } from './shared';
import type { AssetRequest, Custody } from './types';

// ---------------------------------------------------------------------------------------------------------
// My ESS TN16 (Employee OWN context): own items, acknowledgment of receipt and custody requests
// ---------------------------------------------------------------------------------------------------------
export function MyAssetsPanel() {
  const { me, can } = useSession();
  if (!inOwnContext(me)) return <Empty>Select your Employee role to see your own items and custody requests.</Empty>;
  const employeeId = me!.employeeId!;
  return <MyAssetsSections employeeId={employeeId} />;
}

function MyAssetsSections({ employeeId }: { employeeId: string }) {
  const { can } = useSession();
  // DF03: the rejected request being raised again fills the form.
  const [raisingAgain, setRaisingAgain] = useState<AssetRequest | null>(null);
  return (
    <div className="flex flex-col gap-3">
      {can(ASSET_READ) ? <MyItems employeeId={employeeId} /> : <NotPermitted>Your Employee role cannot read your items.</NotPermitted>}
      {can(REQUEST_SUBMIT) && <AskForItem raisingAgain={raisingAgain} onCancelRaising={() => setRaisingAgain(null)} />}
      {can(REQUEST_READ) && <MyRequests employeeId={employeeId} onRaiseAgain={setRaisingAgain} />}
    </div>
  );
}

function MyItems({ employeeId }: { employeeId: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const refetchAll = useRefetchAll();
  const items = useQuery({
    queryKey: keys.employeeAssets(employeeId, ''),
    queryFn: () => api<{ items: Custody[] }>(`/v1/employees/${employeeId}/assets`),
    retry: retryTransient,
  });
  const acknowledge = useMutation({
    mutationFn: (custodyId: string) => api<{ custodyId: string; acknowledgedAt: string }>('/v1/me/asset-acknowledgments', { method: 'POST', body: { custodyId } }),
    onSettled: () => void refetchAll(),
  });
  const data = shown(items);
  const held = (data?.items ?? []).filter((k) => k.status === 'HELD');
  const returned = (data?.items ?? []).filter((k) => k.status === 'RETURNED');
  const ackButton = (k: Custody) =>
    k.status === 'HELD' && can(ASSET_ACKNOWLEDGE) ? (
      <Button type="button" size="sm" disabled={acknowledge.isPending} aria-label={`Acknowledge receipt of ${k.assetCode ?? 'the item'}`} onClick={() => acknowledge.mutate(k.custodyId)}>
        Acknowledge receipt
      </Button>
    ) : (
      'Not acknowledged'
    );
  return (
    <>
      <Section title="Items I hold">
        <Hint>Acknowledge each item you have received, once per issue. Returns are recorded by an administrator.</Hint>
        {items.isPending && <LoadingLine>Loading your items…</LoadingLine>}
        <QueryProblem error={items.error} forbidden="Your Employee role cannot read your items." />
        <Refusal error={acknowledge.error} action="acknowledge" />
        {acknowledge.isSuccess && <Notice notice={{ text: 'Your acknowledgment of receipt was recorded.', ok: true }} />}
        {data && <CustodyTable items={held} label="Items I hold" empty="You hold no company items." acknowledge={ackButton} />}
      </Section>
      {data && returned.length > 0 && (
        <Section title="Returned items">
          <CustodyTable items={returned} label="Items I have returned" empty="" />
        </Section>
      )}
    </>
  );
}

function AskForItem({ raisingAgain, onCancelRaising }: { raisingAgain: AssetRequest | null; onCancelRaising: () => void }) {
  const refetchAll = useRefetchAll();
  const attempt = useAttemptKey('asset-request');
  const categories = useCategories(true, true);
  const [categoryCode, setCategoryCode] = useState('');
  const [itemDescription, setItemDescription] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!raisingAgain) return;
    setCategoryCode(raisingAgain.category.code);
    setItemDescription(raisingAgain.itemDescription ?? '');
    setReason(raisingAgain.reason);
    setDone(false);
    setProblem(null);
  }, [raisingAgain]);
  const submit = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ requestId: string; state: string }>('/v1/me/asset-requests', { method: 'POST', body }),
    onSuccess: () => {
      attempt.reset();
      setDone(true);
      setCategoryCode('');
      setItemDescription('');
      setReason('');
      onCancelRaising();
      void refetchAll();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.reset();
    },
  });
  const send = (e: FormEvent) => {
    e.preventDefault();
    setDone(false);
    if (!categoryCode) return setProblem('Choose the kind of item you need.');
    if (!reason.trim()) return setProblem('Explain why you need the item.');
    setProblem(null);
    const content = { categoryCode, ...(itemDescription.trim() ? { itemDescription: itemDescription.trim() } : {}), reason: reason.trim(), ...(raisingAgain ? { predecessorRequestId: raisingAgain.id } : {}) };
    submit.mutate({ ...content, idempotencyKey: attempt.keyFor(JSON.stringify(content)) });
  };
  return (
    <Section title="Ask for an item">
      {raisingAgain && <RaiseAgainNote onCancel={onCancelRaising} />}
      <FormGrid aria-label="Ask for an item" onSubmit={send} noValidate>
        <CategorySelect label="Category" value={categoryCode} onChange={setCategoryCode} categories={shown(categories)?.items} />
        <FormField>
          Specific item (optional)
          <Input value={itemDescription} maxLength={300} onChange={(e) => setItemDescription(e.target.value)} />
        </FormField>
        <FormField className="col-span-full">
          Why you need it
          <Textarea rows={2} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        <Hint>An administrator decides the request. An approval does not hand over anything by itself: the item is issued to you separately.</Hint>
        <div className="col-span-full">
          <Button type="submit" disabled={submit.isPending}>
            {submit.isPending ? 'Sending…' : 'Send the request'}
          </Button>
        </div>
      </FormGrid>
      <QueryProblem error={categories.error} forbidden="Your Employee role cannot ask for items." action="submit" />
      <Problem text={problem} />
      <Refusal error={submit.error} action="submit" />
      {done && <Notice notice={{ text: 'Your request was sent and is waiting for a decision.', ok: true }} />}
    </Section>
  );
}

function MyRequests({ employeeId, onRaiseAgain }: { employeeId: string; onRaiseAgain: (r: AssetRequest) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const refetchAll = useRefetchAll();
  const requests = useQuery({
    queryKey: keys.employeeRequests(employeeId),
    queryFn: () => api<{ items: AssetRequest[] }>(`/v1/employees/${employeeId}/asset-requests`),
    retry: retryTransient,
  });
  const withdraw = useMutation({
    mutationFn: (id: string) => api<{ requestId: string; state: string }>(`/v1/me/asset-requests/${id}/withdraw`, { method: 'POST' }),
    onSettled: () => void refetchAll(),
  });
  const data = shown(requests);
  /** A request's action: withdraw one still waiting, or raise a rejected one again (DF03). */
  const action = (r: AssetRequest): ReactNode => {
    if (r.state === 'SUBMITTED' && can(REQUEST_SUBMIT)) {
      return (
        <Button type="button" variant="danger" size="sm" disabled={withdraw.isPending} aria-label={`Withdraw the request for ${r.category.label}`} onClick={() => withdraw.mutate(r.id)}>
          Withdraw
        </Button>
      );
    }
    if (canRaiseAgain(r, followedRequests(data?.items ?? [])) && can(REQUEST_SUBMIT)) {
      return (
        <Button type="button" variant="outline" size="sm" aria-label={`Raise again the rejected request for ${r.category.label}`} onClick={() => onRaiseAgain(r)}>
          Raise again
        </Button>
      );
    }
    return '—';
  };
  return (
    <Section title="My custody requests">
      {requests.isPending && <LoadingLine>Loading your requests…</LoadingLine>}
      <QueryProblem error={requests.error} forbidden="Your Employee role cannot read your custody requests." />
      <Refusal error={withdraw.error} action="withdraw" />
      {withdraw.isSuccess && <Notice notice={{ text: 'Your request was withdrawn.', ok: true }} />}
      {data && <RequestHistory requests={data.items} label="My custody requests" empty="You have not asked for any items." showEmployee={false} withdraw={action} />}
    </Section>
  );
}
