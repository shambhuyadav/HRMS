// Payroll configuration: pay components and their head revisions (FR-028; DF05).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, CheckField, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Section } from '../../ui';
import { ActivateControl, CALCULATION_BASIS, Choice, COMPONENT_KIND, CONFIG_ACTIVATE, CONFIG_MANAGE, CONFIG_STATE, HEAD_USE, type HeadRevision, ISO_DAY, NOT_CONFIG, type PayComponent, ROUNDING, RULE_PACK_BLOCKS, TAX_TREATMENTS, usePayComponents } from './config';
import { Missing, Note } from './pickers';
import { Problem } from './problems';
import { CONFIG_READ, HEAD_TYPE, label, Status, useKeys } from './shared';

// ---- Pay components and head revisions (FR-028; DF05) ----

export function HeadsScreen() {
  const { can } = useSession();
  if (!can(CONFIG_READ)) {
    return (
      <Section title="Pay heads">
        <Empty refusal>{NOT_CONFIG}</Empty>
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
      <Hint>A pay component is the identity of a head; head revisions classify it for payroll from a date.</Hint>
      {components.isPending && <LoadingLine>Loading pay components…</LoadingLine>}
      {components.error && <Problem error={components.error} act="read" />}
      {components.data && components.data.items.length === 0 && <Empty>No pay component is defined.</Empty>}
      {components.data && components.data.items.length > 0 && (
        <Table aria-label="Pay components">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Code</TableHead>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Kind</TableHead>
              <TableHead scope="col">Head in effect today</TableHead>
              <TableHead scope="col">Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {components.data.items.map((c) => (
              <TableRow key={c.id}>
                <TableCell>{c.code}</TableCell>
                <TableCell>{c.name}</TableCell>
                <TableCell>{label(COMPONENT_KIND, c.componentKind)}</TableCell>
                <TableCell>{headInEffectText(c)}</TableCell>
                <TableCell>{c.active ? 'Active' : 'Not active'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {can(CONFIG_MANAGE) && (
        <FormGrid onSubmit={submit} aria-label="Create a pay component">
          <CardSubheading>Create a pay component</CardSubheading>
          <FormField>
            Component code
            <Input value={f.code} onChange={(e) => set({ code: e.target.value })} maxLength={40} autoComplete="off" />
          </FormField>
          <FormField>
            Component name
            <Input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} autoComplete="off" />
          </FormField>
          <Choice label="Component kind" value={f.componentKind} onChange={(v) => set({ componentKind: v })} options={COMPONENT_KIND} />
          <ButtonRow>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Saving…' : 'Create the component'}
            </Button>
          </ButtonRow>
          <Missing text={problem} />
          <div className="col-span-full">
            <Note text={note} />
            <Problem error={create.error} act="pay-component" />
          </div>
        </FormGrid>
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
      <Hint>
        A head revision is created whole and never edited. It takes effect only once someone other than its author activates it, and activation refuses missing or cyclic
        definitions. The latest active revision on or before a date is the one in effect.
      </Hint>
      {heads.isPending && <LoadingLine>Loading head revisions…</LoadingLine>}
      {heads.error && <Problem error={heads.error} act="read" />}
      <Note text={note} />
      {heads.data && heads.data.items.length === 0 && <Empty>No head revision is defined, so no pay component is classified for payroll.</Empty>}
      {heads.data && heads.data.items.length > 0 && (
        <Table aria-label="Head revisions">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Component</TableHead>
              <TableHead scope="col">Revision</TableHead>
              <TableHead scope="col">Effective from</TableHead>
              <TableHead scope="col">Use</TableHead>
              <TableHead scope="col">Type</TableHead>
              <TableHead scope="col">Calculation</TableHead>
              <TableHead scope="col">Rounding</TableHead>
              <TableHead scope="col">Tax treatment</TableHead>
              <TableHead scope="col">Display order</TableHead>
              <TableHead scope="col">State</TableHead>
              {(activator || manager) && <TableHead scope="col">Change</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {heads.data.items.map((h) => {
              const rulePack = h.inUse && h.calculationBasis === 'RULE_PACK';
              return (
                <TableRow key={h.id}>
                  <TableCell>{`${h.componentCode} · ${h.componentName}`}</TableCell>
                  <TableCell>{h.revision}</TableCell>
                  <TableCell>{formatDate(h.effectiveFrom)}</TableCell>
                  <TableCell>{h.inUse ? 'In use' : 'Discontinued'}</TableCell>
                  <TableCell>{label(HEAD_TYPE, h.headType)}</TableCell>
                  <TableCell>
                    {rulePack ? `Rule pack ${h.rulePackCode ?? ''}` : label(CALCULATION_BASIS, h.calculationBasis)}
                    {rulePack && h.baseComponentCodes.length > 0 && <div>{`Base heads: ${h.baseComponentCodes.join(', ')}`}</div>}
                    {rulePack && (
                      <div>
                        <strong>{RULE_PACK_BLOCKS}</strong>
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{label(ROUNDING, h.roundingRule)}</TableCell>
                  <TableCell>{h.taxTreatment ?? '—'}</TableCell>
                  <TableCell>{h.displaySequence ?? '—'}</TableCell>
                  <TableCell>
                    <Status map={CONFIG_STATE} code={h.state} />
                  </TableCell>
                  {(activator || manager) && (
                    <RowActionsCell>
                      <RowActions>
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
                            <Button
                              type="button"
                              variant="danger"
                              size="sm"
                              disabled={act.isPending}
                              onClick={() => {
                                setNote(null);
                                act.mutate({ h, action: 'cancel' });
                              }}
                              aria-label={`Cancel head ${h.componentCode} revision ${h.revision}`}
                            >
                              Cancel draft
                            </Button>
                          </>
                        )}
                      </RowActions>
                    </RowActionsCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
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
    <FormGrid onSubmit={submit} aria-label="Create a head revision">
      <CardSubheading>Create a head revision</CardSubheading>
      <FormField>
        Pay component
        <NativeSelect value={f.componentCode} onChange={(e) => set({ componentCode: e.target.value })}>
          <option value="">Choose…</option>
          {(components.data?.items ?? []).map((c) => (
            <option key={c.id} value={c.code}>
              {`${c.code} · ${c.name} (${label(COMPONENT_KIND, c.componentKind).toLowerCase()})`}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      <FormField>
        Effective from
        <Input type="date" value={f.effectiveFrom} onChange={(e) => set({ effectiveFrom: e.target.value })} />
      </FormField>
      <Choice label="Use" value={f.use} onChange={(v) => set({ use: v })} options={HEAD_USE} />
      {inUse && (
        <>
          <Choice label="Head type" value={f.headType} onChange={(v) => set({ headType: v })} options={HEAD_TYPE} />
          <Choice label="Calculation basis" value={f.calculationBasis} onChange={(v) => set({ calculationBasis: v })} options={CALCULATION_BASIS} />
          <Choice label="Rounding" value={f.roundingRule} onChange={(v) => set({ roundingRule: v })} options={ROUNDING} />
          <FormField>
            Tax treatment (from the company’s list)
            <Input value={f.taxTreatment} onChange={(e) => set({ taxTreatment: e.target.value })} list={taxList} maxLength={60} autoComplete="off" />
            <datalist id={taxList}>
              {TAX_TREATMENTS.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </FormField>
          <FormField>
            Display sequence
            <Input value={f.displaySequence} onChange={(e) => set({ displaySequence: e.target.value })} inputMode="numeric" maxLength={4} autoComplete="off" />
          </FormField>
        </>
      )}
      {rulePack && (
        <>
          <Hint role="note">
            <strong>{RULE_PACK_BLOCKS}</strong>
          </Hint>
          <FormField>
            Rule pack code
            <Input value={f.rulePackCode} onChange={(e) => set({ rulePackCode: e.target.value })} maxLength={40} autoComplete="off" />
          </FormField>
          <FieldSet className="gap-[0.55rem]">
            <legend>Base heads</legend>
            {others.length === 0 && <Hint>No other pay component exists.</Hint>}
            {others.map((c) => (
              <CheckField key={c.id}>
                <input
                  type="checkbox"
                  checked={f.bases.includes(c.code)}
                  onChange={(e) => set({ bases: e.target.checked ? [...f.bases, c.code] : f.bases.filter((b) => b !== c.code) })}
                />{' '}
                {`${c.code} · ${c.name}`}
              </CheckField>
            ))}
          </FieldSet>
        </>
      )}
      <ButtonRow>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Saving…' : 'Save the revision as a draft'}
        </Button>
      </ButtonRow>
      <Missing text={problem} />
      <div className="col-span-full">
        <Note text={note} />
        <Problem error={create.error} act="head" />
      </div>
    </FormGrid>
  );
}
