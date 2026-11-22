// The settlements of one exit: its revisions, and a new revision.
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ButtonRow, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActionsCell } from '@/components/row-actions';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, formatDate, isConflict, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Notice, NotPermitted, Section, StateBadge } from '../../ui';
import { CREATE_WORDS, Refusal } from './refusals';
import { NoticePeriod } from './settlements';
import { CalculationNote, CURRENCY, enc, EXIT_READ, isSelf, Item, LINK_ROW, LIVE_STATES, LoadProblem, Money, PATHS, SETTLEMENT_PREPARE, SETTLEMENT_READ, settlementLabel, SettlementState, useKeys, UserRef, useSettlementRefresh, UUID, when } from './shared';
import type { Calculation, ExitCase, SettlementDetail } from './types';

// =========================================================================================================
// The settlements of one exit: revisions, and a new revision
// =========================================================================================================
export function ExitSettlementsScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!UUID.test(id)) {
    return (
      <>
        <h1>Exit settlements</h1>
        <Empty>This address does not name an exit.</Empty>
      </>
    );
  }
  if (!can(SETTLEMENT_READ)) {
    return (
      <>
        <h1>Exit settlements</h1>
        <Section title="Settlement revisions">
          <NotPermitted>The selected role cannot view settlements.</NotPermitted>
        </Section>
      </>
    );
  }
  return <ExitSettlements key={id} exitId={id} />;
}

function ExitSettlements({ exitId }: { exitId: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const exit = useQuery({ enabled: can(EXIT_READ), queryKey: keys.exit(exitId), queryFn: () => api<ExitCase>(`/v1/exit-cases/${enc(exitId)}`), retry: retryTransient });
  const list = useQuery({
    queryKey: keys.exitSettlements(exitId),
    queryFn: () => api<{ calculation: Calculation; items: SettlementDetail[] }>(`/v1/exit-cases/${enc(exitId)}/settlements`),
    retry: retryTransient,
  });
  const x = exit.data;
  const first = list.data?.items[0];
  const who = x ? `${x.employeeName} (${x.employeeCode})` : first ? `${first.employeeName} (${first.employeeCode})` : null;
  const own = (!!me?.employeeId && (x?.employeeId === me.employeeId || first?.employeeId === me.employeeId)) || isSelf(list.error);
  const items = list.data?.items ?? [];
  const withAmounts = items.some((s) => typeof s.netAmount === 'string');
  return (
    <>
      <h1>{who ? `Settlements for ${who}` : 'Exit settlements'}</h1>
      <p className={LINK_ROW}>
        <Link to={PATHS.settlements}>All settlements</Link>
        {can(EXIT_READ) && <Link to={PATHS.exit(exitId)}>Open the exit case</Link>}
      </p>
      {x && (
        <Section title="Exit">
          <dl className="kv">
            <Item term="Employee">
              {x.employeeName} <Hint as="span">{x.employeeCode}</Hint>
            </Item>
            <Item term="Exit state">
              <StateBadge state={x.state} />
            </Item>
            <Item term="Approved last working date">{formatDate(x.approvedLastWorkingDate)}</Item>
            <Item term="Notice period">
              <NoticePeriod notice={x.noticePeriod} />
            </Item>
          </dl>
        </Section>
      )}
      <Section title="Settlement revisions">
        <CalculationNote calculation={list.data?.calculation} />
        {list.isPending && <LoadingLine>Loading the settlement revisions…</LoadingLine>}
        <LoadProblem error={list.error} forbidden="The selected role cannot view settlements." missing="This exit is not available in the selected role’s scope." />
        {list.data && items.length === 0 && <Empty>No settlement has been prepared for this exit yet.</Empty>}
        {items.length > 0 && (
          <Table aria-label="Settlement revisions">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Revision</TableHead>
                <TableHead scope="col">State</TableHead>
                <TableHead scope="col">Currency</TableHead>
                {withAmounts && <TableHead scope="col">Net amount</TableHead>}
                <TableHead scope="col">Prepared by</TableHead>
                <TableHead scope="col">Created</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Revision</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{s.revision}</TableCell>
                  <TableCell>
                    <SettlementState state={s.state} />
                  </TableCell>
                  <TableCell>{s.currencyCode}</TableCell>
                  {withAmounts && (
                    <TableCell>
                      <Money value={s.netAmount} currency={s.currencyCode} />
                    </TableCell>
                  )}
                  <TableCell>
                    <UserRef userId={s.preparedBy} />
                  </TableCell>
                  <TableCell>{when(s.createdAt)}</TableCell>
                  <RowActionsCell>
                    <Link to={PATHS.settlement(s.id)} aria-label={`Open revision ${s.revision}`}>
                      Open
                    </Link>
                  </RowActionsCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
      {can(SETTLEMENT_PREPARE) && list.data && !own && <PrepareRevision exitId={exitId} revisions={items} />}
    </>
  );
}

function PrepareRevision({ exitId, revisions }: { exitId: string; revisions: readonly SettlementDetail[] }) {
  const refresh = useSettlementRefresh();
  const [currency, setCurrency] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<SettlementDetail | null>(null);
  const live = revisions.find((r) => LIVE_STATES.has(r.state));
  const latest = revisions.length > 0 ? revisions[revisions.length - 1]! : null;
  const create = useMutation({
    mutationFn: (body: { currencyCode?: string }) => api<SettlementDetail>(`/v1/exit-cases/${enc(exitId)}/settlements`, { body }),
    onMutate: () => setCreated(null),
    onSuccess: (s) => {
      setCreated(s);
      setCurrency('');
      refresh(s);
    },
    // A live revision appeared meanwhile, or the answer was lost: the revisions load again to show where things stand.
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) refresh();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    const c = currency.trim().toUpperCase();
    const missing =
      c === '' && latest === null ? 'Enter the settlement currency, for example INR.' : c !== '' && !CURRENCY.test(c) ? 'Enter the currency as three capital letters, for example INR.' : null;
    setProblem(missing);
    if (missing !== null) {
      create.reset();
      return;
    }
    create.mutate(c ? { currencyCode: c } : {});
  };
  return (
    <Section title="Prepare a revision">
      {created && (
        <StatusNote tone="success" role="status">
          Revision {created.revision} created as a draft. <Link to={PATHS.settlement(created.id)}>Open revision {created.revision}</Link> to enter or upload its lines.
        </StatusNote>
      )}
      {live ? (
        <Hint>
          Revision {live.revision} is live ({settlementLabel(live.state).toLowerCase()}): a new revision can be prepared only once it is returned, rejected or cancelled.
        </Hint>
      ) : (
        <FormGrid aria-label="Prepare a revision" onSubmit={submit}>
          <Hint>
            You calculate the new draft from a snapshot on the server, or enter or upload its lines yourself; an independent reviewer and approver then decide it.
            {latest &&
              ` With the same currency as revision ${latest.revision}, its lines (active pay components only) are copied into the new draft as a starting point.`}
          </Hint>
          <FormField>
            {latest ? `Currency (leave blank to keep ${latest.currencyCode})` : 'Currency (ISO 4217 code, required)'}
            <Input value={currency} maxLength={3} placeholder={latest ? latest.currencyCode : 'INR'} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </FormField>
          {problem && <Notice notice={{ text: problem, ok: false }} />}
          <ButtonRow className="col-span-full">
            <Button type="submit" disabled={create.isPending}>
              Prepare a new revision
            </Button>
          </ButtonRow>
        </FormGrid>
      )}
      {/* Outside the form: a refusal stays readable when the reloaded revisions replace the form (a live revision). */}
      <Refusal
        error={create.error}
        words={CREATE_WORDS}
        noAnswer="No answer came back, so the revision may or may not have been created. The revisions have been reloaded: check them before trying again."
      />
    </Section>
  );
}

