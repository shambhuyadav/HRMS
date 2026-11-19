// The settlements of one exit: its revisions, and a new revision.
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, formatDate, isConflict, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, NotPermitted, Section, StateBadge } from '../../ui';
import { CREATE_WORDS, Refusal } from './refusals';
import { NoticePeriod } from './settlements';
import { CalculationNote, CURRENCY, enc, EXIT_READ, isSelf, Item, LIVE_STATES, LoadProblem, Money, PATHS, SCROLL, SETTLEMENT_PREPARE, SETTLEMENT_READ, settlementLabel, SettlementState, SR_ONLY, useKeys, UserRef, useSettlementRefresh, UUID, when } from './shared';
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
      <p className="row">
        <Link to={PATHS.settlements}>All settlements</Link>
        {can(EXIT_READ) && <Link to={PATHS.exit(exitId)}>Open the exit case</Link>}
      </p>
      {x && (
        <Section title="Exit">
          <dl className="kv">
            <Item term="Employee">
              {x.employeeName} <span className="hint">{x.employeeCode}</span>
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
        {list.isPending && <p className="hint loading">Loading the settlement revisions…</p>}
        <LoadProblem error={list.error} forbidden="The selected role cannot view settlements." missing="This exit is not available in the selected role’s scope." />
        {list.data && items.length === 0 && <Empty>No settlement has been prepared for this exit yet.</Empty>}
        {items.length > 0 && (
          <div style={SCROLL}>
            <table aria-label="Settlement revisions">
              <thead>
                <tr>
                  <th scope="col">Revision</th>
                  <th scope="col">State</th>
                  <th scope="col">Currency</th>
                  {withAmounts && <th scope="col">Net amount</th>}
                  <th scope="col">Prepared by</th>
                  <th scope="col">Created</th>
                  <th scope="col">
                    <span style={SR_ONLY}>Revision</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id}>
                    <td>{s.revision}</td>
                    <td>
                      <SettlementState state={s.state} />
                    </td>
                    <td>{s.currencyCode}</td>
                    {withAmounts && (
                      <td>
                        <Money value={s.netAmount} currency={s.currencyCode} />
                      </td>
                    )}
                    <td>
                      <UserRef userId={s.preparedBy} />
                    </td>
                    <td>{when(s.createdAt)}</td>
                    <td>
                      <Link to={PATHS.settlement(s.id)} aria-label={`Open revision ${s.revision}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
        <p className="ok" role="status">
          Revision {created.revision} created as a draft. <Link to={PATHS.settlement(created.id)}>Open revision {created.revision}</Link> to enter or upload its lines.
        </p>
      )}
      {live ? (
        <p className="hint">
          Revision {live.revision} is live ({settlementLabel(live.state).toLowerCase()}): a new revision can be prepared only once it is returned, rejected or cancelled.
        </p>
      ) : (
        <form className="grid-form" aria-label="Prepare a revision" onSubmit={submit}>
          <p className="hint wide">
            You calculate the new draft from a snapshot on the server, or enter or upload its lines yourself; an independent reviewer and approver then decide it.
            {latest &&
              ` With the same currency as revision ${latest.revision}, its lines (active pay components only) are copied into the new draft as a starting point.`}
          </p>
          <label>
            {latest ? `Currency (leave blank to keep ${latest.currencyCode})` : 'Currency (ISO 4217 code, required)'}
            <input value={currency} maxLength={3} placeholder={latest ? latest.currencyCode : 'INR'} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </label>
          {problem && (
            <p role="alert" className="error wide">
              {problem}
            </p>
          )}
          <div className="wide row">
            <button type="submit" disabled={create.isPending}>
              Prepare a new revision
            </button>
          </div>
        </form>
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

