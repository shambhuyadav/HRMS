// Organisation chart (coverage CL-023 "Org Structure", under FR-001 and FR-003): GET /v1/org/chart gives everyone employed today whom
// the requester may list (HR the company, a manager their team, BR-026), each with their manager on that day. The tree is built here:
// people whose manager is not in the answer (or who have none) are its top. A search keeps the matches and the line above them.
// Read-only; the server decides who is on it.
// The tree keeps its own drawing in styles.css ("Organisation chart": .org-tree, .org-children, .org-item, .org-toggle, .org-card):
// the lines joining a person to their team are placed against the toggle and card sizes set there, so those parts keep their
// classes. What surrounds the tree (the summary, the search, the buttons, the notes, the team badge) is drawn with shadcn here.
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ButtonRow, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

/** The chart's summary: a tinted strip of figures, wrapping on a narrow screen, the date at its end. */
const SUMMARY_STRIP = 'mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-2 rounded-md border border-border bg-accent px-4 py-[0.8rem] text-[0.88rem] text-muted-foreground';

/** Whom a list without teams reports to, in the summary's words. */
function teamWords(reportToViewer: boolean, commonManager: string | null): string {
  if (reportToViewer) return 'all report to you';
  if (commonManager) return 'all with the same manager';
  return 'none with a team of their own';
}

/** A figure of the summary, in the text colour and a little larger than the words beside it. */
function Figure({ children }: { children: ReactNode }) {
  return <strong className="mr-[0.15rem] text-[1.05rem] text-foreground">{children}</strong>;
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
      {/* Team size is information, not an alert: an info badge, not the brand red. Left out on a phone, where the card is narrow. */}
      {team > 0 && (
        <Badge variant="info" className="font-semibold phone:hidden" title={`${team} direct, ${below} in all`}>
          {team} direct{below > team ? ` · ${below} in all` : ''}
        </Badge>
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
        {/* A native button drawn by styles.css: the branch line is centred on its 26px circle, so it keeps that size on a phone too. */}
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
  const { can, me } = useSession();
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
  // Nobody in view has a team of their own (a manager seeing their direct team): a list, not a tree — no levels to open, and
  // "at the top" would only count everyone again. When they all report to the viewer, it says so.
  const flat = people > 0 && managers === 0;
  const commonManager = flat && tree.roots.every((r) => r.managerId === tree.roots[0]!.managerId) ? tree.roots[0]!.managerId : null;
  const reportToViewer = commonManager !== null && commonManager === me?.employeeId;

  return (
    <Section
      title="Organisation chart"
      actions={
        people > 0 && !shown && !flat ? (
          <ButtonRow>
            <Button type="button" variant="outline" size="sm" onClick={() => setAll(true)}>
              Expand all
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setAll(false)}>
              Collapse all
            </Button>
          </ButtonRow>
        ) : undefined
      }
    >
      <ErrorNote error={chart.error} />
      {chart.isPending && <LoadingLine>Loading the chart…</LoadingLine>}
      {chart.isSuccess && people === 0 && <Empty>No one employed today is visible to you.</Empty>}
      {chart.isSuccess && people > 0 && (
        <>
          <div className={SUMMARY_STRIP} aria-label="Chart summary">
            <span>
              <Figure>{people}</Figure> {people === 1 ? 'person' : 'people'}
            </span>
            {flat ? (
              <span>{teamWords(reportToViewer, commonManager)}</span>
            ) : (
              <>
                <span>
                  <Figure>{managers}</Figure> with a team
                </span>
                <span>
                  <Figure>{tree.roots.length}</Figure> at the top
                </span>
                <span>
                  Widest team <Figure>{widest}</Figure>
                </span>
              </>
            )}
            <Hint as="span" className="ml-auto phone:ml-0">
              As of {formatDate(chart.data.asOf)}
            </Hint>
          </div>
          <FormField className="mb-4 max-w-[460px]">
            Find a person
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, code, designation, department or location" />
          </FormField>
          {chart.data.truncated && <Hint role="status">The chart shows the first {people} people only. Use the employee list or a report for the rest.</Hint>}
          {shown && shown.size === 0 ? (
            <Empty>No one matches “{search.trim()}”.</Empty>
          ) : (
            <ul role="tree" aria-label="Organisation chart" className="org-tree">
              {roots.map((r) => (
                <Branch key={r.id} node={r} tree={tree} open={open} toggle={toggle} visible={visible} query={query} linked={linked} depth={1} />
              ))}
            </ul>
          )}
          <Hint>
            {flat
              ? `Everyone employed today (on probation, confirmed or serving notice) that you may see, as of ${formatDate(chart.data.asOf)}.`
              : `Everyone employed today (on probation, confirmed or serving notice) with their manager on ${formatDate(chart.data.asOf)}. People whose manager is outside what you may see, or who have none, start a branch.`}
          </Hint>
        </>
      )}
    </Section>
  );
}
