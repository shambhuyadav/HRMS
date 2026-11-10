// Organisation chart (coverage CL-023 "Org Structure", under FR-001 and FR-003): GET /v1/org/chart gives everyone employed today whom
// the requester may list (HR the company, a manager their team, BR-026), each with their manager on that day. The tree is built here:
// people whose manager is not in the answer (or who have none) are its top. A search keeps the matches and the line above them.
// Read-only; the server decides who is on it.
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate } from '../api';
import { Icon } from '../icons';
import { useSession } from '../session';
import { Empty, ErrorNote, Section } from '../ui';

export const ORG_CHART_PERMISSION = 'employee.list.operational';
const EMPLOYEE_READ = 'employee.read.operational';

export interface OrgChartNode {
  id: string;
  code: string;
  name: string;
  designation: string | null;
  department: string | null;
  location: string | null;
  managerId: string | null;
}

export interface OrgChart {
  asOf: string;
  items: OrgChartNode[];
  truncated: boolean;
}

export interface OrgTree {
  roots: OrgChartNode[];
  children: Map<string, OrgChartNode[]>;
  /** Everyone below a person, at any depth. */
  below: Map<string, number>;
  parent: Map<string, string>;
}

/** Builds the tree: roots are people whose manager is not in the list. A reporting loop (never expected) is broken at its first member. */
export function buildOrgTree(items: readonly OrgChartNode[]): OrgTree {
  const byId = new Map(items.map((n) => [n.id, n]));
  const children = new Map<string, OrgChartNode[]>();
  const parent = new Map<string, string>();
  const roots: OrgChartNode[] = [];
  for (const n of items) {
    if (n.managerId && n.managerId !== n.id && byId.has(n.managerId)) {
      const list = children.get(n.managerId) ?? [];
      list.push(n);
      children.set(n.managerId, list);
      parent.set(n.id, n.managerId);
    } else {
      roots.push(n);
    }
  }
  const below = new Map<string, number>();
  const seen = new Set<string>();
  const count = (n: OrgChartNode): number => {
    if (seen.has(n.id)) return 0;
    seen.add(n.id);
    let total = 0;
    for (const c of children.get(n.id) ?? []) total += 1 + count(c);
    below.set(n.id, total);
    return total;
  };
  roots.forEach(count);
  for (const n of items) {
    if (!seen.has(n.id)) {
      // A loop: nobody in it is reachable from a root. Its first member becomes a root so everyone still shows.
      parent.delete(n.id);
      const siblings = children.get(n.managerId ?? '') ?? [];
      children.set(n.managerId ?? '', siblings.filter((s) => s.id !== n.id));
      roots.push(n);
      count(n);
    }
  }
  return { roots, children, below, parent };
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

function matches(n: OrgChartNode, q: string): boolean {
  return [n.name, n.code, n.designation, n.department, n.location].some((v) => v?.toLowerCase().includes(q));
}

function PersonCard({ node, team, below, linked, hit }: { node: OrgChartNode; team: number; below: number; linked: boolean; hit: boolean }) {
  const place = [node.department, node.location].filter(Boolean).join(' · ');
  return (
    <div className={hit ? 'org-card hit' : 'org-card'}>
      <span className="avatar" aria-hidden="true">
        {initials(node.name)}
      </span>
      <span className="org-card-body">
        <span className="org-card-name">
          {linked ? <Link to={`/employees/${node.id}`}>{node.name}</Link> : node.name} <span className="org-card-code">{node.code}</span>
        </span>
        <span className="org-card-role">{node.designation ?? 'No designation'}</span>
        {place && <span className="org-card-place">{place}</span>}
      </span>
      {team > 0 && (
        <span className="org-card-team" title={`${team} direct, ${below} in all`}>
          {team} direct{below > team ? ` · ${below} in all` : ''}
        </span>
      )}
    </div>
  );
}

function Branch({
  node,
  tree,
  open,
  toggle,
  visible,
  query,
  linked,
  depth,
}: {
  node: OrgChartNode;
  tree: OrgTree;
  open: (id: string) => boolean;
  toggle: (id: string) => void;
  visible: ((id: string) => boolean) | null;
  query: string;
  linked: boolean;
  depth: number;
}) {
  const kids = (tree.children.get(node.id) ?? []).filter((c) => !visible || visible(c.id));
  const team = tree.children.get(node.id)?.length ?? 0;
  const expanded = kids.length > 0 && open(node.id);
  return (
    <li role="treeitem" aria-level={depth} aria-expanded={kids.length > 0 ? expanded : undefined} aria-label={node.name} className="org-item">
      <div className="org-row">
        {kids.length > 0 ? (
          <button type="button" className="org-toggle" onClick={() => toggle(node.id)} aria-label={`${expanded ? 'Hide' : 'Show'} the team of ${node.name}`}>
            <Icon name="chevron" size={14} {...(expanded ? { className: 'open' } : {})} />
          </button>
        ) : (
          <span className="org-toggle-spacer" aria-hidden="true" />
        )}
        <PersonCard node={node} team={team} below={tree.below.get(node.id) ?? 0} linked={linked} hit={query !== '' && matches(node, query)} />
      </div>
      {expanded && (
        <ul role="group" className="org-children">
          {kids.map((c) => (
            <Branch key={c.id} node={c} tree={tree} open={open} toggle={toggle} visible={visible} query={query} linked={linked} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function OrgChartPage() {
  const { can } = useSession();
  const chart = useQuery({ queryKey: ['org-chart'], queryFn: () => api<OrgChart>('/v1/org/chart') });
  const items = chart.data?.items;
  const tree = useMemo(() => buildOrgTree(items ?? []), [items]);
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  // Expansion: by default the top of each branch is open (so two levels show); a person's choice overrides it.
  const [choice, setChoice] = useState<Map<string, boolean>>(new Map());
  const [allOpen, setAllOpen] = useState<boolean | null>(null);

  // While searching: the matches and everyone above them, all open.
  const shown = useMemo(() => {
    if (!query || !items) return null;
    const keep = new Set<string>();
    for (const n of items) {
      if (!matches(n, query)) continue;
      let id: string | undefined = n.id;
      while (id && !keep.has(id)) {
        keep.add(id);
        id = tree.parent.get(id);
      }
    }
    return keep;
  }, [query, items, tree]);

  const open = (id: string) => {
    if (shown) return true;
    const c = choice.get(id);
    if (c !== undefined) return c;
    if (allOpen !== null) return allOpen;
    return !tree.parent.has(id);
  };
  const toggle = (id: string) => setChoice((m) => new Map(m).set(id, !open(id)));
  const setAll = (value: boolean) => {
    setChoice(new Map());
    setAllOpen(value);
  };

  const people = items?.length ?? 0;
  const managers = tree.children.size === 0 ? 0 : [...tree.children.values()].filter((k) => k.length > 0).length;
  const widest = Math.max(0, ...[...tree.children.values()].map((k) => k.length));
  const roots = shown ? tree.roots.filter((r) => shown.has(r.id)) : tree.roots;
  const visible = shown ? (id: string) => shown.has(id) : null;
  const linked = can(EMPLOYEE_READ);

  return (
    <Section
      title="Organisation chart"
      actions={
        people > 0 && !shown ? (
          <>
            <button type="button" className="secondary" onClick={() => setAll(true)}>
              Expand all
            </button>
            <button type="button" className="secondary" onClick={() => setAll(false)}>
              Collapse all
            </button>
          </>
        ) : undefined
      }
    >
      <ErrorNote error={chart.error} />
      {chart.isPending && <p className="hint">Loading the chart…</p>}
      {chart.isSuccess && people === 0 && <Empty>No one employed today is visible to you.</Empty>}
      {chart.isSuccess && people > 0 && (
        <>
          <div className="org-stats" aria-label="Chart summary">
            <span>
              <strong>{people}</strong> people
            </span>
            <span>
              <strong>{managers}</strong> with a team
            </span>
            <span>
              <strong>{tree.roots.length}</strong> at the top
            </span>
            <span>
              Widest team <strong>{widest}</strong>
            </span>
            <span className="hint">As of {formatDate(chart.data.asOf)}</span>
          </div>
          <label className="org-search">
            Find a person
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, code, designation, department or location" />
          </label>
          {chart.data.truncated && (
            <p role="status" className="hint">
              The chart shows the first {people} people only. Use the employee list or a report for the rest.
            </p>
          )}
          {shown && shown.size === 0 ? (
            <Empty>No one matches “{search.trim()}”.</Empty>
          ) : (
            <ul role="tree" aria-label="Organisation chart" className="org-tree">
              {roots.map((r) => (
                <Branch key={r.id} node={r} tree={tree} open={open} toggle={toggle} visible={visible} query={query} linked={linked} depth={1} />
              ))}
            </ul>
          )}
          <p className="hint">
            Everyone employed today (on probation, confirmed or serving notice) with their manager on {formatDate(chart.data.asOf)}. People whose manager is outside
            what you may see, or who have none, start a branch.
          </p>
        </>
      )}
    </Section>
  );
}
