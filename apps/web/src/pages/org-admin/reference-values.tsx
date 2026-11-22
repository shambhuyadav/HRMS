// Reference values (FR-004 configurable entities; DF04; DB006). Create, relabel, deactivate or end-date, never delete. The server
// decides which lists can change and which codes must stay in force; the page shows it.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CheckField, FilterBar, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, Section } from '../../ui';
import { MANAGE_REFERENCE, ONE_LINE } from './shared';

interface ReferenceCategory {
  category: string;
  maintainable: boolean;
  protectedCodes: string[];
}

interface ReferenceValue {
  id: string;
  category: string;
  code: string;
  label: string;
  active: boolean;
  validFrom: string | null;
  validTo: string | null;
  version: number;
}

/** A date field in a row of the list: wide enough for a date, not the whole column. */
const DATE_IN_ROW = 'w-auto min-w-[10rem]';
/** A label field in a row of the list: never narrower than a short label. */
const LABEL_IN_ROW = 'min-w-48';
/**
 * A refusal under a row's buttons. The cell is only as wide as its buttons (RowActionsCell), so without a width of its own the message
 * would be squeezed to them. On a phone the row is a card whose cells set their values at the right (styles.css, table cards): the
 * message takes the card's width and reads from the left.
 */
const IN_ROW_NOTE = 'mt-2 min-[561px]:min-w-[20rem] phone:basis-full phone:text-left';

function ValueRow({ value, editable, codeProtected, onSaved }: { value: ReferenceValue; editable: boolean; codeProtected: boolean; onSaved: () => void }) {
  const [label, setLabel] = useState(value.label);
  const [validTo, setValidTo] = useState(value.validTo ?? '');
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api(`/v1/reference-admin/values/${value.id}`, { method: 'PATCH', body: { expectedVersion: value.version, ...patch } }),
    onSuccess: onSaved,
  });
  const until = value.validTo ? formatDate(value.validTo) : '—';
  return (
    <TableRow>
      <TableCell className={ONE_LINE}>{value.code}</TableCell>
      <TableCell>{editable ? <Input aria-label={`Label of ${value.code}`} className={LABEL_IN_ROW} value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} /> : value.label}</TableCell>
      <TableCell className={ONE_LINE}>{value.validFrom ? formatDate(value.validFrom) : '—'}</TableCell>
      <TableCell className={ONE_LINE}>
        {editable && !codeProtected ? <Input type="date" className={DATE_IN_ROW} aria-label={`Until for ${value.code}`} value={validTo} onChange={(e) => setValidTo(e.target.value)} /> : until}
      </TableCell>
      <TableCell>
        <Badge tone={value.active ? 'good' : 'warn'}>{value.active ? 'Active' : 'Inactive'}</Badge>
      </TableCell>
      <RowActionsCell>
        <RowActions>
          {editable && (
            <Button
              type="button"
              size="sm"
              aria-label={`Save ${value.code}`}
              disabled={save.isPending || label.trim() === ''}
              onClick={() => save.mutate({ ...(label.trim() !== value.label ? { label: label.trim() } : {}), ...(!codeProtected && validTo !== (value.validTo ?? '') ? { validTo: validTo || null } : {}) })}
            >
              Save
            </Button>
          )}{' '}
          {editable && !codeProtected && (
            <Button
              type="button"
              variant={value.active ? 'danger' : 'outline'}
              size="sm"
              aria-label={value.active ? `Deactivate ${value.code}` : `Reactivate ${value.code}`}
              disabled={save.isPending}
              onClick={() => save.mutate({ active: !value.active })}
            >
              {value.active ? 'Deactivate' : 'Reactivate'}
            </Button>
          )}
          {/* On one line beside the button above phone width, where the cell is only as wide as its contents. */}
          {editable && codeProtected && (
            <Hint as="span" className="min-[561px]:whitespace-nowrap">
              Used by the application: stays in force
            </Hint>
          )}
        </RowActions>
        {save.error && (
          <div className={IN_ROW_NOTE}>
            <ErrorNote error={save.error} />
          </div>
        )}
      </RowActionsCell>
    </TableRow>
  );
}

export function ReferenceValuesPage() {
  const { can } = useSession();
  const client = useQueryClient();
  const [category, setCategory] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [form, setForm] = useState({ code: '', label: '', validFrom: '', validTo: '' });
  const categories = useQuery({ queryKey: ['reference-categories'], queryFn: () => api<{ items: ReferenceCategory[] }>('/v1/reference-admin/categories') });
  const current = categories.data?.items.find((c) => c.category === category);
  const values = useQuery({
    queryKey: ['reference-values-admin', category, includeInactive],
    enabled: category !== '',
    queryFn: () => api<{ items: ReferenceValue[] }>(`/v1/reference-admin/values?category=${encodeURIComponent(category)}&includeInactive=${includeInactive}`),
  });
  const editable = can(MANAGE_REFERENCE) && current?.maintainable === true;
  const refresh = () => void client.invalidateQueries({ queryKey: ['reference-values-admin'] });
  const create = useMutation({
    mutationFn: () =>
      api('/v1/reference-admin/values', {
        body: { category, code: form.code.trim(), label: form.label.trim(), ...(form.validFrom ? { validFrom: form.validFrom } : {}), ...(form.validTo ? { validTo: form.validTo } : {}) },
      }),
    onSuccess: () => {
      setForm({ code: '', label: '', validFrom: '', validTo: '' });
      refresh();
    },
  });
  return (
    <Section title="Reference values">
      <FilterBar>
        <FormField>
          List{' '}
          <NativeSelect value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Choose a list</option>
            {categories.data?.items.map((c) => (
              <option key={c.category} value={c.category}>
                {c.category}
                {c.maintainable ? '' : ' (protected)'}
              </option>
            ))}
          </NativeSelect>
        </FormField>{' '}
        <CheckField>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Show inactive
        </CheckField>
      </FilterBar>
      {current && !current.maintainable && <Hint>The application depends on this list, so it cannot be changed here.</Hint>}
      {values.data?.items.length === 0 && <Empty>No values in this list.</Empty>}
      {values.data && values.data.items.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Code</TableHead>
              <TableHead scope="col">Label</TableHead>
              <TableHead scope="col">From</TableHead>
              <TableHead scope="col">Until</TableHead>
              <TableHead scope="col">State</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {values.data.items.map((v) => (
              <ValueRow key={`${v.id}-${v.version}`} value={v} editable={editable} codeProtected={current?.protectedCodes.includes(v.code) ?? false} onSaved={refresh} />
            ))}
          </TableBody>
        </Table>
      )}
      {editable && (
        <FormGrid
          aria-label="Add a value"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <FormField>
            Code
            <Input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </FormField>
          <FormField>
            Label
            <Input required maxLength={200} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </FormField>
          <FormField>
            From
            <Input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
          </FormField>
          <FormField>
            Until (not included)
            <Input type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
          </FormField>
          <Button type="submit" disabled={create.isPending}>
            Add value
          </Button>
          <ErrorNote error={create.error} />
        </FormGrid>
      )}
      <ErrorNote error={categories.error ?? values.error} />
    </Section>
  );
}
