// Restricted HR notes, remarks and warnings about an employee (FR-018), with the note form.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, ApiError, formatDate, localDateTime, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, LIST_PAGE_SIZE, Pager, Section, When } from '../../ui';
import { Refusal } from './refusals';
import { AbscondingMark, FIELDS, FLUSH, H3, Loading, MAX_NOTE, NOTE_KINDS, NOTE_READ, NOTE_WRITE, noteTypeText, Notice, type NoticeState, type Paged, pagedUrl, Problem, QueryProblem, ReasonField, shown, totalOf, useKeys, userText } from './shared';
import type { ExitCase, NoteBody, NoteItem, NoteKind, ProcessSummary } from './types';

// ---------------------------------------------------------------------------------------------------------
// Restricted HR notes, remarks and warnings (FR-018): their own confidential grants, never about one's own record;
// append-only, a correction supersedes the earlier note.
// ---------------------------------------------------------------------------------------------------------
export function RestrictedNotes({ employeeId, own, processes, exits }: { employeeId: string; own: boolean; processes: ProcessSummary[]; exits: ExitCase[] }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canRead = can(NOTE_READ);
  const canWrite = can(NOTE_WRITE);
  const [notePage, setNotePage] = useState(1);
  const notes = useQuery({
    enabled: canRead && !own,
    queryKey: [...keys.notes(employeeId), notePage],
    queryFn: () => api<Paged<NoteItem>>(pagedUrl(`/v1/employees/${employeeId}/notes`, notePage)),
    retry: retryTransient,
  });
  const [correcting, setCorrecting] = useState<NoteItem | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [notice, setNotice] = useState<NoticeState>(null);
  if (!canRead && !canWrite) return null;
  if (own) {
    return (
      <Section title="Restricted HR notes">
        <Empty>Notes about your own record are not shown to you, and you cannot add them.</Empty>
      </Section>
    );
  }
  const noteData = shown(notes);
  const items = noteData?.items;
  const linkText = (n: NoteItem) => {
    const parts: string[] = [];
    if (n.processId) {
      const p = processes.find((x) => x.id === n.processId);
      parts.push(p ? `Process: ${p.processName} (${p.processCode})` : 'Linked to a process');
    }
    if (n.exitCaseId) {
      const x = exits.find((e) => e.id === n.exitCaseId);
      parts.push(x ? `Exit: resigned ${formatDate(x.requestDate)}` : 'Linked to an exit');
    }
    return parts.join(' · ');
  };
  return (
    <Section title="Restricted HR notes">
      <p className="hint">Notes, remarks and warnings visible only to authorised HR. They are never changed: a correction is a new note that supersedes the earlier one.</p>
      <Notice notice={notice} />
      {canRead && (
        <>
          {notes.isPending && <Loading>Loading the notes…</Loading>}
          <QueryProblem error={notes.error} forbidden="The selected role cannot read restricted notes." missing="This employee is not in the selected role’s scope." />
          {items && items.length === 0 && <Empty>No notes about this employee.</Empty>}
          {items && items.length > 0 && (
            <ul className="tasks" aria-label="Restricted HR notes">
              {items.map((n) => (
                <li key={n.id}>
                  <div>
                    <Badge tone={n.kind === 'WARNING' ? 'bad' : 'neutral'}>{noteTypeText(n)}</Badge> <When at={n.createdAt} /> by {userText(n.createdBy, me?.userId ?? null)}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                  {(n.processId || n.exitCaseId) && <div className="hint">{linkText(n)}</div>}
                  {n.supersedesNoteId && <div className="hint">Corrects an earlier note.</div>}
                  {n.supersededByNoteId ? (
                    <div className="hint">Corrected by a later note.</div>
                  ) : (
                    canWrite && (
                      <div>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            setCorrecting(n);
                            setFormKey((k) => k + 1);
                          }}
                        >
                          Correct this note
                        </button>
                      </div>
                    )
                  )}
                </li>
              ))}
            </ul>
          )}
          {noteData && <Pager page={notePage} pageSize={LIST_PAGE_SIZE} total={totalOf(noteData)} onPage={setNotePage} label="Note pages" noun="note" />}
        </>
      )}
      {canWrite && (
        <NoteForm
          key={formKey}
          employeeId={employeeId}
          correcting={correcting}
          processes={processes}
          exits={exits}
          onCancel={() => {
            setCorrecting(null);
            setFormKey((k) => k + 1);
          }}
          onSaved={(text) => {
            setNotice({ text, ok: true });
            setCorrecting(null);
            setFormKey((k) => k + 1);
            void qc.invalidateQueries({ queryKey: keys.notes(employeeId) });
          }}
        />
      )}
    </Section>
  );
}

function NoteForm({
  employeeId,
  correcting,
  processes,
  exits,
  onSaved,
  onCancel,
}: {
  employeeId: string;
  correcting: NoteItem | null;
  processes: ProcessSummary[];
  exits: ExitCase[];
  onSaved: (text: string) => void;
  onCancel: () => void;
}) {
  const initialLink = correcting?.processId ? `process:${correcting.processId}` : correcting?.exitCaseId ? `exit:${correcting.exitCaseId}` : '';
  const [kind, setKind] = useState<NoteKind>(correcting && NOTE_KINDS.some(([k]) => k === correcting.kind) ? (correcting.kind as NoteKind) : 'NOTE');
  const [absconding, setAbsconding] = useState(correcting?.warningCategory === 'ABSCONDING');
  const [body, setBody] = useState(correcting?.body ?? '');
  const [link, setLink] = useState(initialLink);
  const [problem, setProblem] = useState<string | null>(null);
  const keys = useKeys();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (note: NoteBody) => api<{ id: string }>(`/v1/employees/${employeeId}/notes`, { body: note }),
    onSuccess: (_r, note) => onSaved(note.supersedesNoteId ? 'Saved the correction; the earlier note is kept and marked as corrected.' : `Saved the ${noteTypeText(note)}.`),
    // A note corrected meanwhile: the list reloads and shows the later correction; what was typed stays.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) void qc.invalidateQueries({ queryKey: keys.notes(employeeId) });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    const text = body.trim();
    if (!text) {
      setProblem('Enter the note.');
      save.reset();
      return;
    }
    setProblem(null);
    const [linkKind, linkId] = link.split(':');
    save.mutate({
      kind,
      ...(kind === 'WARNING' && absconding ? { warningCategory: 'ABSCONDING' as const } : {}),
      body: text,
      ...(linkKind === 'process' && linkId ? { employeeProcessId: linkId } : {}),
      ...(linkKind === 'exit' && linkId ? { exitCaseId: linkId } : {}),
      ...(correcting ? { supersedesNoteId: correcting.id } : {}),
    });
  };
  return (
    <form aria-label={correcting ? 'Correct a note' : 'Add a note'} className="stack" onSubmit={submit}>
      <h3 style={H3}>{correcting ? 'Correct a note' : 'Add a note'}</h3>
      {correcting && (
        <p className="hint" style={FLUSH}>
          Correcting the {noteTypeText(correcting)} of {localDateTime(correcting.createdAt)}: the correction is saved as a new note and the earlier one stays.
        </p>
      )}
      <div style={FIELDS}>
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind((NOTE_KINDS.find(([k]) => k === e.target.value)?.[0] ?? 'NOTE') as NoteKind)}>
            {NOTE_KINDS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {kind === 'WARNING' && <AbscondingMark checked={absconding} onChange={setAbsconding} />}
        <label>
          Linked to
          <select value={link} onChange={(e) => setLink(e.target.value)}>
            <option value="">Not linked</option>
            {processes.map((p) => (
              <option key={p.id} value={`process:${p.id}`}>
                {`Process: ${p.processName} (${p.processCode})`}
              </option>
            ))}
            {exits.map((x) => (
              <option key={x.id} value={`exit:${x.id}`}>
                {`Exit: resigned ${formatDate(x.requestDate)}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ReasonField label="Note (restricted to authorised HR)" value={body} onChange={setBody} max={MAX_NOTE} />
      <Problem text={problem} />
      <div className="row">
        <button type="submit" disabled={save.isPending}>
          {correcting ? 'Save correction' : 'Add note'}
        </button>
        {correcting && (
          <button type="button" className="secondary" disabled={save.isPending} onClick={onCancel}>
            Cancel correction
          </button>
        )}
      </div>
      <Refusal error={save.error} action="note" />
    </form>
  );
}
