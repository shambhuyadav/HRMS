// Register (Admin): the list, its filters and new items.

import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, NotPermitted, Section } from '../../ui';
import { CategorySelect, useCategories } from './lookups';
import { Problem, QueryProblem, Refusal } from './refusals';
import { ASSET_MANAGE, ASSET_READ, ASSET_STATES, AssetState, holderLabel, optional, PAGE_SIZE, PATHS, REQUEST_DECIDE, REQUEST_READ, SCROLL, shown, STATE_LABEL, useKeys, useRefetchAll } from './shared';
import type { Asset, Category, Page } from './types';

// ---------------------------------------------------------------------------------------------------------
// Register (Admin): list, filters and new items
// ---------------------------------------------------------------------------------------------------------
interface RegisterFilters {
  state: string;
  categoryCode: string;
  search: string;
  page: number;
}

function registerQuery(f: RegisterFilters): string {
  const q = new URLSearchParams();
  if (f.state) q.set('state', f.state);
  if (f.categoryCode) q.set('categoryCode', f.categoryCode);
  if (f.search.trim()) q.set('search', f.search.trim());
  q.set('page', String(f.page));
  q.set('pageSize', String(PAGE_SIZE));
  return q.toString();
}

export function RegisterScreen() {
  const { can, me } = useSession();
  const keys = useKeys();
  const ownContext = me?.scopeKind === 'OWN';
  const allowed = can(ASSET_READ) && !ownContext;
  const [filters, setFilters] = useState<RegisterFilters>({ state: '', categoryCode: '', search: '', page: 1 });
  const [searchText, setSearchText] = useState('');
  const categories = useCategories(false, allowed);
  const query = registerQuery(filters);
  const list = useQuery({ queryKey: keys.register(query), queryFn: () => api<Page<Asset>>(`/v1/assets?${query}`), enabled: allowed, retry: retryTransient });

  if (!can(ASSET_READ)) {
    return (
      <div className="stack">
        <h1>Asset register</h1>
        <NotPermitted>The selected role cannot read the asset register.</NotPermitted>
      </div>
    );
  }
  if (ownContext) {
    return (
      <div className="stack">
        <h1>Asset register</h1>
        <NotPermitted>The asset register needs an unrestricted company-scope Admin assignment. Your own items are on My ESS.</NotPermitted>
      </div>
    );
  }
  const data = shown(list);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const categoryList = shown(categories)?.items;
  return (
    <div className="stack">
      <h1>Asset register</h1>
      <p className="hint">
        Company items in custody: no value, cost or depreciation is kept. Retired items stay in the register for good. Custody requests are decided on{' '}
        {can(REQUEST_DECIDE) || can(REQUEST_READ) ? <Link to={PATHS.requests}>Custody requests</Link> : 'Custody requests'}.
      </p>
      {can(ASSET_MANAGE) && <CreateAssetForm categories={categoryList} />}
      <Section title="Items">
        <form
          className="grid-form"
          aria-label="Filter the register"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters({ ...filters, search: searchText, page: 1 });
          }}
        >
          <label>
            State
            <select value={filters.state} onChange={(e) => setFilters({ ...filters, state: e.target.value, page: 1 })}>
              <option value="">All states</option>
              {ASSET_STATES.map((s) => (
                <option key={s} value={s}>
                  {STATE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <CategorySelect
            label="Category"
            value={filters.categoryCode}
            onChange={(categoryCode) => setFilters({ ...filters, categoryCode, page: 1 })}
            categories={categoryList}
            allLabel="All categories"
          />
          <label>
            Search
            <input type="search" value={searchText} maxLength={100} placeholder="Asset code, description or identifier" onChange={(e) => setSearchText(e.target.value)} />
          </label>
          <button type="submit">Search</button>
        </form>
        {list.isPending && <p className="hint loading">Loading the register…</p>}
        <QueryProblem error={list.error} forbidden="The asset register needs an unrestricted company-scope Admin assignment." />
        {data && data.items.length === 0 && <Empty>No items match these filters.</Empty>}
        {data && data.items.length > 0 && (
          <>
            <div style={SCROLL}>
              <table aria-label="Register items">
                <thead>
                  <tr>
                    <th>Asset code</th>
                    <th>Category</th>
                    <th>Description</th>
                    <th>Identifier</th>
                    <th>State</th>
                    <th>Held by</th>
                    <th>Issued on</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <Link to={PATHS.asset(a.id)}>{a.assetCode}</Link>
                      </td>
                      <td>{a.category.label}</td>
                      <td>{a.description}</td>
                      <td>{optional(a.identifier)}</td>
                      <td>
                        <AssetState state={a.state} />
                      </td>
                      <td>{a.holder ? <Link to={PATHS.employee(a.holder.employeeId)}>{holderLabel(a.holder)}</Link> : '—'}</td>
                      <td>{a.holder ? formatDate(a.holder.issuedOn) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <button type="button" className="secondary" disabled={filters.page <= 1} onClick={() => setFilters({ ...filters, page: filters.page - 1 })}>
                Previous page
              </button>
              <span>
                Page {data.page} of {pages} · {data.total} item{data.total === 1 ? '' : 's'}
              </span>
              <button type="button" className="secondary" disabled={filters.page >= pages} onClick={() => setFilters({ ...filters, page: filters.page + 1 })}>
                Next page
              </button>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}

interface CreateInput {
  assetCode: string;
  categoryCode: string;
  description: string;
  identifier?: string;
}

function CreateAssetForm({ categories }: { categories: Category[] | undefined }) {
  const refetchAll = useRefetchAll();
  const empty = { assetCode: '', categoryCode: '', description: '', identifier: '' };
  const [draft, setDraft] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<Asset | null>(null);
  const create = useMutation({
    mutationFn: (body: CreateInput) => api<Asset>('/v1/assets', { method: 'POST', body }),
    onSuccess: (asset) => {
      setCreated(asset);
      setDraft(empty);
      void refetchAll();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setCreated(null);
    const assetCode = draft.assetCode.trim();
    const description = draft.description.trim();
    if (!assetCode || !draft.categoryCode || !description) {
      setProblem('Enter the asset code, choose a category and describe the item.');
      return;
    }
    setProblem(null);
    const identifier = draft.identifier.trim();
    create.mutate({ assetCode, categoryCode: draft.categoryCode, description, ...(identifier ? { identifier } : {}) });
  };
  return (
    <Section title="Add an item">
      <form className="grid-form" aria-label="Add an item" onSubmit={submit} noValidate>
        <label>
          Asset code
          <input value={draft.assetCode} maxLength={40} onChange={(e) => setDraft({ ...draft, assetCode: e.target.value })} />
        </label>
        <CategorySelect label="Category" value={draft.categoryCode} onChange={(categoryCode) => setDraft({ ...draft, categoryCode })} categories={categories} />
        <label>
          Identifier (optional, e.g. a serial number)
          <input value={draft.identifier} maxLength={200} onChange={(e) => setDraft({ ...draft, identifier: e.target.value })} />
        </label>
        <label className="wide">
          Description
          <input value={draft.description} maxLength={500} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </label>
        <p className="hint wide">The code is permanent and never reused. A new item starts in stock.</p>
        <div className="wide">
          <button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Adding…' : 'Add the item'}
          </button>
        </div>
      </form>
      <Problem text={problem} />
      <Refusal error={create.error} action="create" />
      {created && (
        <p role="status" className="ok">
          <Link to={PATHS.asset(created.id)}>{created.assetCode}</Link> was added to the register ({STATE_LABEL[created.state] ?? readable(created.state)}).
        </p>
      )}
    </Section>
  );
}
