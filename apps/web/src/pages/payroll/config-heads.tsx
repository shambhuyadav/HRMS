// Payroll configuration: pay components and their head revisions (FR-028; DF05).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { api, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Section } from '../../ui';
import { ActivateControl, CALCULATION_BASIS, Choice, COMPONENT_KIND, CONFIG_ACTIVATE, CONFIG_MANAGE, CONFIG_STATE, HEAD_USE, type HeadRevision, ISO_DAY, NOT_CONFIG, type PayComponent, ROUNDING, RULE_PACK_BLOCKS, TAX_TREATMENTS, usePayComponents } from './config';
import { Missing, Note } from './pickers';
import { Problem } from './problems';
import { CONFIG_READ, GROUP, H3, HEAD_TYPE, label, SCROLL, Status, useKeys } from './shared';

// ---- Pay components and head revisions (FR-028; DF05) ----

export function HeadsScreen() {
  const { can } = useSession();
  if (!can(CONFIG_READ)) {
    return (
      <Section title="Pay heads">
        <Empty>{NOT_CONFIG}</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      <PayComponentsSection />
      <HeadRevisionsSection />
    </div>
  );
}

function headInEffectText(c: PayComponent): string {
  const h = c.headInEffect;
  if (!h) return 'No head in effect';
  const what = h.inUse ? `${label(HEAD_TYPE, h.headType)}, ${label(CALCULATION_BASIS, h.calculationBasis).toLowerCase()}` : 'discontinued';
  return `Revision ${h.revision} from ${formatDate(h.effectiveFrom)}: ${what}`;
}

function PayComponentsSection() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const components = usePayComponents();
  const empty = { code: '', name: '', componentKind: '' };
  const [f, setF] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<PayComponent>('/v1/payroll/components', { body }),
    onSuccess: (c) => {
      setF(empty);
      setNote(`Pay component ${c.code} created: classify it for payroll with a head revision.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.payComponents }),
  });
  const set = (patch: Partial<typeof empty>) => setF((prev) => ({ ...prev, ...patch }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    if (!f.code.trim() || !f.name.trim()) return setProblem('Give the component code and name.');
    if (!f.componentKind) return setProblem('Choose whether the component is an earning or a deduction.');
    setProblem(null);
    setNote(null);
    create.reset();
    create.mutate({ code: f.code.trim().toUpperCase(), name: f.name.trim(), componentKind: f.componentKind });
  };
  return (
    <Section title="Pay components">
      <p className="hint">A pay component is the identity of a head; head revisions classify it for payroll from a date.</p>
      {components.isPending && <p className="hint loading">Loading pay components…</p>}
      {components.error && <Problem error={components.error} act="read" />}
      {components.data && components.data.items.length === 0 && <Empty>No pay component is defined.</Empty>}
      {components.data && components.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Pay components">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Kind</th>
                <th>Head in effect today</th>
                <th>Active</th>
              </tr>
            </thead>
            <tbody>
              {components.data.items.map((c) => (
                <tr key={c.id}>
                  <td>{c.code}</td>
                  <td>{c.name}</td>
                  <td>{label(COMPONENT_KIND, c.componentKind)}</td>
                  <td>{headInEffectText(c)}</td>
                  <td>{c.active ? 'Active' : 'Not active'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can(CONFIG_MANAGE) && (
        <form onSubmit={submit} aria-label="Create a pay component" className="grid-form" style={{ marginTop: '0.75rem' }}>
          <h3 style={H3} className="wide">
            Create a pay component
          </h3>
          <label>
            Component code
            <input value={f.code} onChange={(e) => set({ code: e.target.value })} maxLength={40} autoComplete="off" />
          </label>
          <label>
            Component name
            <input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} autoComplete="off" />
          </label>
          <Choice label="Component kind" value={f.componentKind} onChange={(v) => set({ componentKind: v })} options={COMPONENT_KIND} />
          <div className="row">
            <button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Saving…' : 'Create the component'}
            </button>
          </div>
          <Missing text={problem} />
          <div className="wide">
            <Note text={note} />
            <Problem error={create.error} act="pay-component" />
          </div>
        </form>
      )}
    </Section>
  );
}

function HeadRevisionsSection() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const heads = useQuery({ queryKey: keys.heads, queryFn: () => api<{ items: HeadRevision[] }>('/v1/payroll/heads'), retry: retryTransient });
  const [note, setNote] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: ({ h, action }: { h: HeadRevision; action: 'activate' | 'cancel' }) =>
      api<HeadRevision>(`/v1/payroll/head-revisions/${encodeURIComponent(h.id)}/${action}`, { body: { expectedVersion: h.version } }),
    onSuccess: (h, { action }) =>
      setNote(
        action === 'activate'
          ? `Head ${h.componentCode} revision ${h.revision} is active from ${formatDate(h.effectiveFrom)}.`
          : `Draft revision ${h.revision} of head ${h.componentCode} was cancelled.`,
      ),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.heads });
      void qc.invalidateQueries({ queryKey: keys.payComponents });
    },
  });
  const activator = can(CONFIG_ACTIVATE);
  const manager = can(CONFIG_MANAGE);
  const lastAct = act.variables?.action;
  return (
    <Section title="Head revisions">
      <p className="hint">
        A head revision is created whole and never edited. It takes effect only once someone other than its author activates it, and activation refuses missing or cyclic
        definitions. The latest active revision on or before a date is the one in effect.
      </p>
      {heads.isPending && <p className="hint loading">Loading head revisions…</p>}
      {heads.error && <Problem error={heads.error} act="read" />}
      <Note text={note} />
      {heads.data && heads.data.items.length === 0 && <Empty>No head revision is defined, so no pay component is classified for payroll.</Empty>}
      {heads.data && heads.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Head revisions">
            <thead>
              <tr>
                <th>Component</th>
                <th>Revision</th>
                <th>Effective from</th>
                <th>Use</th>
                <th>Type</th>
                <th>Calculation</th>
                <th>Rounding</th>
                <th>Tax treatment</th>
                <th>Display order</th>
                <th>State</th>
                {(activator || manager) && <th>Change</th>}
              </tr>
            </thead>
            <tbody>
              {heads.data.items.map((h) => {
                const rulePack = h.inUse && h.calculationBasis === 'RULE_PACK';
                return (
                  <tr key={h.id}>
                    <td>{`${h.componentCode} · ${h.componentName}`}</td>
                    <td>{h.revision}</td>
                    <td>{formatDate(h.effectiveFrom)}</td>
                    <td>{h.inUse ? 'In use' : 'Discontinued'}</td>
                    <td>{label(HEAD_TYPE, h.headType)}</td>
                    <td>
                      {rulePack ? `Rule pack ${h.rulePackCode ?? ''}` : label(CALCULATION_BASIS, h.calculationBasis)}
                      {rulePack && h.baseComponentCodes.length > 0 && <div>{`Base heads: ${h.baseComponentCodes.join(', ')}`}</div>}
                      {rulePack && (
                        <div>
                          <strong>{RULE_PACK_BLOCKS}</strong>
                        </div>
                      )}
                    </td>
                    <td>{label(ROUNDING, h.roundingRule)}</td>
                    <td>{h.taxTreatment ?? '—'}</td>
                    <td>{h.displaySequence ?? '—'}</td>
                    <td>
                      <Status map={CONFIG_STATE} code={h.state} />
                    </td>
                    {(activator || manager) && (
                      <td>
                        {activator && (
                          <ActivateControl
                            state={h.state}
                            createdBy={h.createdBy}
                            name={`head ${h.componentCode} revision ${h.revision}`}
                            busy={act.isPending}
                            onActivate={() => {
                              setNote(null);
                              act.mutate({ h, action: 'activate' });
                            }}
                          />
                        )}
                        {manager && h.state === 'DRAFT' && (
                          <>
                            {' '}
                            <button
                              type="button"
                              className="link"
                              disabled={act.isPending}
                              onClick={() => {
                                setNote(null);
                                act.mutate({ h, action: 'cancel' });
                              }}
                              aria-label={`Cancel head ${h.componentCode} revision ${h.revision}`}
                            >
                              Cancel draft
                            </button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Problem error={act.error} act={lastAct === 'activate' ? 'head-activate' : 'head'} />
      {manager && <HeadForm />}
    </Section>
  );
}

function HeadForm() {
  const keys = useKeys();
  const qc = useQueryClient();
  const components = usePayComponents();
  const taxList = useId();
  const empty = { componentCode: '', effectiveFrom: '', use: '', headType: '', calculationBasis: '', roundingRule: '', taxTreatment: '', displaySequence: '', rulePackCode: '', bases: [] as string[] };
  const [f, setF] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<HeadRevision>('/v1/payroll/heads', { body }),
    onSuccess: (h) => {
      setF(empty);
      setNote(`Head ${h.componentCode} revision ${h.revision} saved as a draft: someone other than you activates it.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.heads }),
  });
  const set = (patch: Partial<typeof empty>) => setF((prev) => ({ ...prev, ...patch }));
  const inUse = f.use === 'IN_USE';
  const rulePack = inUse && f.calculationBasis === 'RULE_PACK';
  const others = (components.data?.items ?? []).filter((c) => c.code !== f.componentCode);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    if (!f.componentCode) return setProblem('Choose the pay component.');
    if (!ISO_DAY.test(f.effectiveFrom)) return setProblem('Give the date the revision takes effect.');
    if (!f.use) return setProblem('Choose whether the head is in use or discontinued from that date.');
    if (inUse) {
      if (!f.headType || !f.calculationBasis || !f.roundingRule || !f.taxTreatment.trim()) return setProblem('Choose the head type, calculation basis, rounding and tax treatment.');
      if (!/^\d{1,4}$/.test(f.displaySequence.trim()) || /^0+$/.test(f.displaySequence.trim())) return setProblem('The display sequence is a whole number from 1 to 9999.');
      if (rulePack && !f.rulePackCode.trim()) return setProblem('Name the rule pack that will calculate the head.');
    }
    setProblem(null);
    setNote(null);
    create.reset();
    create.mutate({
      componentCode: f.componentCode,
      effectiveFrom: f.effectiveFrom,
      inUse,
      ...(inUse
        ? {
            headType: f.headType,
            calculationBasis: f.calculationBasis,
            roundingRule: f.roundingRule,
            taxTreatment: f.taxTreatment.trim().toUpperCase(),
            displaySequence: Number(f.displaySequence.trim()),
            ...(rulePack ? { rulePackCode: f.rulePackCode.trim().toUpperCase(), baseComponentCodes: f.bases.filter((b) => b !== f.componentCode) } : {}),
          }
        : {}),
    });
  };
  return (
    <form onSubmit={submit} aria-label="Create a head revision" className="grid-form" style={{ marginTop: '0.75rem' }}>
      <h3 style={H3} className="wide">
        Create a head revision
      </h3>
      <label>
        Pay component
        <select value={f.componentCode} onChange={(e) => set({ componentCode: e.target.value })}>
          <option value="">Choose…</option>
          {(components.data?.items ?? []).map((c) => (
            <option key={c.id} value={c.code}>
              {`${c.code} · ${c.name} (${label(COMPONENT_KIND, c.componentKind).toLowerCase()})`}
            </option>
          ))}
        </select>
      </label>
      <label>
        Effective from
        <input type="date" value={f.effectiveFrom} onChange={(e) => set({ effectiveFrom: e.target.value })} />
      </label>
      <Choice label="Use" value={f.use} onChange={(v) => set({ use: v })} options={HEAD_USE} />
      {inUse && (
        <>
          <Choice label="Head type" value={f.headType} onChange={(v) => set({ headType: v })} options={HEAD_TYPE} />
          <Choice label="Calculation basis" value={f.calculationBasis} onChange={(v) => set({ calculationBasis: v })} options={CALCULATION_BASIS} />
          <Choice label="Rounding" value={f.roundingRule} onChange={(v) => set({ roundingRule: v })} options={ROUNDING} />
          <label>
            Tax treatment (from the company’s list)
            <input value={f.taxTreatment} onChange={(e) => set({ taxTreatment: e.target.value })} list={taxList} maxLength={60} autoComplete="off" />
            <datalist id={taxList}>
              {TAX_TREATMENTS.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label>
            Display sequence
            <input value={f.displaySequence} onChange={(e) => set({ displaySequence: e.target.value })} inputMode="numeric" maxLength={4} autoComplete="off" />
          </label>
        </>
      )}
      {rulePack && (
        <>
          <p className="hint wide" role="note">
            <strong>{RULE_PACK_BLOCKS}</strong>
          </p>
          <label>
            Rule pack code
            <input value={f.rulePackCode} onChange={(e) => set({ rulePackCode: e.target.value })} maxLength={40} autoComplete="off" />
          </label>
          <fieldset className="wide" style={GROUP}>
            <legend>Base heads</legend>
            {others.length === 0 && <p className="hint">No other pay component exists.</p>}
            {others.map((c) => (
              <label key={c.id} className="check">
                <input
                  type="checkbox"
                  checked={f.bases.includes(c.code)}
                  onChange={(e) => set({ bases: e.target.checked ? [...f.bases, c.code] : f.bases.filter((b) => b !== c.code) })}
                />{' '}
                {`${c.code} · ${c.name}`}
              </label>
            ))}
          </fieldset>
        </>
      )}
      <div className="row">
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Saving…' : 'Save the revision as a draft'}
        </button>
      </div>
      <Missing text={problem} />
      <div className="wide">
        <Note text={note} />
        <Problem error={create.error} act="head" />
      </div>
    </form>
  );
}
