// The handover of an accepted offer to a reviewed employee draft (FR-014), and the employee's hiring origin.
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, CheckField, FormField, FormGrid, LabelledFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, ApiError, formatDate, isConflict, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, NotPermitted, Section } from '../../ui';
import { HANDOVER_WORDS, LoadProblem, Refusal } from './refusals';
import {
  APPLICATION_READ,
  CANDIDATE_READ,
  CodeBadge,
  COMPENSATION_READ,
  DEFAULT_EMPLOYEE_DOCUMENT_TYPE,
  Denied,
  DOCUMENT_READ,
  DOCUMENT_TYPE_CODE,
  DOCUMENT_TYPE_LABEL,
  EMPLOYEE_CREATE,
  EMPLOYEE_DOCUMENT_READ,
  EMPLOYEE_DOCUMENT_UPLOAD,
  EMPLOYEE_READ,
  EMPLOYEE_STATUS_LABEL,
  EMPLOYEE_TONE,
  enc,
  labelOf,
  MAX_HANDOVER_DOCUMENTS,
  Missing,
  OFFER_READ,
  OFFER_STATE_LABEL,
  PATHS,
  Problem,
  ScanBadge,
  STAGE_LABEL,
  useKeys,
  useRefresh,
  UUID,
} from './shared';
import type { CandidateDocument, EmployeeRecord, HandoverResult, OfferView, Origin } from './types';

// ---------------------------------------------------------------------------------------------------------
// FR-014 handover: a reviewed employee DRAFT from validated fields and approved documents, at most once per offer
// ---------------------------------------------------------------------------------------------------------

export function HandoverSection({ offer: o, busy, onDone }: { offer: OfferView; busy: boolean; onDone: (result: HandoverResult) => void }) {
  const { can } = useSession();
  return (
    <Section title="Hand over to onboarding">
      {can(EMPLOYEE_CREATE) ? (
        <HandoverForm offer={o} busy={busy} onDone={onDone} />
      ) : (
        <NotPermitted>Handing over creates an employee, so it also needs the employee creation duty, which the selected role does not hold.</NotPermitted>
      )}
    </Section>
  );
}

interface HandoverBody {
  employeeCode: string;
  displayName?: string;
  workEmail?: string;
  documents?: { candidateDocumentId: string; documentType: string }[];
}

type ChosenDocument = { candidateDocumentId: string; documentType: string };

/** The checks made before sending: a code, and a valid employee document type on each of at most so many documents. */
function handoverProblem(code: string, documents: ChosenDocument[]): string | null {
  if (!code) return 'Enter the new employee’s code.';
  if (documents.length > MAX_HANDOVER_DOCUMENTS) return `Choose at most ${MAX_HANDOVER_DOCUMENTS} documents to transfer.`;
  if (documents.some((d) => !DOCUMENT_TYPE_CODE.test(d.documentType))) return 'Give each chosen document an employee document type: capital letters, digits or _, for example GENERAL.';
  return null;
}

function HandoverForm({ offer: o, busy, onDone }: { offer: OfferView; busy: boolean; onDone: (result: HandoverResult) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const refresh = useRefresh();
  const id = useId();
  const withDocuments = can(DOCUMENT_READ) && can(EMPLOYEE_DOCUMENT_UPLOAD);
  const docs = useQuery({
    queryKey: keys.documents(o.candidate.id),
    enabled: withDocuments,
    queryFn: () => api<{ items: CandidateDocument[] }>(`/v1/hiring/candidates/${enc(o.candidate.id)}/documents`),
    retry: retryTransient,
  });
  const [employeeCode, setEmployeeCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [workEmail, setWorkEmail] = useState('');
  /** The documents chosen for transfer, in the order chosen, each with its employee document type. */
  const [chosen, setChosen] = useState<ChosenDocument[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const handover = useMutation({
    mutationFn: (body: HandoverBody) => api<HandoverResult>(`/v1/hiring/offers/${enc(o.id)}/handover`, { body }),
    onSuccess: (result) => {
      setEmployeeCode('');
      setDisplayName('');
      setWorkEmail('');
      setChosen([]);
      setProblem(null);
      onDone(result);
    },
    onError: (error) => {
      if (isConflict(error)) refresh();
    },
  });
  const toggle = (docId: string, on: boolean) =>
    setChosen((list) => (on ? [...list.filter((d) => d.candidateDocumentId !== docId), { candidateDocumentId: docId, documentType: DEFAULT_EMPLOYEE_DOCUMENT_TYPE }] : list.filter((d) => d.candidateDocumentId !== docId)));
  const setType = (docId: string, type: string) => setChosen((list) => list.map((d) => (d.candidateDocumentId === docId ? { ...d, documentType: type.toUpperCase() } : d)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (handover.isPending || busy) return;
    const code = employeeCode.trim();
    const documents = chosen.map((d) => ({ candidateDocumentId: d.candidateDocumentId, documentType: d.documentType.trim().toUpperCase() }));
    const missing = handoverProblem(code, documents);
    setProblem(missing);
    if (missing) {
      handover.reset();
      return;
    }
    handover.mutate({
      employeeCode: code,
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      ...(workEmail.trim() ? { workEmail: workEmail.trim() } : {}),
      ...(documents.length > 0 ? { documents } : {}),
    });
  };
  const already = handover.error instanceof ApiError && handover.error.code === 'ALREADY_HANDED_OVER' ? (handover.error.details as { employeeId?: string } | undefined)?.employeeId : undefined;
  const items = docs.data?.items ?? [];
  return (
    <FormGrid aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
      <CardSubheading id={`${id}-title`}>Create the employee draft</CardSubheading>
      <Hint>
        The employee is created as a draft from the approved requisition (department, location, designation and employment type) and this accepted offer (joining
        date {formatDate(o.proposedJoiningDate)}). Hiring never activates employment: activation is the separate employee activation action. An accepted offer
        creates at most one employee.
      </Hint>
      <FormField>
        Employee code (required)
        <Input required maxLength={40} value={employeeCode} onChange={(e) => setEmployeeCode(e.target.value)} />
      </FormField>
      <FormField>
        Display name (optional)
        <Input maxLength={200} value={displayName} placeholder={o.candidate.fullName} onChange={(e) => setDisplayName(e.target.value)} />
      </FormField>
      <FormField>
        Work email (optional)
        <Input type="email" maxLength={254} value={workEmail} onChange={(e) => setWorkEmail(e.target.value)} />
      </FormField>
      <Hint>A blank display name uses the candidate’s name, {o.candidate.fullName}.</Hint>
      {withDocuments ? (
        <LabelledFieldset legend="Candidate documents to transfer (optional)">
          {docs.isPending && <LoadingLine>Loading the candidate’s documents…</LoadingLine>}
          <LoadProblem error={docs.error} forbidden="The selected role cannot read this candidate’s documents." />
          {docs.data && items.length === 0 && <Empty>The candidate has no documents.</Empty>}
          {items.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-[0.6rem] p-0" aria-label="Candidate documents">
              {items.map((d) => (
                <DocumentChoice key={d.id} document={d} pick={chosen.find((x) => x.candidateDocumentId === d.id)} onToggle={toggle} onType={setType} />
              ))}
            </ul>
          )}
        </LabelledFieldset>
      ) : (
        <Hint>Transferring candidate documents needs the candidate document read and employee document upload grants.</Hint>
      )}
      <Problem text={problem} />
      {handover.error && (
        <div className="col-span-full">
          <Refusal error={handover.error} words={HANDOVER_WORDS} />
          {already && <Link to={PATHS.origin(already)}>Open the employee created from this offer</Link>}
        </div>
      )}
      <ButtonRow className="col-span-full">
        <Button type="submit" disabled={handover.isPending || busy}>
          Create employee draft
        </Button>
      </ButtonRow>
    </FormGrid>
  );
}

/** One candidate document of the handover: a released file can be chosen and given its employee document type; any other cannot. */
function DocumentChoice({
  document: d,
  pick,
  onToggle,
  onType,
}: {
  document: CandidateDocument;
  pick: ChosenDocument | undefined;
  onToggle: (docId: string, on: boolean) => void;
  onType: (docId: string, type: string) => void;
}) {
  const name = d.fileName ?? labelOf(DOCUMENT_TYPE_LABEL, d.documentType);
  return (
    <li className="flex flex-col gap-2">
      {d.scanState === 'CLEAN' ? (
        <CheckField>
          <input type="checkbox" checked={pick !== undefined} onChange={(e) => onToggle(d.id, e.target.checked)} /> {name} ({labelOf(DOCUMENT_TYPE_LABEL, d.documentType)})
        </CheckField>
      ) : (
        <span>
          {name} <ScanBadge state={d.scanState} /> <Hint as="span">only released files can be transferred</Hint>
        </span>
      )}
      {pick && (
        <FormField>
          Employee document type for {name}
          <Input required maxLength={60} value={pick.documentType} onChange={(e) => onType(d.id, e.target.value)} />
        </FormField>
      )}
    </li>
  );
}

export function Onboarding({ employeeId }: { employeeId: string }) {
  const { can } = useSession();
  return (
    <Section title="Onboarding">
      <p>
        Handed over to onboarding: this accepted offer created an employee draft. Hiring never activates employment; activation is the separate employee
        activation action.
      </p>
      {can(APPLICATION_READ) && (
        <p>
          <Link to={PATHS.origin(employeeId)}>Open the employee’s hiring record</Link>
        </p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// FR-014: the onboarding record traces back to its requisition, application, offer and candidate
// ---------------------------------------------------------------------------------------------------------

export function EmployeeOriginScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(APPLICATION_READ)) return <Denied title="Hiring origin">The selected role cannot view the hiring pipeline.</Denied>;
  if (!UUID.test(id)) return <Missing title="Hiring origin">This employee is not available in the selected role’s scope.</Missing>;
  return <EmployeeOrigin key={id} employeeId={id} />;
}

function EmployeeOrigin({ employeeId }: { employeeId: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const origin = useQuery({ queryKey: keys.origin(employeeId), queryFn: () => api<Origin>(`/v1/hiring/employees/${enc(employeeId)}/origin`), retry: retryTransient });
  const employee = useQuery({
    queryKey: keys.employee(employeeId),
    enabled: can(EMPLOYEE_READ),
    queryFn: () => api<EmployeeRecord>(`/v1/employees/${enc(employeeId)}`),
    retry: retryTransient,
  });
  const e = employee.data;
  const h = origin.data;
  const documentsLink = can(EMPLOYEE_DOCUMENT_READ) || can(EMPLOYEE_DOCUMENT_UPLOAD);
  return (
    <>
      <h1>{e ? `Hiring origin of ${e.displayName} (${e.employeeCode})` : 'Hiring origin'}</h1>
      {can(EMPLOYEE_READ) && (
        <Section title="Employee record">
          {employee.isPending && <LoadingLine>Loading the employee…</LoadingLine>}
          <LoadProblem error={employee.error} forbidden="The selected role cannot view this employee." missing="This employee is not available in the selected role’s scope." />
          {e && (
            <>
              <dl className="kv">
                <Item term="Employee code">{e.employeeCode}</Item>
                <Item term="Name">{e.displayName}</Item>
                <Item term="Status">
                  <CodeBadge code={e.status} labels={EMPLOYEE_STATUS_LABEL} tones={EMPLOYEE_TONE} />
                </Item>
                <Item term="Joining date">{formatDate(e.joiningDate)}</Item>
                <Item term="Employment type">{labelOf({}, e.employmentType)}</Item>
                <Item term="Work email">{e.workEmail ?? '—'}</Item>
              </dl>
              {e.status === 'DRAFT' && <Hint>This employee is a draft. Hiring never activates employment: activation is the separate employee activation action.</Hint>}
            </>
          )}
          {documentsLink && (
            <p>
              <Link to={PATHS.employeeDocuments(employeeId)}>Employee documents</Link>
            </p>
          )}
        </Section>
      )}
      <Section title="Recruitment history">
        {origin.isPending && <LoadingLine>Loading the hiring origin…</LoadingLine>}
        <LoadProblem error={origin.error} forbidden="The selected role cannot view the hiring origin." missing="No hiring origin is recorded for this employee in the selected role’s scope." />
        {h && (
          <dl className="kv">
            <Item term="Requisition">
              <Link to={PATHS.requisitionApplications(h.requisition.id)}>{h.requisition.code}</Link> <Hint as="span">{h.requisition.title}</Hint>
            </Item>
            <Item term="Application">
              <Link to={PATHS.application(h.application.id)}>{labelOf(STAGE_LABEL, h.application.stage)}</Link>
            </Item>
            <Item term="Offer">
              {can(OFFER_READ) || can(COMPENSATION_READ) ? (
                <Link to={PATHS.offer(h.offer.id)}>{labelOf(OFFER_STATE_LABEL, h.offer.state)}</Link>
              ) : (
                labelOf(OFFER_STATE_LABEL, h.offer.state)
              )}{' '}
              <Hint as="span">joining {formatDate(h.offer.proposedJoiningDate)}</Hint>
            </Item>
            <Item term="Candidate">{can(CANDIDATE_READ) ? <Link to={PATHS.candidate(h.candidate.id)}>{h.candidate.candidateCode}</Link> : h.candidate.candidateCode}</Item>
            <Item term="Handed over">{formatDate(h.handedOverAt)}</Item>
            <Item term="Documents transferred">{h.documents.length}</Item>
          </dl>
        )}
      </Section>
    </>
  );
}
