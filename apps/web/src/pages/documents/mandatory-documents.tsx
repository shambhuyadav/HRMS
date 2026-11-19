// Mandatory document types and the employee document compliance report (CL-150; FR-010; FR-056).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, ApiError, formatDate, isForbidden, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, NotPermitted, Section } from '../../ui';
import { keepOnPage, ReportExport } from '../leave-admin';
import { Refusal, type Words } from './refusals';
import { SCROLL, SR_ONLY } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Mandatory document types and the employee document compliance report (CL-150; FR-010; FR-056; migration 0261;
// modules/documents/requirements.ts and compliance.ts). HR keeps which document types every employee (or every employee of
// one employment type) must hold, as dated configuration: a requirement starts today or later and is ended, never edited or
// deleted, with a reason. The report lists the employees in the role's scope who miss a mandatory type, as on a day; it needs
// its own confidential export right (who lacks which document comes from their confidential documents).
// ---------------------------------------------------------------------------------------------------------
export const REQUIREMENT_READ = 'document_requirement.read.operational';
const REQUIREMENT_MANAGE = 'document_requirement.manage.operational';
const COMPLIANCE_EXPORT = 'document_compliance.export.document';
const ORG_READ = 'org_master.read.operational';
export const REQUIREMENTS_PATH = '/documents/mandatory-types';

interface CodeLabel {
  code: string;
  label: string;
}
/** A mandatory document type as GET /v1/document-requirements lists it. */
interface Requirement {
  id: string;
  documentType: CodeLabel;
  employmentType: CodeLabel | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  inForceToday: boolean;
  reason: string;
  endReason: string | null;
  version: number;
}
interface RequirementList {
  businessDate: string;
  items: Requirement[];
  options: { documentTypes: CodeLabel[]; employmentTypes: CodeLabel[] };
}

const REQUIREMENT_WORDS: Words = {
  EFFECTIVE_DATE_IN_PAST: 'Choose today or a later date: earlier days keep the rules they had.',
  OVERLAPPING_REQUIREMENT: 'This document type is already mandatory for these employees over an overlapping period. End that requirement first, or start this one after it ends.',
  INVALID_REFERENCE: 'The document type or employment type is unknown or no longer active. Reload the page and choose again.',
  ALREADY_ENDED: 'This requirement has already ended.',
  VERSION_CONFLICT: 'This requirement changed since the page loaded it. It has been reloaded: check it and try again.',
  FORBIDDEN: 'The selected role cannot change mandatory document types: that needs the duty in an unrestricted company-scope assignment.',
};

function requirementState(r: Requirement, today: string): string {
  if (r.effectiveTo !== null && r.effectiveTo <= r.effectiveFrom) return 'withdrawn before it started';
  if (r.inForceToday) return r.effectiveTo ? `in force until ${formatDate(r.effectiveTo)} (last day the day before)` : 'in force';
  if (r.effectiveFrom > today) return `starts on ${formatDate(r.effectiveFrom)}`;
  return `ended on ${formatDate(r.effectiveTo)}`;
}

export function MandatoryDocumentsScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Mandatory documents</h1>
      {can(REQUIREMENT_READ) ? (
        <MandatoryTypes />
      ) : (
        <Section title="Mandatory document types">
          <NotPermitted>The selected role cannot read the mandatory document types.</NotPermitted>
        </Section>
      )}
      {can(COMPLIANCE_EXPORT) ? (
        <ComplianceReportForm />
      ) : (
        <Section title="Employee document compliance">
          <NotPermitted>The compliance report needs its own confidential grant: which employee lacks which document comes from their confidential documents.</NotPermitted>
        </Section>
      )}
    </>
  );
}

function MandatoryTypes() {
  const { can, stored } = useSession();
  const qc = useQueryClient();
  const key = ['documents', `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`, 'requirements'] as const;
  const list = useQuery({ queryKey: key, queryFn: () => api<RequirementList>('/v1/document-requirements'), retry: retryTransient });
  const [ending, setEnding] = useState<Requirement | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reload = () => void qc.invalidateQueries({ queryKey: key });
  const data = list.data;
  const canManage = can(REQUIREMENT_MANAGE);
  return (
    <Section title="Mandatory document types">
      <p className="hint">
        Each employee must hold a document of every type in force for them: the company-wide ones and those of their employment type. A requirement starts today or later and is ended with a
        reason; it is never edited or deleted, so earlier days keep the rules they had.
      </p>
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
      {list.isPending && <p className="hint loading">Loading the mandatory document types…</p>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot read the mandatory document types.</NotPermitted> : <ErrorNote error={list.error} />}
      {data && data.items.length === 0 && <Empty>No document type is mandatory yet.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Mandatory document types">
            <thead>
              <tr>
                <th scope="col">Document type</th>
                <th scope="col">Employees</th>
                <th scope="col">From</th>
                <th scope="col">Status</th>
                <th scope="col">Reason</th>
                {canManage && (
                  <th scope="col">
                    <span style={SR_ONLY}>Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id}>
                  <td>{r.documentType.label}</td>
                  <td>{r.employmentType ? `${r.employmentType.label} only` : 'All employment types'}</td>
                  <td>{formatDate(r.effectiveFrom)}</td>
                  <td>
                    <Badge tone={r.inForceToday ? 'good' : 'neutral'}>{requirementState(r, data.businessDate)}</Badge>
                  </td>
                  <td>
                    {r.reason}
                    {r.endReason && <div className="hint">{`Ended: ${r.endReason}`}</div>}
                  </td>
                  {canManage && (
                    <td>
                      {r.effectiveTo === null && (
                        <button
                          type="button"
                          className="secondary"
                          aria-label={`End the requirement for ${r.documentType.label}${r.employmentType ? ` (${r.employmentType.label})` : ''}`}
                          onClick={() => {
                            setEnding(r);
                            setNotice(null);
                          }}
                        >
                          End
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && canManage && ending && (
        <EndRequirementForm
          key={ending.id}
          requirement={ending}
          today={data.businessDate}
          onCancel={() => setEnding(null)}
          onDone={(text) => {
            setEnding(null);
            setNotice(text);
            reload();
          }}
          onStale={reload}
        />
      )}
      {data && canManage && (
        <AddRequirementForm
          list={data}
          onDone={(text) => {
            setNotice(text);
            reload();
          }}
        />
      )}
    </Section>
  );
}

function AddRequirementForm({ list, onDone }: { list: RequirementList; onDone: (text: string) => void }) {
  const [documentType, setDocumentType] = useState('');
  const [employmentType, setEmploymentType] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(list.businessDate);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, string>) => api<Requirement>('/v1/document-requirements', { body }),
    onSuccess: (r) => {
      onDone(`${r.documentType.label} is mandatory for ${r.employmentType ? `${r.employmentType.label} employees` : 'every employee'} from ${formatDate(r.effectiveFrom)}.`);
      setDocumentType('');
      setEmploymentType('');
      setReason('');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    if (!documentType) return setProblem('Choose the document type.');
    if (!effectiveFrom || effectiveFrom < list.businessDate) return setProblem('Choose today or a later start date.');
    if (!reason.trim()) return setProblem('Say why the document type becomes mandatory.');
    setProblem(null);
    save.mutate({ documentType, ...(employmentType ? { employmentType } : {}), effectiveFrom, reason: reason.trim() });
  };
  return (
    <form className="grid-form" aria-label="New mandatory document type" onSubmit={submit} noValidate>
      <h3>Make a document type mandatory</h3>
      <label>
        Document type
        <select value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
          <option value="">Choose…</option>
          {list.options.documentTypes.map((o) => (
            <option key={o.code} value={o.code}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        For
        <select value={employmentType} onChange={(e) => setEmploymentType(e.target.value)}>
          <option value="">All employment types</option>
          {list.options.employmentTypes.map((o) => (
            <option key={o.code} value={o.code}>
              {`${o.label} only`}
            </option>
          ))}
        </select>
      </label>
      <label>
        Starts on
        <input type="date" value={effectiveFrom} min={list.businessDate} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </label>
      <label>
        Reason
        <input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
      </label>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={save.isPending}>
          Make it mandatory
        </button>
      </div>
      <Refusal error={save.error} words={REQUIREMENT_WORDS} />
    </form>
  );
}

function EndRequirementForm({ requirement: r, today, onCancel, onDone, onStale }: { requirement: Requirement; today: string; onCancel: () => void; onDone: (text: string) => void; onStale: () => void }) {
  const [effectiveTo, setEffectiveTo] = useState(today);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api<Requirement>(`/v1/document-requirements/${r.id}/end`, { body: { effectiveTo, reason: reason.trim(), expectedVersion: r.version } }),
    onSuccess: (ended) => onDone(`${ended.documentType.label} is no longer mandatory from ${formatDate(ended.effectiveTo)}${ended.employmentType ? ` for ${ended.employmentType.label} employees` : ''}.`),
    onError: (err) => {
      if (err instanceof ApiError && (err.code === 'VERSION_CONFLICT' || err.code === 'ALREADY_ENDED')) onStale();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    if (!effectiveTo || effectiveTo < today) return setProblem('Choose today or a later date.');
    if (!reason.trim()) return setProblem('Say why the requirement ends.');
    setProblem(null);
    save.mutate();
  };
  return (
    <form className="grid-form" aria-label="End a mandatory document type" onSubmit={submit} noValidate>
      <h3>{`End: ${r.documentType.label}${r.employmentType ? ` (${r.employmentType.label} only)` : ''}`}</h3>
      <label>
        No longer mandatory from
        <input type="date" value={effectiveTo} min={today} onChange={(e) => setEffectiveTo(e.target.value)} />
      </label>
      <label>
        Reason
        <input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
      </label>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={save.isPending}>
          End the requirement
        </button>
        <button type="button" className="secondary" disabled={save.isPending} onClick={onCancel}>
          Keep it
        </button>
      </div>
      <Refusal error={save.error} words={REQUIREMENT_WORDS} />
    </form>
  );
}

/** The report's filters (compliance.ts): department, location, employee status, as on a day; generated in the background. */
function ComplianceReportForm() {
  const { can } = useSession();
  const canOrg = can(ORG_READ);
  const departments = useQuery({ queryKey: ['compliance-departments'], queryFn: () => api<{ items: { id: string; code: string; name: string }[] }>('/v1/org/departments'), enabled: canOrg, retry: retryTransient });
  const locations = useQuery({ queryKey: ['compliance-locations'], queryFn: () => api<{ items: { id: string; code: string; name: string }[] }>('/v1/org/locations'), enabled: canOrg, retry: retryTransient });
  const [departmentId, setDepartmentId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [statusGroup, setStatusGroup] = useState('ACTIVE');
  const [asOn, setAsOn] = useState('');
  const filters: Record<string, string> = {
    ...(departmentId ? { departmentId } : {}),
    ...(locationId ? { locationId } : {}),
    ...(statusGroup && statusGroup !== 'ACTIVE' ? { statusGroup } : {}),
    ...(asOn ? { to: asOn } : {}),
  };
  return (
    <Section title="Employee document compliance">
      <p className="hint">
        The employees in the selected role’s scope who miss a mandatory document type, with the missing types and their count. A rejected, expired or quarantined document does not count; one
        waiting for its scan or verification does. Generated as a file in the background, then downloaded here or from Reports.
      </p>
      <form className="grid-form" aria-label="Compliance report filters" onSubmit={keepOnPage}>
        {canOrg && (
          <>
            <label>
              Department
              <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">All departments in scope</option>
                {(departments.data?.items ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Location
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">All locations in scope</option>
                {(locations.data?.items ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label>
          Employees
          <select value={statusGroup} onChange={(e) => setStatusGroup(e.target.value)}>
            <option value="ACTIVE">Active (probation, confirmed, notice)</option>
            <option value="ON_PROBATION">On probation</option>
            <option value="ON_NOTICE">On notice</option>
            <option value="LEFT">Left</option>
          </select>
        </label>
        <label>
          As on (blank: today)
          <input type="date" value={asOn} onChange={(e) => setAsOn(e.target.value)} />
        </label>
      </form>
      <ReportExport reportCode="EMPLOYEE_DOCUMENT_COMPLIANCE" filters={filters} label="Generate the compliance report" />
    </Section>
  );
}

