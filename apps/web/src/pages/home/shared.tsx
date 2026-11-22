// Shared parts of the home pages: code words, a flattened row and the simple table with its value format.

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate } from '../../api';

export const words = (code: string) => code.replace(/_/g, ' ').toLowerCase();

/** A row as a table shows it: one level of nesting opened up, and record references left out. */
export function flatRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) for (const [inner, v] of Object.entries(value)) out[`${key}.${inner}`] = v;
    else out[key] = value;
  }
  return Object.fromEntries(Object.entries(out).filter(([k]) => !/(^|\.)(id|version|[a-z]+Id)$/.test(k)));
}

export function SimpleTable({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = Object.keys(rows[0] ?? {});
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((c) => (
            <TableHead key={c} scope="col">
              {c}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i}>
            {columns.map((c) => (
              <TableCell key={c}>{format(r[c])}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function format(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return formatDate(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
