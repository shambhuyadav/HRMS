// User to employee links (§5.1; DB007): the links of one account, ending one with a reason, and a new link. A link grants no
// permission by itself; role assignments stay on the access page. Every call is re-checked by the server.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, formatDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section } from '../../ui';
import { type CompanyUser, LINK_USER, ONE_LINE, type UserLink } from './shared';

/** The reason step of a row action, in place of its button: the field and its two buttons on one line, bottoms aligned. */
const REASON_FORM = 'flex flex-wrap items-end gap-2';

/** A row action that asks for a reason. The button shows just the verb; its accessible name (and the form's) says which row. */
export function ReasonAction({ verb, label, onSubmit, pending, danger }: { verb: string; label: string; onSubmit: (reason: string) => void; pending: boolean; danger?: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <Button type="button" variant={danger ? 'danger' : 'outline'} size="sm" aria-label={label} onClick={() => setOpen(true)}>
        {verb}
      </Button>
    );
  }
  return (
    <form
      className={REASON_FORM}
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(reason.trim());
      }}
    >
      <FormField className="w-auto">
        Reason <Input required maxLength={500} className="w-52" value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>{' '}
      <Button type="submit" disabled={pending || reason.trim() === ''}>
        Confirm
      </Button>{' '}
      <Button type="button" variant="outline" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

/** The links of the account chosen in the list, each ended with a reason while it is in force or open-ended. */
export function AccountLinks({ account, onChanged }: { account: CompanyUser; onChanged: () => void }) {
  const { can } = useSession();
  const links = useQuery({
    queryKey: ['user-links', account.userId],
    queryFn: () => api<{ items: UserLink[]; total: number }>(`/v1/access/user-links?userId=${account.userId}&pageSize=100`),
  });
  const endLink = useMutation({
    mutationFn: ({ link, reason }: { link: UserLink; reason: string }) => api(`/v1/access/user-links/${link.id}/end`, { body: { expectedVersion: link.version, reason } }),
    onSuccess: onChanged,
  });
  return (
    <Section title={`Links of ${account.accountKey}`}>
      {links.data?.items.length === 0 && <Empty>This account has no link in this company.</Empty>}
      {links.data && links.data.items.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Employee</TableHead>
              <TableHead scope="col">From</TableHead>
              <TableHead scope="col">Until</TableHead>
              <TableHead scope="col">State</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {links.data.items.map((l) => (
              <TableRow key={l.id}>
                <TableCell>
                  {l.employeeName} ({l.employeeCode})
                </TableCell>
                <TableCell className={ONE_LINE}>{formatDate(l.effectiveFrom)}</TableCell>
                <TableCell className={ONE_LINE}>{l.effectiveTo ? formatDate(l.effectiveTo) : '—'}</TableCell>
                <TableCell>{l.inForce ? 'In force' : 'Not in force'}</TableCell>
                <RowActionsCell>
                  {can(LINK_USER) && (l.inForce || l.effectiveTo === null) && (
                    <RowActions>
                      <ReasonAction key={`${l.id}-${l.version}`} danger verb="End link" label={`End link to ${l.employeeCode}`} pending={endLink.isPending} onSubmit={(reason) => endLink.mutate({ link: l, reason })} />
                    </RowActions>
                  )}
                </RowActionsCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <ErrorNote error={links.error ?? endLink.error} />
    </Section>
  );
}

export function LinkForm({ onDone, accountKey = '' }: { onDone: () => void; accountKey?: string }) {
  const [form, setForm] = useState({ accountKey, employeeCode: '', effectiveFrom: '', effectiveTo: '', reason: '' });
  const link = useMutation({
    mutationFn: async () => {
      // The account is named by its exact key; the employee is found among the employees this administrator can see.
      const found = await api<{ items: { id: string; employeeCode: string }[] }>(`/v1/employees?pageSize=100&search=${encodeURIComponent(form.employeeCode.trim())}`);
      const employee = found.items.find((e) => e.employeeCode === form.employeeCode.trim().toUpperCase());
      if (!employee) throw new ApiError(422, 'UNKNOWN_EMPLOYEE', 'No employee with that code in your scope');
      return api('/v1/access/user-links', {
        body: {
          accountKey: form.accountKey.trim(),
          employeeId: employee.id,
          effectiveFrom: form.effectiveFrom,
          ...(form.effectiveTo ? { effectiveTo: form.effectiveTo } : {}),
          ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
        },
      });
    },
    onSuccess: () => {
      setForm({ accountKey: '', employeeCode: '', effectiveFrom: '', effectiveTo: '', reason: '' });
      onDone();
    },
  });
  return (
    <FormGrid
      aria-label="Link an account"
      onSubmit={(e) => {
        e.preventDefault();
        link.mutate();
      }}
    >
      <FormField>
        Account key
        <Input required value={form.accountKey} onChange={(e) => setForm({ ...form, accountKey: e.target.value })} />
      </FormField>
      <FormField>
        Employee code
        <Input required value={form.employeeCode} onChange={(e) => setForm({ ...form, employeeCode: e.target.value })} />
      </FormField>
      <FormField>
        From
        <Input type="date" required value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
      </FormField>
      <FormField>
        Until (not included)
        <Input type="date" value={form.effectiveTo} onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })} />
      </FormField>
      <FormField>
        Reason
        <Input value={form.reason} maxLength={500} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
      </FormField>
      <Button type="submit" disabled={link.isPending}>
        Link account
      </Button>
      <Hint className="m-0">A link gives the account no permission. Its role assignments are granted separately.</Hint>
      <ErrorNote error={link.error} />
    </FormGrid>
  );
}
