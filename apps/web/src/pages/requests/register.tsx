// HR views "Leaves & Outdoor" and "Work On Holiday" (FR-027): the requests within the selected scope, and HR cancelling an
// employee's approved request (I-84 item 15, I-89 item 3).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ButtonRow, FilterBar, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, localDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section, StateBadge } from '../../ui';
import { CELL_FORM, type Kind, KIND_LABEL, useRoleContext, type WorkRequest } from './shared';
import { describeWindow } from './window';

/**
 * I-84 item 15, I-89 item 3: HR cancels an employee's approved request (work_request.cancel, within row scope, never on their own
 * record), with a reason and the version it read. The server decides whether it may: before the first day, or when every day
 * falls after the approved last working date; a request already under way inside employment is corrected through attendance.
 * The cell offers it where `offered`; opened, the form takes the button's place. The column is not narrowed to its button (as
 * row-actions.tsx suggests): the form may open in any row, and one narrow cell would narrow the whole column, the form with it.
 */
function CancelForEmployeeCell({ request: r, offered, onChanged }: { request: WorkRequest; offered: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => api(`/v1/work-requests/${r.kind}/${r.id}/cancel-for-employee`, { body: { reason: reason.trim(), expectedVersion: r.version } }),
    onSuccess: () => {
      setOpen(false);
      setReason('');
      onChanged();
    },
  });
  if (!offered || !open) {
    return (
      <TableCell>
        {offered && (
          <RowActions>
            <Button type="button" variant="danger" size="sm" aria-label={`Cancel ${r.employeeName}'s approved ${KIND_LABEL[r.kind]} request`} onClick={() => setOpen(true)}>
              Cancel for employee
            </Button>
          </RowActions>
        )}
      </TableCell>
    );
  }
  return (
    <TableCell>
      <FormGrid
        className={CELL_FORM}
        aria-label={`Cancel ${r.employeeName}'s approved request`}
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim()) cancel.mutate();
        }}
      >
        <FormField className="col-span-full">
          Reason for cancelling
          <Input required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        <Hint>
          An approved request can be cancelled before its first day, or when every day of it falls after the employee&apos;s approved last working date. Once it has started, its days
          are corrected through an attendance amendment. The employee is told.
        </Hint>
        <ButtonRow>
          <Button type="submit" disabled={!reason.trim() || cancel.isPending}>
            Cancel the request
          </Button>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
        </ButtonRow>
        <ErrorNote error={cancel.error} />
      </FormGrid>
    </TableCell>
  );
}

/** HR views "Leaves & Outdoor" and "Work On Holiday": rows limited by the selected assignment's scope. */
export function WorkRequestRegister() {
  const { me, can } = useSession();
  const qc = useQueryClient();
  // The browser's calendar day, not the UTC one (which is still yesterday for the first hours of an Indian day).
  const today = localDate();
  const [kind, setKind] = useState<Kind>('outdoor_duty');
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const context = useRoleContext();
  const list = useQuery({
    queryKey: ['work-request-register', context, kind, from, to],
    enabled: !!from && !!to,
    queryFn: () => api<{ items: WorkRequest[] }>(`/v1/work-requests/${kind}?from=${from}&to=${to}`),
  });
  // Never on one's own record: the server refuses it, so it is not offered (I-84 item 15).
  const mayCancel = (r: WorkRequest) => can('work_request.cancel.operational') && r.state === 'APPROVED' && !!r.employeeId && r.employeeId !== me?.employeeId;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['work-request-register'] });
    void qc.invalidateQueries({ queryKey: ['work-requests'] });
  };
  return (
    <Section title="Requests in my scope">
      <FilterBar>
        <FormField>
          Type{' '}
          <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="outdoor_duty">{KIND_LABEL.outdoor_duty}</option>
            <option value="holiday_work">{KIND_LABEL.holiday_work}</option>
          </NativeSelect>
        </FormField>
        <FormField>
          From <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </FormField>
        <FormField>
          To <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </FormField>
      </FilterBar>
      {list.data?.items.length === 0 && <Empty>No requests in this period.</Empty>}
      {!!list.data?.items.length && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Employee</TableHead>
              <TableHead scope="col">When</TableHead>
              <TableHead scope="col">Purpose</TableHead>
              <TableHead scope="col">State</TableHead>
              {can('work_request.cancel.operational') && (
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data.items.map((r) => (
              <TableRow key={`${r.kind}:${r.id}`}>
                <TableCell>
                  {r.employeeName} <Hint as="span">{r.employeeCode}</Hint>
                </TableCell>
                <TableCell>{describeWindow(r)}</TableCell>
                <TableCell>{r.purpose}</TableCell>
                <TableCell>
                  <StateBadge state={r.state} />
                </TableCell>
                {can('work_request.cancel.operational') && <CancelForEmployeeCell key={`${r.id}:${r.version}:hr-cancel`} request={r} offered={mayCancel(r)} onChanged={refresh} />}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <ErrorNote error={list.error} />
    </Section>
  );
}
