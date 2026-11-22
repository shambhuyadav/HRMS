// Proposal (FR-067): a pending grant for the selected user, inside the chosen role's ceiling.

import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { ButtonRow, CheckField, ChoiceRow, FormField, FormGrid, FramedFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { api, isForbidden } from '../../api';
import { Badge, Empty, ErrorNote, Notice, NotPermitted, Section } from '../../ui';
import {
  atLocalMidnight,
  type CataloguePermission,
  type CatalogueRole,
  CLASS_LABEL,
  type OrgItem,
  type OrgQuery,
  type ProposalBody,
  type RolesQuery,
  SCOPE_LABEL,
  type ScopeKind,
  SCOPES,
  shown,
  todayLocal,
  useRefreshAccess,
} from './shared';

/** One resource's permissions inside the permission group, without a frame of their own. */
const RESOURCE_GROUP = 'gap-[0.55rem]';
/** The resource's name above its permissions, muted. */
const RESOURCE_LEGEND = 'p-0 text-[0.84rem] font-semibold text-muted-foreground';

// ---------------------------------------------------------------------------------------------------------
// Proposal (FR-067): a pending grant for the selected user, inside the chosen role's ceiling
// ---------------------------------------------------------------------------------------------------------

export function ProposeGrant({
  userId,
  userLabel,
  roles,
  orgDepartments,
  orgLocations,
}: {
  userId: string;
  userLabel: string;
  roles: RolesQuery;
  orgDepartments: OrgQuery;
  orgLocations: OrgQuery;
}) {
  const title = `Propose a grant for ${userLabel}`;
  const catalogue = shown(roles);
  if (roles.isPending) {
    return (
      <Section title={title}>
        <LoadingLine>Loading roles…</LoadingLine>
      </Section>
    );
  }
  if (!catalogue) {
    return (
      <Section title={title}>
        {isForbidden(roles.error) ? <NotPermitted>The selected role cannot read the role catalogue.</NotPermitted> : <ErrorNote error={roles.error} />}
      </Section>
    );
  }
  const active = catalogue.items.filter((r) => r.active);
  return (
    <Section title={title}>
      {active.length === 0 ? <Empty>No active roles can be granted.</Empty> : <ProposeForm userId={userId} roles={active} orgDepartments={orgDepartments} orgLocations={orgLocations} />}
    </Section>
  );
}

const defaultDuties = (role: CatalogueRole | undefined): ReadonlySet<string> =>
  new Set((role?.permissions ?? []).filter((p) => p.defaultDuty && !p.confidential).map((p) => p.key));

function toggled(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function groupByResource(permissions: CataloguePermission[]): [string, CataloguePermission[]][] {
  const groups = new Map<string, CataloguePermission[]>();
  for (const p of permissions) {
    const resource = p.key.split('.')[0] ?? p.key;
    const list = groups.get(resource);
    if (list) list.push(p);
    else groups.set(resource, [p]);
  }
  return [...groups.entries()];
}

/** What a scope filter picker offers: the active entries of the last list the server returned (none before one). */
const pickable = (q: OrgQuery): OrgItem[] => (q.data?.items ?? []).filter((i) => i.active);

function ProposeForm({ userId, roles, orgDepartments, orgLocations }: { userId: string; roles: CatalogueRole[]; orgDepartments: OrgQuery; orgLocations: OrgQuery }) {
  const refresh = useRefreshAccess();
  const id = useId();
  const [roleCode, setRoleCode] = useState('');
  const [scopeKind, setScopeKind] = useState<ScopeKind | ''>('');
  const [from, setFrom] = useState(todayLocal);
  const [to, setTo] = useState('');
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [purpose, setPurpose] = useState('');
  const [departments, setDepartments] = useState<ReadonlySet<string>>(() => new Set());
  const [locations, setLocations] = useState<ReadonlySet<string>>(() => new Set());

  const propose = useMutation({
    mutationFn: (body: ProposalBody) => api<{ id: string; state: string }>('/v1/access/assignments', { method: 'POST', body }),
    onSuccess: () => {
      setRoleCode('');
      setScopeKind('');
      setTo('');
      setChecked(new Set());
      setPurpose('');
      setDepartments(new Set());
      setLocations(new Set());
      refresh();
    },
  });

  const departmentOptions = pickable(orgDepartments);
  const locationOptions = pickable(orgLocations);
  const role = roles.find((r) => r.code === roleCode);
  const eligible = !!role && role.accessClass !== 'OTHER';
  const chosen = role ? role.permissions.filter((p) => checked.has(p.key) && (!p.confidential || eligible)) : [];
  const needsPurpose = chosen.some((p) => p.confidential);
  const fromIso = from ? atLocalMidnight(from) : null;
  const toIso = to ? atLocalMidnight(to) : null;

  const missing: string[] = [];
  if (!role) missing.push('a role');
  if (!scopeKind) missing.push('a scope');
  if (!fromIso) missing.push('an effective-from date');
  if (to && !toIso) missing.push('a valid effective-to date');
  if (chosen.length === 0) missing.push('at least one permission');
  if (needsPurpose && !purpose.trim()) missing.push('a business purpose for the confidential permissions');
  const missingId = `${id}-missing`;

  const chooseRole = (code: string) => {
    const next = roles.find((r) => r.code === code);
    setRoleCode(code);
    setScopeKind(next?.defaultScope ?? '');
    setChecked(defaultDuties(next));
    propose.reset();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (missing.length > 0 || !role || !scopeKind || !fromIso || propose.isPending) return;
    // Exactly the entries the pickers show as chosen, in list order.
    const pick = (ids: ReadonlySet<string>, options: OrgItem[]) => options.filter((i) => ids.has(i.id)).map((i) => i.id);
    const deps = pick(departments, departmentOptions);
    const locs = pick(locations, locationOptions);
    const text = purpose.trim();
    propose.mutate({
      userId,
      roleCode: role.code,
      scopeKind,
      effectiveFrom: fromIso,
      ...(toIso ? { effectiveTo: toIso } : {}),
      permissions: chosen.map((p) => p.key),
      ...(deps.length > 0 || locs.length > 0 ? { filters: { ...(deps.length > 0 ? { departments: deps } : {}), ...(locs.length > 0 ? { locations: locs } : {}) } } : {}),
      ...(text ? { purpose: text } : {}),
    });
  };

  const showFilters = departmentOptions.length > 0 || locationOptions.length > 0;

  return (
    <FormGrid onSubmit={submit} aria-label="Propose a grant">
      <FormField>
        Role
        <NativeSelect required value={roleCode} onChange={(e) => chooseRole(e.target.value)}>
          <option value="">Choose a role</option>
          {roles.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name} ({CLASS_LABEL[r.accessClass] ?? r.accessClass})
            </option>
          ))}
        </NativeSelect>
      </FormField>
      <FormField>
        Scope
        <NativeSelect required disabled={!role} value={scopeKind} onChange={(e) => setScopeKind(e.target.value as ScopeKind | '')}>
          <option value="" disabled>
            Choose a scope
          </option>
          {SCOPES.map((s) => (
            <option key={s} value={s}>
              {SCOPE_LABEL[s]}
              {role?.defaultScope === s ? ' (role default)' : ''}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      <FormField>
        Effective from
        <Input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} />
      </FormField>
      <FormField>
        Effective to (optional)
        <Input type="date" value={to} aria-describedby={`${id}-to`} onChange={(e) => setTo(e.target.value)} />
      </FormField>
      <Hint id={`${id}-to`}>Access ends at the start of the effective-to day, which must be after the effective-from date.</Hint>

      {role && <PermissionPicker role={role} checked={checked} chosenCount={chosen.length} onToggle={(key) => setChecked((prev) => toggled(prev, key))} />}

      <OrgFilter legend="Restrict to departments (optional)" query={orgDepartments} options={departmentOptions} selected={departments} onToggle={(v) => setDepartments((prev) => toggled(prev, v))} />
      <OrgFilter legend="Restrict to locations (optional)" query={orgLocations} options={locationOptions} selected={locations} onToggle={(v) => setLocations((prev) => toggled(prev, v))} />
      {showFilters && (
        <Hint>
          Chosen departments and locations narrow the grant: an employee must be in one of the chosen departments (if any) and in one of the chosen locations (if any). Leave
          both empty for no restriction.
        </Hint>
      )}

      <FormField className="col-span-full">
        {needsPurpose ? 'Business purpose (required for confidential permissions)' : 'Business purpose (optional)'}
        <Textarea rows={2} maxLength={500} required={needsPurpose} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      </FormField>

      <ButtonRow className="col-span-full">
        <Button type="submit" disabled={missing.length > 0 || propose.isPending} aria-describedby={role && missing.length > 0 ? missingId : undefined}>
          Propose grant
        </Button>
        {role && (
          <Button type="button" variant="outline" onClick={() => setChecked(defaultDuties(role))}>
            Reset to default duties
          </Button>
        )}
      </ButtonRow>
      {role && missing.length > 0 && <Hint id={missingId}>Still needed: {missing.join(', ')}.</Hint>}
      {propose.isSuccess && <Notice notice={{ text: 'Proposed — needs independent approval', ok: true }} />}
      {propose.error && (
        <div className="col-span-full">
          <ErrorNote error={propose.error} />
        </div>
      )}
    </FormGrid>
  );
}

/** The role's ceiling: default duties pre-checked; confidential permissions never pre-checked and clearly labelled. */
function PermissionPicker({ role, checked, chosenCount, onToggle }: { role: CatalogueRole; checked: ReadonlySet<string>; chosenCount: number; onToggle: (key: string) => void }) {
  const hintId = useId();
  const eligible = role.accessClass !== 'OTHER';
  const hasConfidential = role.permissions.some((p) => p.confidential);
  if (role.permissions.length === 0) return <Hint>This role has no permissions in its ceiling.</Hint>;
  return (
    <FramedFieldset legend={<>Permissions ({chosenCount} of {role.permissions.length} selected)</>}>
      <Hint>
        The role&apos;s default duties are pre-selected.
        {hasConfidential && eligible && ' Confidential permissions are never pre-selected; choosing one needs a business purpose.'}
      </Hint>
      {hasConfidential && !eligible && <Hint id={hintId}>Confidential permissions are disabled: only Admin or Manager roles can hold confidential permissions.</Hint>}
      {groupByResource(role.permissions).map(([resource, perms]) => (
        <FieldSet key={resource} className={RESOURCE_GROUP}>
          <legend className={RESOURCE_LEGEND}>{resource.replace(/_/g, ' ')}</legend>
          <ChoiceRow>
            {perms.map((p) => {
              const disabled = p.confidential && !eligible;
              return (
                <CheckField key={p.key}>
                  <input
                    type="checkbox"
                    checked={!disabled && checked.has(p.key)}
                    disabled={disabled}
                    aria-describedby={disabled ? hintId : undefined}
                    onChange={() => onToggle(p.key)}
                  />
                  <code>{p.key}</code>
                  {p.confidential && <Badge tone="warn">confidential</Badge>}
                  {p.defaultDuty && <Hint as="span">default duty</Hint>}
                </CheckField>
              );
            })}
          </ChoiceRow>
        </FieldSet>
      ))}
    </FramedFieldset>
  );
}

/** A scope filter picker; shown whenever it has entries to offer, so every chosen entry that is sent is visible. */
function OrgFilter({
  legend,
  query,
  options,
  selected,
  onToggle,
}: {
  legend: string;
  query: OrgQuery;
  options: OrgItem[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  if (options.length === 0) {
    // Not readable by the selected role (never requested, or refused): no picker. Any other failure is shown.
    return query.error && !isForbidden(query.error) ? (
      <div className="col-span-full">
        <ErrorNote error={query.error} />
      </div>
    ) : null;
  }
  return (
    <FramedFieldset legend={legend}>
      <ChoiceRow>
        {options.map((i) => (
          <CheckField key={i.id}>
            <input type="checkbox" checked={selected.has(i.id)} onChange={() => onToggle(i.id)} />
            {i.name} <Hint as="span">{i.code}</Hint>
          </CheckField>
        ))}
      </ChoiceRow>
    </FramedFieldset>
  );
}
