// The company (FR-004; DB001; DF05): GET and PATCH /v1/org/company keep a fixed code, a name, the business timezone and a controlled
// deactivation, asked twice.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { NothingChanged } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '../../api';
import { useSession } from '../../session';
import { ErrorNote, Item, Notice, Section } from '../../ui';
import { ActiveBadge, MASTER_UPDATE, Refusal } from './shared';

/** GET /v1/org/company. */
export interface Company {
  id: string;
  code: string;
  name: string;
  businessTimezone: string;
  active: boolean;
  version: number;
}

const COMPANY_KEY = ['org-company'];

/** Buttons side by side in a paragraph of their own, wrapping on a narrow screen. */
const BUTTON_LINE = 'flex flex-wrap items-center gap-2';

/** The company's own refusals in plain words; null for one that reads as a master's does. */
function companyRefusalText(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case 'INVALID_TIMEZONE':
      return 'That is not a timezone the server knows. Use a name such as Asia/Kolkata.';
    case 'INVALID_NAME':
    case 'INVALID_REQUEST':
      return 'Check the values. A company needs a name, up to 200 characters, and a timezone.';
    case 'COMPANY_IN_USE': {
      const details = (error.details ?? {}) as { employees?: number; roleAssignments?: number };
      return `This company is still in use: ${details.employees ?? 0} employed and ${details.roleAssignments ?? 0} other role assignments. End them first. Nothing was changed.`;
    }
    default:
      return null;
  }
}

function CompanyRefusal({ error }: { error: unknown }) {
  const own = companyRefusalText(error);
  if (own) return <Notice notice={{ text: own, ok: false }} />;
  return <Refusal error={error} noun="company" />;
}

function CompanyForm({ company, onSaved, onConflict }: { company: Company; onSaved: (message: string) => void; onConflict: () => void }) {
  const [form, setForm] = useState({ name: company.name, businessTimezone: company.businessTimezone });
  const [unchanged, setUnchanged] = useState(false);
  const save = useMutation({
    mutationFn: (changes: Record<string, string>) => api<Company>('/v1/org/company', { method: 'PATCH', body: { expectedVersion: company.version, ...changes } }),
    onSuccess: () => onSaved('Company saved.'),
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'STALE_VERSION') onConflict();
    },
  });
  // Only what differs from the company as it now stands is sent.
  const changes = (): Record<string, string> => ({
    ...(form.name.trim() !== company.name ? { name: form.name.trim() } : {}),
    ...(form.businessTimezone.trim() !== company.businessTimezone ? { businessTimezone: form.businessTimezone.trim() } : {}),
  });
  return (
    <FormGrid
      aria-label="Edit company"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const changed = changes();
        const nothing = Object.keys(changed).length === 0;
        setUnchanged(nothing);
        if (nothing) save.reset();
        else save.mutate(changed);
      }}
    >
      <FormField>
        Name
        <Input required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </FormField>
      <FormField>
        Business timezone
        <Input required maxLength={100} value={form.businessTimezone} onChange={(e) => setForm({ ...form, businessTimezone: e.target.value })} />
      </FormField>
      <Button type="submit" disabled={save.isPending}>
        Save company
      </Button>
      <Hint>The business date follows the timezone from the moment it is saved.</Hint>
      <div className="col-span-full">
        {unchanged && <NothingChanged />}
        <CompanyRefusal error={save.error} />
      </div>
    </FormGrid>
  );
}

/** FR-004 "allow controlled deactivation": asked twice, because nobody can act in the company afterwards, this person included. */
function CompanyDeactivation({ company, onDeactivated, onConflict }: { company: Company; onDeactivated: () => void; onConflict: () => void }) {
  const [asked, setAsked] = useState(false);
  const deactivate = useMutation({
    mutationFn: () => api<Company>('/v1/org/company', { method: 'PATCH', body: { expectedVersion: company.version, active: false } }),
    onSuccess: onDeactivated,
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'STALE_VERSION') onConflict();
    },
  });
  return (
    <Section title="Deactivate this company">
      <Hint>Refused while anyone is still employed or anyone else holds a role in it. Once deactivated, nobody can act in the company, you included, and nothing on these screens can bring it back.</Hint>
      {asked ? (
        <p className={BUTTON_LINE}>
          <Button type="button" variant="danger" aria-label={`Confirm deactivating ${company.code}`} disabled={deactivate.isPending} onClick={() => deactivate.mutate()}>
            Confirm deactivating
          </Button>{' '}
          <Button type="button" variant="outline" onClick={() => setAsked(false)}>
            Keep it active
          </Button>
        </p>
      ) : (
        <p className={BUTTON_LINE}>
          <Button type="button" variant="danger" aria-label={`Deactivate ${company.code}`} onClick={() => setAsked(true)}>
            Deactivate
          </Button>
        </p>
      )}
      <CompanyRefusal error={deactivate.error} />
    </Section>
  );
}

export function CompanyPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [deactivated, setDeactivated] = useState(false);
  // Nothing can be read once it is deactivated, so the page stops asking and says so.
  const company = useQuery({ queryKey: COMPANY_KEY, enabled: !deactivated, queryFn: () => api<Company>('/v1/org/company') });
  const refresh = () => void qc.invalidateQueries({ queryKey: COMPANY_KEY });
  if (deactivated) {
    return (
      <Section title="Company">
        <Notice notice={{ text: 'The company has been deactivated. Nobody can act in it now, you included.', ok: true }} />
      </Section>
    );
  }
  const c = company.data;
  return (
    <>
      <Section title="Company">
        {notice && <Notice notice={{ text: notice, ok: true }} />}
        <ErrorNote error={company.error} />
        {c && (
          <dl className="kv">
            <Item term="Code">{c.code}</Item>
            <Item term="Name">{c.name}</Item>
            <Item term="Business timezone">{c.businessTimezone}</Item>
            <Item term="State">
              <ActiveBadge active={c.active} />
            </Item>
          </dl>
        )}
        <Hint>The code never changes: a new code is a new company.</Hint>
        {c && can(MASTER_UPDATE) && (
          <CompanyForm
            company={c}
            onConflict={refresh}
            onSaved={(message) => {
              setNotice(message);
              refresh();
            }}
          />
        )}
      </Section>
      {c?.active && can(MASTER_UPDATE) && <CompanyDeactivation company={c} onConflict={refresh} onDeactivated={() => setDeactivated(true)} />}
    </>
  );
}
