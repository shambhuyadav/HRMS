// Shared parts of the tax declaration screens: the duties, the API's shapes, and the layout pieces these screens have and the shared
// helpers do not.
import type { ComponentPropsWithoutRef } from 'react';
import { Hint } from '@/components/hint';

export const OWN_READ = 'own_tax.read.tax';
export const OWN_SUBMIT = 'own_tax.submit.tax';
export const REVIEW_READ = 'tax_declaration.read.tax';
export const REVIEW = 'tax_declaration.review.tax';
export const CONFIG_READ = 'payroll_config.read.operational';
export const CONFIG_MANAGE = 'payroll_config.manage.operational';
export const CONFIG_ACTIVATE = 'payroll_config.activate.operational';

// Layout pieces of these screens, as utility classes (shadcn/ui move, 20 Nov 2026).
/** A form's fields stacked one under another (the old `form.stack`), the form set a little apart from what is above it in its card. */
export const FORM_STACK = 'mt-4 flex flex-col gap-3';
/** A field in a stacked form keeps the old 560px limit, so a wide card does not stretch it. */
export const FIELD_WIDTH = 'max-w-[560px]';
/** A date never needs the whole card (the old 260px limit). */
export const DATE_WIDTH = 'max-w-[260px]';
/** Fields side by side, their bottoms lined up with the button, wrapping on a narrow screen (the old `form.row`). */
export const FIELD_ROW = 'flex flex-wrap items-end gap-x-4 gap-y-3';
/** Declarations or packs, one card under another. */
export const CARD_LIST = 'm-0 flex list-none flex-col gap-3 p-0';
/**
 * A declaration, proof or pack: a card inside the list's card. It keeps the `card` marker class, so its notes are drawn as a card's
 * own (a boxed hint), as they were before the move to shadcn/ui.
 */
export const ITEM_CARD = 'card rounded-xl border border-border bg-card px-5 py-4 shadow-xs';

/** One declaration or pack of a list, as a card. */
export function ItemCard(props: ComponentPropsWithoutRef<'li'>) {
  return <li className={ITEM_CARD} {...props} />;
}

export interface Regime {
  code: string;
  name: string;
  categories: { code: string; name: string }[];
}
export interface OpenPeriod {
  rulePackId: string;
  fiscalPeriodCode: string;
  periodStart: string;
  periodEnd: string;
  cutoffDate: string;
  currencyCode: string;
  cutoffPassed: boolean;
  regimes: Regime[];
}
export interface Declaration {
  id: string;
  fiscalPeriodCode: string;
  cutoffDate: string;
  currencyCode: string;
  regimeCode: string;
  lines: { categoryCode: string; amount: string }[];
  state: string;
  employeeExplanation: string | null;
  employeeCode?: string;
  employeeName?: string;
  version: number;
}
export interface OwnDeclarations {
  items: Declaration[];
  configuration: { status: 'ACTIVE' | 'NOT_CONFIGURED'; message?: string };
  openPeriods: OpenPeriod[];
  calculation: { message: string };
}
export interface Proof {
  id: string;
  declarationId: string;
  fiscalPeriodCode: string;
  categoryCode: string;
  categoryName: string | null;
  claimedAmount: string;
  acceptedAmount: string | null;
  rejectedAmount: string | null;
  currencyCode: string;
  state: string;
  employeeExplanation: string | null;
  employeeCode?: string;
  employeeName?: string;
  evidence: { documentId: string; documentType: string; scanState: string | null; verificationState: string }[];
}
export interface OwnProofs {
  items: Proof[];
  configuration: { status: 'ACTIVE' | 'NOT_CONFIGURED'; message?: string };
}

export const notPermitted = (message: string) => <Hint>{message}</Hint>;
