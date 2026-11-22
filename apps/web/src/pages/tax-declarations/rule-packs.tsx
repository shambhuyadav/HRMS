// The tax rule pack registry: lists what a supplied pack declares, with an independent activation; no rate is entered anywhere.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ButtonRow, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api, formatDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section, StateBadge } from '../../ui';
import { CARD_LIST, CONFIG_ACTIVATE, CONFIG_MANAGE, CONFIG_READ, DATE_WIDTH, FIELD_WIDTH, FORM_STACK, ItemCard, notPermitted, type Regime } from './shared';

// =========================================================================================================
// Rule pack registry: lists what a supplied pack declares; no rate is entered anywhere
// =========================================================================================================

interface Pack {
  id: string;
  code: string;
  revision: number;
  fiscalPeriodCode: string;
  cutoffDate: string;
  state: string;
  version: number;
  createdBy: string | null;
  regimes: Regime[];
}

const parseRegimes = (text: string): Regime[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [regime, categories] = l.split(':');
      const [code, ...name] = (regime ?? '').trim().split(' ');
      return {
        code: code ?? '',
        name: name.join(' ') || (code ?? ''),
        categories: (categories ?? '')
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean)
          .map((c) => {
            const [categoryCode, ...categoryName] = c.split(' ');
            return { code: categoryCode ?? '', name: categoryName.join(' ') || (categoryCode ?? '') };
          }),
      };
    });

function PackForm({ onDone }: { onDone: () => void }) {
  const empty = { code: '', fiscalPeriodCode: '', periodStart: '', periodEnd: '', cutoffDate: '', currencyCode: '', currencyMinorUnit: '', sourceReference: '', validationReference: '', regimes: '' };
  const [f, setF] = useState(empty);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const create = useMutation({
    mutationFn: () => api<Pack>('/v1/payroll/tax-rule-packs', { body: { ...f, currencyMinorUnit: Number(f.currencyMinorUnit), regimes: parseRegimes(f.regimes) } }),
    onSuccess: () => {
      setF(empty);
      onDone();
    },
  });
  return (
    <form
      className={FORM_STACK}
      aria-label="Record a tax rule pack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!create.isPending) create.mutate();
      }}
      noValidate
    >
      <Hint>Records what the supplied pack lists. It holds no rate and calculates nothing; someone else activates it.</Hint>
      <FormField className={FIELD_WIDTH}>
        Pack code
        <Input value={f.code} onChange={set('code')} />
      </FormField>
      <FormField className={FIELD_WIDTH}>
        Fiscal period code
        <Input value={f.fiscalPeriodCode} onChange={set('fiscalPeriodCode')} />
      </FormField>
      <FormField className={DATE_WIDTH}>
        Period start
        <Input type="date" value={f.periodStart} onChange={set('periodStart')} />
      </FormField>
      <FormField className={DATE_WIDTH}>
        Period end
        <Input type="date" value={f.periodEnd} onChange={set('periodEnd')} />
      </FormField>
      <FormField className={DATE_WIDTH}>
        Cutoff date
        <Input type="date" value={f.cutoffDate} onChange={set('cutoffDate')} />
      </FormField>
      <FormField className={FIELD_WIDTH}>
        Currency code
        <Input value={f.currencyCode} onChange={set('currencyCode')} />
      </FormField>
      <FormField className={FIELD_WIDTH}>
        Currency decimals
        <Input inputMode="numeric" value={f.currencyMinorUnit} onChange={set('currencyMinorUnit')} />
      </FormField>
      <FormField className={FIELD_WIDTH}>
        Source of the pack
        <Input value={f.sourceReference} onChange={set('sourceReference')} />
      </FormField>
      <FormField className={FIELD_WIDTH}>
        Validation reference
        <Input value={f.validationReference} onChange={set('validationReference')} />
      </FormField>
      <FormField className={FIELD_WIDTH}>
        Regimes and categories, one regime per line: CODE Name: CAT_ONE First name, CAT_TWO Second name
        <Textarea rows={3} value={f.regimes} onChange={set('regimes')} />
      </FormField>
      <ErrorNote error={create.error} />
      <ButtonRow>
        <Button type="submit" disabled={create.isPending || !f.code || !f.regimes.trim()}>
          Save draft
        </Button>
      </ButtonRow>
    </form>
  );
}

function PackRow({ pack, onDone }: { pack: Pack; onDone: () => void }) {
  const { can, me } = useSession();
  const activate = useMutation({
    mutationFn: () => api<Pack>(`/v1/payroll/tax-rule-packs/${encodeURIComponent(pack.id)}/activate`, { body: { expectedVersion: pack.version } }),
    onSuccess: () => onDone(),
  });
  return (
    <ItemCard aria-label={`Pack ${pack.code} revision ${pack.revision}`}>
      <strong>{`${pack.code} r${pack.revision}`}</strong> <StateBadge state={pack.state} />
      <Hint>{`${pack.fiscalPeriodCode}; cutoff ${formatDate(pack.cutoffDate)}`}</Hint>
      <ul>
        {pack.regimes.map((r) => (
          <li key={r.code}>{`${r.name}: ${r.categories.map((c) => c.name).join(', ') || 'no categories'}`}</li>
        ))}
      </ul>
      <ErrorNote error={activate.error} />
      {pack.state === 'DRAFT' && can(CONFIG_ACTIVATE) && pack.createdBy !== me?.userId && (
        <Button type="button" onClick={() => activate.mutate()} disabled={activate.isPending}>
          Activate
        </Button>
      )}
    </ItemCard>
  );
}

export function TaxRulePacksScreen() {
  const { can } = useSession();
  const qc = useQueryClient();
  const packs = useQuery({ queryKey: ['tax-rule-packs'], queryFn: () => api<{ items: Pack[]; calculation: { message: string } }>('/v1/payroll/tax-rule-packs'), enabled: can(CONFIG_READ) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['tax-rule-packs'] });
  if (!can(CONFIG_READ)) return notPermitted('The selected role cannot read payroll configuration.');
  return (
    <Section title="Tax rule packs">
      <ErrorNote error={packs.error} />
      {packs.data && <Hint>{packs.data.calculation.message}</Hint>}
      {packs.data?.items.length === 0 && <Empty>No rule pack has been recorded. Tax declarations and proofs stay unavailable to employees until one is activated.</Empty>}
      {packs.data && packs.data.items.length > 0 && (
        <ul className={CARD_LIST}>
          {packs.data.items.map((p) => (
            <PackRow key={p.id} pack={p} onDone={refresh} />
          ))}
        </ul>
      )}
      {can(CONFIG_MANAGE) && <PackForm onDone={refresh} />}
    </Section>
  );
}
