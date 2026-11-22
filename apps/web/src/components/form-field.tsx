// Form layout on shadcn's Field (owner's choice of 20 Nov 2026: a full move to shadcn/ui), in the HRMS look of before: a field's name
// sits above its control, the fields flow in a grid of columns at least 210px wide, and a form's buttons sit on its bottom line.
//
// A field is one <label> holding its words and its control, as the screens had it. The control takes its name from the label, and
// the label's words stay exactly as written, spaces included: the tests find fields by them, and the behaviour snapshot records the
// label's whole text. `required`, `disabled`, `maxLength` and the like go on the control (Input, NativeSelect, Textarea, a native
// checkbox); no mark is added to the words.
//
// Each part sets every property it needs, so none depends on the old rules of styles.css (.grid-form, label.inline, label.check,
// .filter-bar, fieldset.form-step). Where the look depends on the part's place, the place is passed down where it can be (a form in a
// card: InCardContext); a grid styles its own direct children (a heading, a button, a field with help under it).
import { Slot } from 'radix-ui';
import * as React from 'react';
import { InCardContext } from '@/components/card-context';
import { Field, FieldLabel, FieldSet } from '@/components/ui/field';
import { cn } from '@/lib/utils';

/**
 * The grid of a form or a step of one. A heading, sentence, note, alert, group of fields or folded part spans the row; a button keeps
 * its own width on the bottom line, and a row of two or more buttons takes a line of its own; nothing outgrows its column. A field with
 * help under it, or a list box, is taller than its neighbours, so such a grid lines its fields up along the top (its buttons stay on
 * the bottom line). A file field gets room for its button and the file's name.
 */
const GRID = cn(
  'grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] items-end gap-[0.95rem_1.1rem] [&>*]:min-w-0',
  '[&>:is(h2,h3,h4,p,fieldset,details,[role=note],[role=alert])]:col-span-full [&>:is(h3,h4)]:m-0',
  '[&>:is(button,[data-slot=button])]:min-w-32 [&>:is(button,[data-slot=button])]:self-end [&>:is(button,[data-slot=button])]:justify-self-start',
  '[&>[data-slot=button-row]]:self-end [&>[data-slot=button-row]]:justify-self-start [&>[data-slot=button-row]:has(>*+*)]:col-span-full',
  'has-[>[data-slot=field]>[data-slot=field-description]]:items-start has-[select[multiple]]:items-start',
  '[&>label:has(>input[type=file])]:col-span-full [&>label:has(>input[type=file])]:max-w-[560px]',
);

/** A form outside a card is a box of its own. Its steps (FormStep) are numbered from the form. */
const FORM = cn(GRID, 'rounded-xl border border-border bg-card px-[1.2rem] py-[1.15rem] has-[>.form-step]:[counter-reset:form-step]');
/** In a card (InCardContext) the card is the box: no frame, and room under the form when something follows it. */
const FORM_IN_CARD = 'rounded-none border-0 bg-transparent p-0 not-last:mb-[1.15rem]';
/**
 * A form after other content in its card is set apart by a rule, except right under the card's header (or its hidden title), or
 * under the one sentence that opens the card. This depends on the form's place among the card's children, which the screens do not
 * mark, so it reads the form's position in the card (`.card`, the marker every card carries).
 */
const FORM_AFTER_CARD_CONTENT = cn(
  '[.card>:not(header,.sr-only)+&]:mt-1 [.card>:not(header,.sr-only)+&]:border-t [.card>:not(header,.sr-only)+&]:pt-[1.15rem]',
  '[.card>:is(header,.sr-only)+p+&]:mt-0 [.card>:is(header,.sr-only)+p+&]:border-t-0 [.card>:is(header,.sr-only)+p+&]:pt-0',
);

type FormGridProps = React.ComponentPropsWithoutRef<'form'> & { asChild?: boolean };

/**
 * A form laid out as a grid of fields (the old `form.grid-form`). The ref reaches the <form> (FormProgress follows it). With asChild
 * the grid is drawn on the caller's own element instead, for a group of fields that is not a form (the old `div.grid-form`).
 */
const FormGrid = React.forwardRef<HTMLFormElement, FormGridProps>(function FormGrid({ className, asChild = false, ...props }, ref) {
  const inCard = React.useContext(InCardContext);
  const Comp = asChild ? Slot.Root : 'form';
  return <Comp ref={ref} data-slot="form-grid" className={cn(FORM, inCard && FORM_IN_CARD, FORM_AFTER_CARD_CONTENT, className)} {...props} />;
});

/**
 * A list's filters as one tinted strip above the rows they filter (the old `.grid-form.filter-bar` and `.filters`): a <div>, or with
 * asChild the caller's own element (a filter form named "… filters").
 */
function FilterBar({ className, asChild = false, ...props }: React.ComponentPropsWithoutRef<'div'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'div';
  return <Comp data-slot="filter-bar" className={cn(GRID, 'rounded-lg border border-border bg-accent px-4 py-[0.85rem] not-last:mb-4', className)} {...props} />;
}

/** A step: a row of the form, parted from the step before by a hairline, coming to rest below the steps strip when chosen there. */
const STEP = 'col-span-full scroll-mt-[7.75rem] phone:scroll-mt-[6.5rem] [&+&]:border-t [&+&]:border-border [&+&]:pt-[1.15rem]';
/**
 * The step's title across its first row: not drawn on the frame (floated, a legend is an ordinary item of the step's grid), the
 * step's number before it in a small accent circle. The number is the form's count of its steps (`counter-reset` on FormGrid), shown
 * but not read out: the steps strip (FormProgress) already names each step with its number.
 */
const STEP_LEGEND = 'float-left col-span-full m-0 flex w-full items-center gap-[0.55rem] p-0 text-[0.92rem] font-semibold text-foreground';
const STEP_NUMBER =
  "before:inline-grid before:size-[1.45rem] before:flex-none before:place-items-center before:rounded-full before:bg-[var(--accent-soft)] before:text-[0.72rem] before:font-[650] before:text-[var(--accent)] before:shadow-[inset_0_0_0_1px_var(--accent-edge)] before:[counter-increment:form-step] before:content-[counter(form-step)_/_'']";

/**
 * One step of a long form (the old `fieldset.form-step`): a row of the form with a grid of its own, its numbered legend across the
 * top. FormProgress finds the steps as the form's outermost fieldsets with a legend; FormGrid counts them by the `form-step` class.
 * Use it inside a FormGrid.
 */
function FormStep({ legend, className, children, ...props }: React.ComponentPropsWithoutRef<'fieldset'> & { legend: React.ReactNode }) {
  return (
    <FieldSet className={cn('form-step', GRID, STEP, className)} {...props}>
      <legend className={cn(STEP_LEGEND, STEP_NUMBER)}>{legend}</legend>
      {children}
    </FieldSet>
  );
}

/** A field's words above its control, in the old label's size, weight and colour; the control takes the column's width. */
const FIELD_LABEL =
  'w-full min-w-0 flex-col items-stretch gap-[0.32rem] text-[0.83rem] leading-snug font-medium text-[var(--body)] select-auto [&>[data-slot=native-select-wrapper]]:w-full';

/**
 * A field: a label holding its words and its control (Input, NativeSelect, Textarea), the words above. `hint` is what is said under
 * the field (FieldDescription lines, an ErrorNote): with it the field is a shadcn Field, the label with the lines below it.
 */
function FormField({ hint, className, ...props }: React.ComponentPropsWithoutRef<typeof FieldLabel> & { hint?: React.ReactNode }) {
  if (hint === undefined) return <FieldLabel className={cn(FIELD_LABEL, className)} {...props} />;
  return (
    <Field className={className}>
      <FieldLabel className={FIELD_LABEL} {...props} />
      {hint}
    </Field>
  );
}

/** The words of a checkbox or radio, in a field label's size, weight and colour. */
const CHECK_LABEL = 'w-fit items-start gap-2 text-[0.83rem] leading-snug font-medium text-[var(--body)] select-auto';
/** The native box itself (the label's input child): on the words' first line, in the accent colour, 18px on a phone. */
const CHECK_BOX = '[&>input]:m-0 [&>input]:mt-[0.15rem] [&>input]:flex-none [&>input]:accent-[var(--accent)] phone:[&>input]:size-[18px]';

/** A native checkbox (or radio) beside its words, the box on the first line of the words. Give it the input, then its words. */
function CheckField({ className, ...props }: React.ComponentPropsWithoutRef<typeof FieldLabel>) {
  return <FieldLabel className={cn(CHECK_LABEL, CHECK_BOX, className)} {...props} />;
}

/** Buttons side by side (the old `.row`). In a form grid it sits on the bottom line, and with two or more buttons takes a line of its own. */
function ButtonRow({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="button-row" className={cn('flex flex-wrap items-center gap-2', className)} {...props} />;
}

type FieldsetProps = React.ComponentPropsWithoutRef<'fieldset'> & { legend: React.ReactNode };

/** A FramedFieldset: a hairline frame with the legend on it, its parts stacked. */
const FRAMED_FIELDSET = 'm-0 flex min-w-0 flex-col gap-[0.55rem] rounded-md border border-border px-4 pt-3 pb-[0.9rem]';
const FRAMED_LEGEND = 'px-[0.35rem] text-[0.82rem] font-semibold text-foreground';

/**
 * Fields that belong together, in a frame under their legend (a goal, one line of a claim, a template task, an occasion's choices).
 * In a form grid it spans the row.
 */
function FramedFieldset({ legend, className, children, ...props }: FieldsetProps) {
  return (
    <fieldset data-slot="framed-fieldset" className={cn(FRAMED_FIELDSET, className)} {...props}>
      <legend className={FRAMED_LEGEND}>{legend}</legend>
      {children}
    </fieldset>
  );
}

/**
 * Choices under one question, with no frame (the old frameless fieldset): the legend in a field's words above them, then the choices
 * (often a ChoiceRow). In a form grid it spans the row.
 */
function LabelledFieldset({ legend, className, children, ...props }: FieldsetProps) {
  return (
    <FieldSet className={cn('gap-2', className)} {...props}>
      <legend className="mb-2 p-0 text-[0.83rem] font-semibold text-foreground">{legend}</legend>
      {children}
    </FieldSet>
  );
}

/** Radio buttons or checkboxes (CheckField) side by side, wrapping on a narrow screen. */
function ChoiceRow({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="choice-row" className={cn('flex flex-wrap items-center gap-x-4 gap-y-2', className)} {...props} />;
}

export { ButtonRow, CheckField, ChoiceRow, FilterBar, FormField, FormGrid, FormStep, FramedFieldset, LabelledFieldset };
