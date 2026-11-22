// My ESS tax panels (H3 TN08, TN09; FR-108): the employee's own declaration and investment proofs, in the Employee OWN context.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ButtonRow, CheckField, FormField, LabelledFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatAmount, formatDate, idempotencyKey } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section, StateBadge } from '../../ui';
import {
  CARD_LIST,
  type Declaration,
  FIELD_WIDTH,
  FORM_STACK,
  ItemCard,
  notPermitted,
  type OpenPeriod,
  OWN_READ,
  OWN_SUBMIT,
  type OwnDeclarations,
  type OwnProofs,
  type Proof,
} from './shared';

// =========================================================================================================
// TN08 own declaration
// =========================================================================================================

function DeclarationForm({ period, onDone }: { period: OpenPeriod; onDone: () => void }) {
  const [regimeCode, setRegimeCode] = useState(period.regimes[0]?.code ?? '');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const regime = period.regimes.find((r) => r.code === regimeCode);
  const save = useMutation({
    mutationFn: () =>
      api<Declaration>('/v1/me/tax-declarations', {
        body: {
          fiscalPeriodCode: period.fiscalPeriodCode,
          regimeCode,
          lines: (regime?.categories ?? []).filter((c) => amounts[c.code]?.trim()).map((c) => ({ categoryCode: c.code, amount: amounts[c.code]!.trim() })),
        },
      }),
    onSuccess: () => onDone(),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!save.isPending) save.mutate();
  };
  return (
    <form onSubmit={submit} className={FORM_STACK} aria-label={`Declare for ${period.fiscalPeriodCode}`} noValidate>
      <Hint>{`${period.fiscalPeriodCode}: ${formatDate(period.periodStart)} to ${formatDate(period.periodEnd)}. Accepted until ${formatDate(period.cutoffDate)}. Amounts in ${period.currencyCode}.`}</Hint>
      <FormField className={FIELD_WIDTH}>
        Regime
        <NativeSelect value={regimeCode} onChange={(e) => setRegimeCode(e.target.value)}>
          {period.regimes.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      {regime?.categories.length === 0 && <Hint>This regime lists no categories to declare.</Hint>}
      {regime?.categories.map((c) => (
        <FormField key={c.code} className={FIELD_WIDTH}>
          {c.name}
          <Input inputMode="decimal" value={amounts[c.code] ?? ''} onChange={(e) => setAmounts({ ...amounts, [c.code]: e.target.value })} />
        </FormField>
      ))}
      <ErrorNote error={save.error} />
      <ButtonRow>
        <Button type="submit" disabled={save.isPending || !regimeCode}>
          Save draft
        </Button>
      </ButtonRow>
    </form>
  );
}

function OwnDeclarationItem({ d, canSubmit, onChanged }: { d: Declaration; canSubmit: boolean; onChanged: () => void }) {
  const send = useMutation({
    mutationFn: () => api<Declaration>(`/v1/me/tax-declarations/${encodeURIComponent(d.id)}/submit`, { body: { expectedVersion: d.version } }),
    onSuccess: () => onChanged(),
  });
  return (
    <ItemCard aria-label={`Declaration for ${d.fiscalPeriodCode}`}>
      <strong>{d.fiscalPeriodCode}</strong> <StateBadge state={d.state} />
      <Hint>Regime: {d.regimeCode}</Hint>
      {d.lines.length === 0 ? (
        <Hint>No categories declared.</Hint>
      ) : (
        <ul>
          {d.lines.map((l) => (
            <li key={l.categoryCode}>{`${l.categoryCode}: ${formatAmount(l.amount, d.currencyCode)}`}</li>
          ))}
        </ul>
      )}
      {d.employeeExplanation && <p>Reviewer&apos;s explanation: {d.employeeExplanation}</p>}
      {d.state === 'RETURNED' && <Hint>Start a new declaration for this period to correct it.</Hint>}
      <ErrorNote error={send.error} />
      {canSubmit && d.state === 'DRAFT' && (
        <Button type="button" onClick={() => send.mutate()} disabled={send.isPending}>
          Submit for review
        </Button>
      )}
    </ItemCard>
  );
}

export function MyTaxDeclarationPanel() {
  const { can } = useSession();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['tax-own-declarations'], queryFn: () => api<OwnDeclarations>('/v1/me/tax-declarations'), enabled: can(OWN_READ) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['tax-own-declarations'] });
  if (!can(OWN_READ)) return notPermitted('Your own tax declaration is shown in your Employee role. Switch to it to see it.');
  const data = list.data;
  const live = (fiscalPeriodCode: string) => data?.items.some((d) => d.fiscalPeriodCode === fiscalPeriodCode && !['RETURNED', 'REJECTED'].includes(d.state));
  return (
    <Section title="My tax declaration">
      {list.isPending && <LoadingLine>Loading your declarations…</LoadingLine>}
      <ErrorNote error={list.error} />
      {data?.configuration.status === 'NOT_CONFIGURED' && (
        <StatusNote tone="info" role="status">
          {data.configuration.message}
        </StatusNote>
      )}
      {data && <Hint>{data.calculation.message}</Hint>}
      {data && data.items.length === 0 && data.configuration.status === 'ACTIVE' && <Empty>You have no declarations yet.</Empty>}
      {data && data.items.length > 0 && (
        <ul className={CARD_LIST}>
          {data.items.map((d) => (
            <OwnDeclarationItem key={d.id} d={d} canSubmit={can(OWN_SUBMIT)} onChanged={refresh} />
          ))}
        </ul>
      )}
      {can(OWN_SUBMIT) &&
        data?.openPeriods
          .filter((p) => !p.cutoffPassed && !live(p.fiscalPeriodCode))
          .map((p) => <DeclarationForm key={p.rulePackId} period={p} onDone={refresh} />)}
      {data?.openPeriods
        .filter((p) => p.cutoffPassed && !live(p.fiscalPeriodCode))
        .map((p) => (
          <Hint key={p.rulePackId}>{`The cutoff for ${p.fiscalPeriodCode} passed on ${formatDate(p.cutoffDate)}.`}</Hint>
        ))}
    </Section>
  );
}

// =========================================================================================================
// TN09 own investment proofs
// =========================================================================================================

function ProofForm({ declarations, onDone, employeeId }: { declarations: Declaration[]; onDone: () => void; employeeId: string }) {
  const [declarationId, setDeclarationId] = useState(declarations[0]?.id ?? '');
  const [categoryCode, setCategoryCode] = useState('');
  const [claimedAmount, setClaimedAmount] = useState('');
  const [evidence, setEvidence] = useState<string[]>([]);
  const [key] = useState(() => idempotencyKey('tax-proof'));
  const documents = useQuery({
    queryKey: ['tax-own-documents', employeeId],
    queryFn: () => api<{ items: { id: string; fileName: string | null; documentType: string }[] }>(`/v1/employees/${encodeURIComponent(employeeId)}/documents`),
  });
  const declaration = declarations.find((d) => d.id === declarationId);
  const send = useMutation({
    mutationFn: () => api<Proof>('/v1/me/tax-proofs', { body: { declarationId, categoryCode, claimedAmount: claimedAmount.trim(), evidenceDocumentIds: evidence, idempotencyKey: key } }),
    onSuccess: () => onDone(),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!send.isPending) send.mutate();
  };
  return (
    <form onSubmit={submit} className={FORM_STACK} aria-label="Submit an investment proof" noValidate>
      <FormField className={FIELD_WIDTH}>
        Declaration
        <NativeSelect value={declarationId} onChange={(e) => setDeclarationId(e.target.value)}>
          {declarations.map((d) => (
            <option key={d.id} value={d.id}>
              {d.fiscalPeriodCode}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      <FormField className={FIELD_WIDTH}>
        Category
        <NativeSelect value={categoryCode} onChange={(e) => setCategoryCode(e.target.value)}>
          <option value="">Choose…</option>
          {declaration?.lines.map((l) => (
            <option key={l.categoryCode} value={l.categoryCode}>
              {l.categoryCode}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      <FormField className={FIELD_WIDTH}>
        Amount claimed
        <Input inputMode="decimal" value={claimedAmount} onChange={(e) => setClaimedAmount(e.target.value)} />
      </FormField>
      <LabelledFieldset legend="Evidence (your uploaded documents)">
        {documents.data?.items.length === 0 && <Hint>Upload the document under Document upload first.</Hint>}
        {documents.data?.items.map((d) => (
          <CheckField key={d.id}>
            <input type="checkbox" checked={evidence.includes(d.id)} onChange={(e) => setEvidence(e.target.checked ? [...evidence, d.id] : evidence.filter((x) => x !== d.id))} />
            {d.fileName ?? d.documentType}
          </CheckField>
        ))}
      </LabelledFieldset>
      <ErrorNote error={send.error} />
      <ButtonRow>
        <Button type="submit" disabled={send.isPending || !categoryCode || !claimedAmount.trim() || evidence.length === 0}>
          Submit proof
        </Button>
      </ButtonRow>
    </form>
  );
}

export function MyInvestmentProofsPanel() {
  const { can, me } = useSession();
  const qc = useQueryClient();
  const proofs = useQuery({ queryKey: ['tax-own-proofs'], queryFn: () => api<OwnProofs>('/v1/me/tax-proofs'), enabled: can(OWN_READ) });
  const declarations = useQuery({ queryKey: ['tax-own-declarations'], queryFn: () => api<OwnDeclarations>('/v1/me/tax-declarations'), enabled: can(OWN_READ) });
  if (!can(OWN_READ)) return notPermitted('Your own investment proofs are shown in your Employee role. Switch to it to see them.');
  const open = declarations.data?.items.filter((d) => (d.state === 'SUBMITTED' || d.state === 'ACCEPTED') && d.lines.length > 0) ?? [];
  const data = proofs.data;
  return (
    <Section title="My investment proofs">
      {proofs.isPending && <LoadingLine>Loading your proofs…</LoadingLine>}
      <ErrorNote error={proofs.error} />
      {data?.configuration.status === 'NOT_CONFIGURED' && (
        <StatusNote tone="info" role="status">
          {data.configuration.message}
        </StatusNote>
      )}
      {data && <Hint>An accepted amount gives no tax relief by itself; no tax is calculated here.</Hint>}
      {data && data.items.length === 0 && data.configuration.status === 'ACTIVE' && <Empty>You have submitted no proofs.</Empty>}
      {data && data.items.length > 0 && (
        <Table aria-label="My investment proofs">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Period</TableHead>
              <TableHead scope="col">Category</TableHead>
              <TableHead scope="col">Claimed</TableHead>
              <TableHead scope="col">Accepted</TableHead>
              <TableHead scope="col">Rejected</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Reviewer&apos;s explanation</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((p) => (
              <TableRow key={p.id}>
                <TableCell>{p.fiscalPeriodCode}</TableCell>
                <TableCell>{p.categoryName ?? p.categoryCode}</TableCell>
                <TableCell>{formatAmount(p.claimedAmount, p.currencyCode)}</TableCell>
                <TableCell>{formatAmount(p.acceptedAmount, p.currencyCode)}</TableCell>
                <TableCell>{formatAmount(p.rejectedAmount, p.currencyCode)}</TableCell>
                <TableCell>
                  <StateBadge state={p.state} />
                </TableCell>
                <TableCell>{p.employeeExplanation ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {can(OWN_SUBMIT) && open.length > 0 && me?.employeeId && <ProofForm declarations={open} employeeId={me.employeeId} onDone={() => void qc.invalidateQueries({ queryKey: ['tax-own-proofs'] })} />}
    </Section>
  );
}
