// Independent review of tax declarations and investment proofs (FR-036, FR-108; the queue is also shown in the decision inbox), the
// register of declarations and proofs, and the Form 16 Part B working data (FR-107).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentPropsWithoutRef, type FormEvent, useState } from 'react';
import { ButtonRow, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, download, formatAmount, idempotencyKey } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Notice, Section, StateBadge } from '../../ui';
import { type Declaration, FIELD_ROW, FIELD_WIDTH, FORM_STACK, ITEM_CARD, notPermitted, type Proof, REVIEW, REVIEW_READ } from './shared';

// =========================================================================================================
// Independent review (queue also shown in the decision inbox)
// =========================================================================================================

function ReviewControls({ url, showAmount, onDone, name }: { url: string; showAmount: boolean; onDone: () => void; name: string }) {
  const [explanation, setExplanation] = useState('');
  const [reason, setReason] = useState('');
  const [acceptedAmount, setAcceptedAmount] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'ACCEPT' | 'REJECT' | 'RETURN') =>
      api(url, {
        body: {
          decision,
          idempotencyKey: idempotencyKey('tax-review'),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          ...(decision !== 'ACCEPT' && explanation.trim() ? { explanation: explanation.trim() } : {}),
          ...(decision === 'ACCEPT' && showAmount && acceptedAmount.trim() ? { acceptedAmount: acceptedAmount.trim() } : {}),
        },
      }),
    onSuccess: () => onDone(),
  });
  return (
    <form className={FORM_STACK} aria-label={`Review ${name}`} onSubmit={(e) => e.preventDefault()}>
      {showAmount && (
        <FormField className={FIELD_WIDTH}>
          Accepted amount
          <Input inputMode="decimal" value={acceptedAmount} onChange={(e) => setAcceptedAmount(e.target.value)} />
        </FormField>
      )}
      <FormField className={FIELD_WIDTH}>
        Explanation the employee sees (needed to return or reject)
        <Textarea value={explanation} onChange={(e) => setExplanation(e.target.value)} maxLength={1000} rows={2} />
      </FormField>
      <FormField className={FIELD_WIDTH}>
        Private reason (never shown to the employee)
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} />
      </FormField>
      <ErrorNote error={decide.error} />
      <ButtonRow>
        <Button type="button" onClick={() => decide.mutate('ACCEPT')} disabled={decide.isPending}>
          Accept
        </Button>
        <Button type="button" variant="outline" onClick={() => decide.mutate('RETURN')} disabled={decide.isPending}>
          Return
        </Button>
        <Button type="button" variant="danger" onClick={() => decide.mutate('REJECT')} disabled={decide.isPending}>
          Reject
        </Button>
      </ButtonRow>
    </form>
  );
}

/** FR-106: only a file the malware scan released is served, so the words say where this one stands. */
function evidenceState(d: Proof['evidence'][number]): string {
  if (d.scanState === 'QUARANTINED') return 'quarantined by the malware scan';
  if (d.scanState !== 'CLEAN') return 'waiting for the malware scan';
  if (d.verificationState === 'VERIFIED') return 'released and verified';
  if (d.verificationState === 'REJECTED') return 'released, rejected by the verifier';
  return 'released, not verified yet';
}

function ProofEvidence({ proofId, evidence }: { proofId: string; evidence: Proof['evidence'][number] }) {
  const open = useMutation({ mutationFn: () => download(`/v1/tax-proofs/${encodeURIComponent(proofId)}/evidence/${encodeURIComponent(evidence.documentId)}`) });
  const refusal = open.error instanceof ApiError && open.error.code === 'FILE_NOT_RELEASED' ? open.error : null;
  return (
    <li>
      <Button type="button" variant="outline" size="sm" disabled={open.isPending} onClick={() => open.mutate()}>
        {`Open ${evidence.documentType}`}
      </Button>
      {` (${evidenceState(evidence)})`}
      {refusal ? <Notice notice={{ text: notReleasedText(refusal), ok: false }} /> : <ErrorNote error={open.error} />}
    </li>
  );
}

/** A file the malware scan has not released (FILE_NOT_RELEASED), in plain words: flagged for good, or still waiting. */
function notReleasedText(refusal: ApiError): string {
  const flagged = (refusal.details as { scanState?: string } | undefined)?.scanState === 'QUARANTINED';
  return flagged ? 'The malware scan flagged this file, so it can never be opened.' : 'This file is still waiting for the malware scan, so it cannot be opened yet. Try again shortly.';
}

/** A declaration or proof waiting for the reviewer: a card inside the queue's card. */
function ReviewCard(props: ComponentPropsWithoutRef<'div'>) {
  return <div className={ITEM_CARD} {...props} />;
}

export function TaxReviewQueue() {
  const { can } = useSession();
  const qc = useQueryClient();
  const declarations = useQuery({ queryKey: ['tax-tasks-declarations'], queryFn: () => api<{ items: { taskId: string; declaration: Declaration }[] }>('/v1/tax-declarations/tasks/mine'), enabled: can(REVIEW) });
  const proofs = useQuery({ queryKey: ['tax-tasks-proofs'], queryFn: () => api<{ items: { taskId: string; proof: Proof }[] }>('/v1/tax-proofs/tasks/mine'), enabled: can(REVIEW) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['tax-tasks-declarations'] });
    void qc.invalidateQueries({ queryKey: ['tax-tasks-proofs'] });
  };
  if (!can(REVIEW)) return notPermitted('The selected role does not review tax declarations.');
  return (
    <Section title="Tax declarations and proofs to review">
      <Hint>Accepting records the review only: no tax is calculated, and nothing reaches payroll.</Hint>
      <ErrorNote error={declarations.error ?? proofs.error} />
      {declarations.data?.items.length === 0 && proofs.data?.items.length === 0 && <Empty>Nothing is waiting for you.</Empty>}
      <div className="flex flex-col gap-3">
        {declarations.data?.items.map(({ taskId, declaration: d }) => (
          <ReviewCard key={taskId} aria-label={`Declaration of ${d.employeeCode}`}>
            <strong>{`${d.employeeName} (${d.employeeCode}): ${d.fiscalPeriodCode}`}</strong>
            <Hint>Regime: {d.regimeCode}</Hint>
            <ul>
              {d.lines.map((l) => (
                <li key={l.categoryCode}>{`${l.categoryCode}: ${formatAmount(l.amount, d.currencyCode)}`}</li>
              ))}
            </ul>
            <ReviewControls url={`/v1/tax-declaration-tasks/${encodeURIComponent(taskId)}/decision`} showAmount={false} onDone={refresh} name={`the declaration of ${d.employeeCode}`} />
          </ReviewCard>
        ))}
        {proofs.data?.items.map(({ taskId, proof: p }) => (
          <ReviewCard key={taskId} aria-label={`Proof of ${p.employeeCode}`}>
            <strong>{`${p.employeeName} (${p.employeeCode}): ${p.categoryCode}, ${formatAmount(p.claimedAmount, p.currencyCode)}`}</strong>
            <ul>
              {p.evidence.map((d) => (
                <ProofEvidence key={d.documentId} proofId={p.id} evidence={d} />
              ))}
            </ul>
            <ReviewControls url={`/v1/tax-proof-tasks/${encodeURIComponent(taskId)}/decision`} showAmount onDone={refresh} name={`the proof of ${p.employeeCode}`} />
          </ReviewCard>
        ))}
      </div>
    </Section>
  );
}

export function TaxReviewScreen() {
  const { can } = useSession();
  const declarations = useQuery({ queryKey: ['tax-review-declarations'], queryFn: () => api<{ items: Declaration[]; total: number }>('/v1/tax-declarations?page=1&pageSize=50'), enabled: can(REVIEW_READ) });
  const proofs = useQuery({ queryKey: ['tax-review-proofs'], queryFn: () => api<{ items: Proof[]; total: number }>('/v1/tax-proofs?page=1&pageSize=50'), enabled: can(REVIEW_READ) });
  return (
    <div className="flex flex-col gap-3">
      {can(REVIEW) && <TaxReviewQueue />}
      {can(REVIEW_READ) && (
        <Section title="Declarations and proofs">
          <ErrorNote error={declarations.error ?? proofs.error} />
          {declarations.data && (
            <ul aria-label="Declarations">
              {declarations.data.items.map((d) => (
                <li key={d.id}>
                  {`${d.employeeCode} ${d.fiscalPeriodCode} `}
                  <StateBadge state={d.state} />
                </li>
              ))}
            </ul>
          )}
          {proofs.data && (
            <ul aria-label="Proofs">
              {proofs.data.items.map((p) => (
                <li key={p.id}>
                  {`${p.employeeCode} ${p.fiscalPeriodCode} ${p.categoryCode} `}
                  <StateBadge state={p.state} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {can(REVIEW_READ) && <Form16PartB declarations={declarations.data?.items ?? []} />}
    </div>
  );
}

interface PartB {
  status: string;
  message?: string;
  regime?: string;
  regimeSource?: string;
  salary: {
    processedMonths: number;
    grossSalary: string;
    exemptAllowances: string;
    tdsDeducted: string;
    finalSettlement?: { taxableSalary: string; exemptAllowances: string; tdsDeducted: string } | null;
  };
  standardDeduction?: string;
  hraExemption?: { exemption: string; hraReceived: string; salaryForHra: string; rentPaid: string; metro: boolean } | null;
  previousEmployment?: { salary: string; tds: string } | null;
  deductions?: { categoryCode: string; amount: string; limit: string | null; allowed: string }[];
  taxableIncome?: string;
  tax?: { slabTax: string; rebate: string; surcharge: string; cess: string; total: string };
  balance?: string;
  partA: { status: string; reason: string };
}

/** Part B's status: calculated under which regime and why that one, or the server's reason it is not. */
function partBStatus(d: PartB): string {
  if (d.status !== 'CALCULATED') return d.message ?? d.status;
  return `Calculated (${d.regime} regime, ${d.regimeSource === 'DECLARATION' ? 'as declared' : 'the default'})`;
}

/**
 * FR-107 (I-90): Form 16 Part B working data of one employee and year, as the server computes it from processed payroll, the accepted
 * declaration and proofs, and the active INCOME_TAX pack. It is the reviewer's working data, never the certificate (Part A comes from
 * TRACES); figures are shown exactly as returned.
 */
function Form16PartB({ declarations }: { declarations: (Declaration & { employeeId?: string })[] }) {
  const [employeeId, setEmployeeId] = useState('');
  const [fiscalYear, setFiscalYear] = useState('2026-27');
  const [asked, setAsked] = useState<{ employeeId: string; fiscalYear: string } | null>(null);
  const partB = useQuery({
    queryKey: ['form16-part-b', asked],
    enabled: asked !== null,
    queryFn: () => api<PartB>(`/v1/payroll/form16/part-b?employeeId=${encodeURIComponent(asked!.employeeId)}&fiscalYear=${encodeURIComponent(asked!.fiscalYear)}`),
  });
  const amount = (v: string | undefined) => (v === undefined ? '—' : formatAmount(v, 'INR'));
  const d = partB.data;
  return (
    <Section title="Form 16 Part B (working data)">
      <Hint>Salary and tax for a year, from processed payroll and accepted proofs, valued under the income tax pack two people validated and activated. Part A comes from TRACES; no certificate is issued here.</Hint>
      {declarations.some((x) => x.employeeId) && (
        <ul aria-label="Part B by declaration">
          {declarations
            .filter((x) => x.employeeId)
            .map((x) => (
              <li key={x.id}>
                <Button type="button" variant="outline" size="sm" onClick={() => setAsked({ employeeId: x.employeeId!, fiscalYear: x.fiscalPeriodCode })}>
                  {`Part B: ${x.employeeCode ?? ''} ${x.fiscalPeriodCode}`}
                </Button>
              </li>
            ))}
        </ul>
      )}
      <form
        className={FIELD_ROW}
        aria-label="Form 16 Part B"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (employeeId.trim() && fiscalYear.trim()) setAsked({ employeeId: employeeId.trim(), fiscalYear: fiscalYear.trim() });
        }}
      >
        <FormField className="w-auto">
          Employee ID
          <Input value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} />
        </FormField>
        <FormField className="w-auto">
          Financial year
          <Input value={fiscalYear} onChange={(e) => setFiscalYear(e.target.value)} placeholder="2026-27" />
        </FormField>
        <Button type="submit">Show Part B</Button>
      </form>
      <ErrorNote error={partB.error} />
      {d && (
        <dl className="kv" aria-label="Part B figures">
          <dt>Status</dt>
          <dd>{partBStatus(d)}</dd>
          <dt>Months processed</dt>
          <dd>{d.salary.processedMonths}</dd>
          {d.salary.finalSettlement && (
            <>
              <dt>Final settlement (included)</dt>
              <dd>{`${amount(d.salary.finalSettlement.taxableSalary)} taxable, ${amount(d.salary.finalSettlement.tdsDeducted)} TDS`}</dd>
            </>
          )}
          <dt>Gross salary</dt>
          <dd>{amount(d.salary.grossSalary)}</dd>
          <dt>Exempt allowances</dt>
          <dd>{amount(d.salary.exemptAllowances)}</dd>
          {d.previousEmployment && (
            <>
              <dt>Earlier employer this year (Form 12B)</dt>
              <dd>{`${amount(d.previousEmployment.salary)} salary, ${amount(d.previousEmployment.tds)} tax deducted`}</dd>
            </>
          )}
          {d.hraExemption && (
            <>
              <dt>House rent allowance exempt</dt>
              <dd>{`${amount(d.hraExemption.exemption)} (allowance ${amount(d.hraExemption.hraReceived)}, rent ${amount(d.hraExemption.rentPaid)}${d.hraExemption.metro ? ', metro city' : ''})`}</dd>
            </>
          )}
          <dt>Standard deduction</dt>
          <dd>{amount(d.standardDeduction)}</dd>
          <dt>Deductions allowed</dt>
          <dd>{d.deductions && d.deductions.length > 0 ? d.deductions.map((x) => `${x.categoryCode} ${amount(x.allowed)}`).join('; ') : '—'}</dd>
          <dt>Taxable income</dt>
          <dd>{amount(d.taxableIncome)}</dd>
          <dt>Tax for the year</dt>
          <dd>{amount(d.tax?.total)}</dd>
          <dt>TDS deducted</dt>
          <dd>{amount(d.salary.tdsDeducted)}</dd>
          <dt>Balance</dt>
          <dd>{amount(d.balance)}</dd>
          <dt>Part A</dt>
          <dd>{d.partA.reason}</dd>
        </dl>
      )}
    </Section>
  );
}
