// A settlement calculation item's basis in a few plain words (I-88): the server's figures, only those present.
import { formatAmount, formatUnits, readable } from '../../api';
import { statutoryWorkingsNote } from '../../statutory-note';
import { labelOf, LOAN_KIND_LABEL, PACK_STATE_LABEL, RATE_BASIS_LABEL } from './shared';
import type { CalculationItem } from './types';

// ---------------------------------------------------------------------------------------------------------
// I-88: a calculation item's basis in a few plain words (the server's figures, only those present; nothing worked out here)
// ---------------------------------------------------------------------------------------------------------
type Basis = Record<string, unknown>;
const textOf = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
/** A rate or amount of the basis with 2 decimals, as amounts show (the exact value stays in the snapshot). */
const rateText = (v: unknown): string | null => {
  const t = textOf(v);
  return t === null || Number.isNaN(Number(t)) ? null : Number(t).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
/** A count of days, units or years without padding zeros ("18.5000" reads 18.5). */
export const unitText = (v: unknown): string | null => {
  const t = textOf(v);
  return t === null ? null : formatUnits(t);
};
const listIn = (v: unknown): Basis[] => (Array.isArray(v) ? v.filter((x): x is Basis => typeof x === 'object' && x !== null) : []);
export const plural = (n: string, one: string, many: string) => `${n} ${n === '1' ? one : many}`;

/** The "How" of a calculation item: a short summary of the basis the server recorded for it, by kind. */
export function howText(item: CalculationItem): string {
  const b: Basis = item.basis ?? {};
  const parts: string[] = [];
  const push = (text: string | null | false | undefined) => {
    if (text) parts.push(text);
  };
  const rateBasis = textOf(b.rateBasis);
  switch (item.kind) {
    case 'EARNINGS_DUE': {
      const days = unitText(b.daysInMonth);
      const segments = listIn(b.segments)
        .map((g) => {
          const monthly = rateText(g.monthlyAmount);
          const paid = unitText(g.paidDays);
          return monthly && paid ? `${monthly} x ${plural(paid, 'paid day', 'paid days')}${days ? ` / ${days}` : ''}` : null;
        })
        .filter((t): t is string => t !== null);
      push(segments.join(' + '));
      const period = textOf(b.periodCode);
      if (period) push(`paid by the ${period} payroll${textOf(b.runState) ? ` (${readable(String(b.runState)).toLowerCase()})` : ''}`);
      const inputs = listIn(b.inputs).map((i) => `${textOf(i.componentCode) ?? '?'}${textOf(i.periodCode) ? ` (${String(i.periodCode)})` : ''}`);
      if (inputs.length > 0) push(`payroll inputs ${inputs.join(', ')}`);
      const covered = unitText(b.coveredDays);
      const eligible = unitText(b.eligibleDays);
      if (covered && eligible) push(`${covered} of ${eligible} days covered by a salary arrangement`);
      else if (segments.length === 0 && textOf(b.eligibleFrom) && textOf(b.lastWorkingDate)) push(`${String(b.eligibleFrom)} to ${String(b.lastWorkingDate)}`);
      const currencies = Array.isArray(b.arrangementCurrencies) ? b.arrangementCurrencies.filter((c): c is string => typeof c === 'string') : [];
      if (currencies.length > 0) push(`salary in ${currencies.join(', ')}${textOf(b.settlementCurrency) ? `, settlement in ${String(b.settlementCurrency)}` : ''}`);
      if (textOf(b.rulePackCode)) push(`rule pack ${String(b.rulePackCode)}`);
      break;
    }
    case 'LEAVE_ENCASHMENT': {
      const available = unitText(b.available);
      const cap = unitText(b.cap);
      const units = unitText(b.units);
      const monthly = rateText(b.monthlyRate);
      const divisor = unitText(b.divisor);
      if (b.encashable === false) push(`not encashable under the settlement policy${available ? ` (${available} units available)` : ''}`);
      else if (units && available) push(`${units} of ${available} units${cap ? ` (cap ${cap})` : ''}${monthly && divisor ? ` x ${monthly} / ${divisor}` : ''}`);
      else if (available) push(`${available} units available${unitText(b.pending) ? `, ${unitText(b.pending)} pending` : ''}`);
      if (rateBasis) push(`rate on ${labelOf(RATE_BASIS_LABEL, rateBasis)}`);
      break;
    }
    case 'NOTICE_RECOVERY': {
      const required = unitText(b.requiredDays);
      const served = unitText(b.servedDays);
      const short = unitText(b.shortfallDays);
      const monthly = rateText(b.monthlyRate);
      const divisor = unitText(b.divisor);
      if (required && served) {
        const head = `${required} required, ${served} served`;
        push(short && monthly && divisor ? `${head}: ${plural(short, 'day', 'days')} x ${monthly} / ${divisor}` : short && short !== '0' ? `${head}: ${plural(short, 'day', 'days')} short` : head);
      }
      if (rateBasis) push(`rate on ${labelOf(RATE_BASIS_LABEL, rateBasis)}`);
      if (textOf(b.waiverId)) push('waived');
      break;
    }
    case 'LOAN_RECOVERY': {
      const outstanding = textOf(b.outstanding);
      if (outstanding) push(`${textOf(b.loanKind) ? `${labelOf(LOAN_KIND_LABEL, String(b.loanKind))}: ` : ''}${formatAmount(outstanding, textOf(b.currencyCode) ?? '')} outstanding`);
      break;
    }
    case 'ARREARS':
    case 'ADJUSTMENT': {
      const total = textOf(b.total);
      if (total) push(`${formatAmount(total, textOf(b.currencyCode) ?? '')}${textOf(b.originPeriodCode) ? ` from period ${String(b.originPeriodCode)}` : ''}`);
      break;
    }
    case 'GRATUITY': {
      const counted = unitText(b.countedYears);
      const wages = rateText(b.monthlyWages);
      const wageDays = unitText(b.wageDays);
      const divisor = unitText(b.wageDivisor);
      const completed = unitText(b.completedYears);
      const needed = unitText(b.minimumServiceYears);
      if (counted && wages && wageDays && divisor) {
        push(`${plural(counted, 'counted year', 'counted years')} x ${wages} x ${wageDays} / ${divisor}`);
        if (b.capped === true) push(`capped at the ceiling of ${rateText(b.ceilingAmount) ?? '?'}${rateText(b.uncapped) ? ` (${rateText(b.uncapped)} before it)` : ''}`);
      } else if (item.status === 'NOT_ELIGIBLE' && completed && needed && b.exemptSeparation !== true) {
        push(`${plural(completed, 'completed year', 'completed years')} of the ${needed} needed`);
      } else if (counted) {
        push(plural(counted, 'counted year', 'counted years'));
      }
      if (b.exemptSeparation === true) push('no minimum service for this separation');
      if (textOf(b.packRevision)) push(`pack revision ${String(b.packRevision)}${textOf(b.packState) ? ` (${labelOf(PACK_STATE_LABEL, String(b.packState)).toLowerCase()})` : ''}`);
      break;
    }
    case 'STATUTORY_DEDUCTION': {
      const bases = Array.isArray(b.baseComponentCodes) ? b.baseComponentCodes.filter((c): c is string => typeof c === 'string') : [];
      if (textOf(b.rulePackCode)) push(`rule pack ${String(b.rulePackCode)}${bases.length > 0 ? ` on ${bases.join(', ')}` : ''}`);
      // Valued from a pack (I-85, I-90, FR-039): how, from the recorded workings; the reason is said there, not again below.
      if (textOf(b.output)) {
        push(`${textOf(b.packCode) ?? ''}${textOf(b.packRevision) ? ` revision ${String(b.packRevision)}` : ''}`.trim());
        push(statutoryWorkingsNote(item.status === 'CALCULATED', b, (v) => rateText(v) ?? v));
        return parts.join('; ');
      }
      break;
    }
    default:
      break;
  }
  if (textOf(b.reason)) push(String(b.reason));
  return parts.length > 0 ? parts.join('; ') : '—';
}
