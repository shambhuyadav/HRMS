// How a statutory amount was worked out, in plain words, from the workings the server recorded with it (I-85 PF, ESIC, professional tax;
// FR-039 labour welfare fund; I-90 TDS, in payroll and in a final settlement). Shared by the payroll record and payslip views and the
// settlement calculation items. Only the recorded figures are shown, through the caller's money format; nothing is worked out here.

type Workings = Record<string, unknown>;
/** Formats an amount the server returned (the caller's currency and style). */
export type MoneyText = (amount: string) => string;

const readable = (code: string) => {
  const text = code.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const NOT_DUE: Record<string, string> = {
  NOT_COVERED: 'Not covered: your wages are above the ESIC ceiling',
  NOT_A_CONTRIBUTION_MONTH: 'Not due this month',
  NIL_AMOUNT: 'Nothing due at these wages',
  NO_TAX_DUE: 'No tax due on the year so far',
};

/**
 * `valued`: the amount was valued (a payroll VALUED row, a settlement CALCULATED item); otherwise the recorded reason is said. An
 * employer contribution in a settlement says what it costs the employer.
 */
export function statutoryWorkingsNote(valued: boolean, w: Workings, money: MoneyText): string {
  const m = (k: string) => money(String(w[k] ?? ''));
  const has = (k: string) => w[k] !== undefined && w[k] !== null;
  if (!valued) {
    if (has('employerCost')) return `Paid by the employer: ${m('employerCost')}, not part of the settlement`;
    const reason = NOT_DUE[String(w.reason)] ?? readable(String(w.reason ?? 'NOT_APPLICABLE'));
    return w.output === 'TDS' && has('taxableIncome') ? `${reason}: tax for the year ${m('annualTax')} on taxable income ${m('taxableIncome')}` : reason;
  }
  if (w.output === 'TDS') {
    const hra = has('hraExemption') && Number(w.hraExemption) > 0 ? `, less ${m('hraExemption')} of house rent allowance exempt` : '';
    const earlierEmployer = has('previousEmployerSalary') ? `, with ${m('previousEmployerSalary')} from an earlier employer (${m('previousEmployerTds')} deducted there)` : '';
    if (has('annualSalary')) {
      // A final settlement: the year as it ends, nothing projected.
      return `${readable(String(w.regime))} regime: salary for the year ${m('annualSalary')} (${m('settlementTaxableSalary')} in this settlement)${earlierEmployer}${hra}, taxable income ${m('taxableIncome')}, tax for the year ${m('annualTax')}; ${m('tdsEarlier')} deducted earlier this year`;
    }
    return `${readable(String(w.regime))} regime: projected salary for the year ${m('projectedAnnualSalary')}${earlierEmployer}${hra}, taxable income ${m('taxableIncome')}, tax for the year ${m('annualTax')}; ${m('tdsEarlier')} deducted earlier this year, the rest spread over ${String(w.monthsLeft)} month(s)`;
  }
  if (has('pfWages')) {
    if (w.output === 'EPS') return `${String(w.ratePercent)}% of ${m('pensionWages')} (pension)`;
    if (w.output === 'EPF') return `${String(w.employerRatePercent)}% of ${m('contributionWages')}, less the pension share`;
    if (w.output === 'EDLI') return `${String(w.ratePercent)}% of ${m('edliWages')}`;
    return `${String(w.ratePercent)}% of ${m('contributionWages')}${w.option === 'HIGHER_WAGES' ? ' (your option to contribute on higher wages)' : ''}`;
  }
  if (has('esicWages')) return `${String(w.ratePercent)}% of ESIC wages ${m('esicWages')}`;
  if (has('contributionMonths')) return `Labour welfare fund, ${String(w.stateCode)}, slab ${String(w.slab)}`;
  if (has('gross')) return `Professional tax, ${String(w.stateCode)}, slab ${String(w.slab)} for a monthly gross of ${m('gross')}`;
  return '—';
}
