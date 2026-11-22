// Progress through a long form (owner's request of 20 Nov 2026: "long forms grouped into steps with a progress indicator"). The
// form keeps every field on the page, in its order, with its own state and its own checks: this only reads the form as it stands
// and shows its groups as numbered steps, each ticked once its required fields are filled, with the share of the form's required
// fields filled so far. Choosing a step moves to that group and puts the cursor in its first field still to fill.
//
// The groups are the form's own: its outermost fieldsets with a legend, or else the headings that divide it. A field is required
// when it says so (required or aria-required), or when the page names it in `required` because the form checks it in code rather
// than with the attribute. Nothing here changes what the form sends or refuses.

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// ---- How it is drawn ----------------------------------------------------------------------------------------------------------
// The strip stays at the top of the page while the form scrolls. Every colour is a token, so the light and dark themes both follow.

/**
 * A band of the page's own background, so what scrolls under the strip never shows around it; its padding is taken back by its
 * margins, so the space between the cards stays the page's own. A sticky box stops at the page's top padding (--content-top), so the
 * strip is lifted by that much and meets the top bar with nothing scrolling past above it.
 */
const STRIP = 'sticky top-[calc(-1*var(--content-top,0rem))] z-4 -my-2 bg-background py-2';
const CARD =
  'flex flex-col gap-[0.6rem] rounded-xl border border-border bg-card px-[0.7rem] pt-[0.55rem] pb-[0.75rem] shadow-[var(--shadow-xs)] phone:gap-2 phone:px-2 phone:pt-[0.45rem] phone:pb-[0.65rem]';
/**
 * The steps side by side, sharing the width; on a narrow screen they scroll sideways, with no scrollbar shown. On a phone the strip
 * fades at its end, a sign that it scrolls, and its end padding lets the last step scroll clear of the fade.
 */
const STEPS = cn(
  'm-0 flex list-none gap-1 overflow-x-auto overscroll-x-contain p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
  'phone:pr-5 phone:[mask-image:linear-gradient(to_right,#000_calc(100%-20px),transparent)]',
);
const STEP_ITEM = 'flex min-w-max flex-[1_1_0] phone:flex-none';
/**
 * A step's button: its number (or tick) beside its name and state. The step being filled in is on a quiet tile, or in the system's
 * highlight colours in Windows high-contrast mode, where tiles are not drawn.
 */
const STEP_BUTTON = cn(
  'h-auto flex-1 justify-start gap-[0.6rem] px-[0.6rem] py-[0.4rem] text-left font-medium text-[var(--body)] phone:gap-[0.45rem] phone:px-2 phone:py-[0.35rem]',
  'aria-[current=step]:border-border aria-[current=step]:bg-accent',
  'forced-colors:aria-[current=step]:bg-[color:Highlight] forced-colors:aria-[current=step]:text-[color:HighlightText] forced-colors:aria-[current=step]:forced-color-adjust-none',
);
const MARK = 'grid size-[1.6rem] flex-none place-items-center rounded-full text-[0.76rem] font-[650] transition-[background,color,box-shadow] duration-150 motion-reduce:transition-none';
/** The mark's colours: complete in the success tint, the step being filled in in the accent tint, any other step quiet. */
const MARK_DONE = 'bg-[var(--good-soft)] text-[var(--good)] shadow-[inset_0_0_0_1px_var(--good-edge)]';
const MARK_CURRENT = 'bg-[var(--accent-soft)] text-[var(--accent)] shadow-[inset_0_0_0_1px_var(--accent-edge)]';
const MARK_WAITING = 'bg-muted text-muted-foreground shadow-[inset_0_0_0_1px_var(--line-strong)]';
const markColours = (done: boolean, current: boolean) => {
  if (done) return MARK_DONE;
  return current ? MARK_CURRENT : MARK_WAITING;
};
/** The step's state under its name; left out on a phone, where the strip has room for the names only. */
const STEP_STATE = 'text-[0.74rem] font-medium whitespace-nowrap text-muted-foreground phone:hidden';
/** The share of required fields filled: a thin bar and its words, in the success colour once every one is filled. */
const METER = 'flex items-center gap-3 px-[0.2rem] phone:flex-wrap phone:gap-[0.3rem_0.75rem]';
const TRACK = 'relative h-[6px] flex-1 overflow-hidden rounded-full bg-muted shadow-[inset_0_0_0_1px_var(--line)]';
const FILL = 'absolute inset-0 origin-left rounded-[inherit] bg-[var(--accent-bright)] transition-[transform,background] duration-[250ms] motion-reduce:transition-none';
const COUNT = 'flex-none text-[0.78rem] font-medium text-muted-foreground tabular-nums';

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

interface Group {
  name: string;
  /** The fieldset, or the heading that opens the group. */
  element: HTMLElement;
  fields: Field[];
}

interface Step {
  name: string;
  required: number;
  filled: number;
}

interface Snapshot {
  steps: Step[];
  required: number;
  filled: number;
}

const NOT_FIELDS = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

const FIELD = 'input, select, textarea';
const isField = (f: Field) => !(f instanceof HTMLInputElement && NOT_FIELDS.has(f.type));

/** The fields in an element, the element itself included when it is one. */
function fieldsIn(el: Element): Field[] {
  const own = el.matches(FIELD) ? [el as Field] : [];
  return [...own, ...Array.from(el.querySelectorAll<Field>(FIELD))].filter(isField);
}

/** A field's own words: its aria-label, or its label's text without the words of any control inside the label. */
export function fieldName(field: Field): string {
  const aria = field.getAttribute('aria-label');
  if (aria) return aria.trim();
  const label = field.labels?.[0];
  if (!label) return '';
  const text = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node instanceof Element && node.matches('input, select, textarea, button, datalist')) return '';
    return Array.from(node.childNodes).map(text).join('');
  };
  return text(label).replace(/\s+/g, ' ').trim();
}

/** The form's groups: its outermost fieldsets with a legend; failing those, the headings directly in it and what follows each. */
function groupsOf(form: HTMLFormElement): Group[] {
  const outermost = Array.from(form.querySelectorAll('fieldset')).filter((f) => {
    const outer = f.parentElement?.closest('fieldset');
    return !outer || !form.contains(outer);
  });
  const fieldsets = outermost.flatMap((f) => {
    const name = f.querySelector(':scope > legend')?.textContent?.trim();
    return name ? [{ name, element: f as HTMLElement, fields: fieldsIn(f) }] : [];
  });
  if (fieldsets.length > 0) return fieldsets;
  const headings = Array.from(form.children).filter((c): c is HTMLElement => /^H[2-4]$/.test(c.tagName));
  return headings.flatMap((h, i) => {
    const name = h.textContent?.trim();
    if (!name) return [];
    const fields: Field[] = [];
    for (let n = h.nextElementSibling; n && n !== headings[i + 1]; n = n.nextElementSibling) fields.push(...fieldsIn(n));
    return [{ name, element: h, fields }];
  });
}

const isRequired = (f: Field, named: ReadonlySet<string>) =>
  !f.matches(':disabled') && (f.required || f.getAttribute('aria-required') === 'true' || (named.size > 0 && named.has(fieldName(f))));

const isFilled = (f: Field) => (f instanceof HTMLInputElement && (f.type === 'checkbox' || f.type === 'radio') ? f.checked : f.value.trim() !== '');

/** Required fields and how many are filled; a set of radio buttons is one field, filled once one of them is chosen. */
function tally(fields: readonly Field[], named: ReadonlySet<string>): { required: number; filled: number } {
  const seen = new Map<string, { required: boolean; filled: boolean }>();
  fields.forEach((f, i) => {
    const key = f instanceof HTMLInputElement && f.type === 'radio' && f.name ? `radio:${f.name}` : `field:${i}`;
    const before = seen.get(key) ?? { required: false, filled: false };
    seen.set(key, { required: before.required || isRequired(f, named), filled: before.filled || isFilled(f) });
  });
  let required = 0;
  let filled = 0;
  for (const v of seen.values()) {
    if (!v.required) continue;
    required += 1;
    if (v.filled) filled += 1;
  }
  return { required, filled };
}

function measure(form: HTMLFormElement, named: ReadonlySet<string>): Snapshot {
  const steps = groupsOf(form).map((g) => ({ name: g.name, ...tally(g.fields, named) }));
  return { steps, ...tally(fieldsIn(form), named) };
}

const smoothScroll = () => !(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/**
 * Follows a form between renders: a field typed in or chosen is counted at once; a reset, and a field or value the page changes
 * on its own, once the change is done. The group holding the focus is the current step. Returns how to stop.
 */
function follow(form: HTMLFormElement, scan: () => void, focusIn: (step: number) => void): () => void {
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    void Promise.resolve().then(() => {
      queued = false;
      scan();
    });
  };
  const focused = (event: FocusEvent) => {
    const index = groupsOf(form).findIndex((g) => g.element.contains(event.target as Node) || g.fields.includes(event.target as Field));
    if (index >= 0) focusIn(index);
  };
  form.addEventListener('input', scan);
  form.addEventListener('change', scan);
  form.addEventListener('reset', later);
  form.addEventListener('focusin', focused);
  const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(later);
  observer?.observe(form, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['required', 'aria-required', 'disabled', 'value', 'checked', 'selected'] });
  return () => {
    form.removeEventListener('input', scan);
    form.removeEventListener('change', scan);
    form.removeEventListener('reset', later);
    form.removeEventListener('focusin', focused);
    observer?.disconnect();
  };
}

function Tick() {
  return (
    <svg
      width="13"
      height="13"
      className="size-[13px]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

export function FormProgress({
  form,
  label,
  required,
}: {
  /** The form it follows (its ref). Nothing is shown until the form is on the page. */
  form: RefObject<HTMLFormElement>;
  /** The form's name, for the steps' own name ("Steps of New employee"). */
  label: string;
  /** Fields the form requires in its own check rather than with the required attribute, by the words of their labels. */
  required?: readonly string[];
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const shown = useRef('null');
  const namedKey = (required ?? []).join('\u0000');

  const scan = useCallback(() => {
    const named = new Set(namedKey ? namedKey.split('\u0000') : []);
    const next = form.current ? measure(form.current, named) : null;
    const key = JSON.stringify(next);
    if (key === shown.current) return;
    shown.current = key;
    setSnapshot(next);
  }, [form, namedKey]);
  const latestScan = useRef(scan);
  latestScan.current = scan;
  const focusStep = useCallback((step: number) => setCurrent(step), []);

  // The form being followed, and how to stop following it.
  const followed = useRef<{ form: HTMLFormElement; stop: () => void } | null>(null);

  // After every render of the page: the form may have come, gone or changed its fields. A form newly on the page is followed
  // between renders too: what is typed or chosen, a reset, and fields or values the page changes on its own.
  useEffect(() => {
    const el = form.current;
    if (followed.current?.form !== el) {
      followed.current?.stop();
      followed.current = el ? { form: el, stop: follow(el, () => latestScan.current(), focusStep) } : null;
    }
    scan();
  });
  useEffect(
    () => () => {
      followed.current?.stop();
      followed.current = null;
    },
    [],
  );

  const open = (index: number) => {
    const el = form.current;
    const group = el ? groupsOf(el)[index] : undefined;
    if (!group) return;
    setCurrent(index);
    group.element.scrollIntoView?.({ behavior: smoothScroll() ? 'smooth' : 'auto', block: 'start' });
    const named = new Set(required ?? []);
    const usable = group.fields.filter((f) => !f.matches(':disabled'));
    const target = usable.find((f) => isRequired(f, named) && !isFilled(f)) ?? usable[0];
    target?.focus({ preventScroll: true });
  };

  if (!snapshot || snapshot.steps.length === 0) return null;
  const { steps, required: total, filled } = snapshot;
  const summary = total === 0 ? 'No required fields' : filled === total ? `All ${total} required fields filled` : `${filled} of ${total} required fields filled`;
  return (
    <nav data-slot="form-progress" className={STRIP} aria-label={`Steps of ${label}`}>
      <div className={CARD}>
        <ol className={STEPS}>
          {steps.map((s, i) => {
            const done = s.required > 0 && s.filled === s.required;
            const state = s.required === 0 ? 'No required fields' : done ? 'Complete' : `${s.filled} of ${s.required} required`;
            return (
              <li key={`${i}-${s.name}`} data-state={done ? 'done' : undefined} className={STEP_ITEM}>
                <Button
                  type="button"
                  variant="ghost"
                  className={STEP_BUTTON}
                  aria-label={`Step ${i + 1}: ${s.name}, ${state.toLowerCase()}`}
                  aria-current={current === i ? 'step' : undefined}
                  onClick={() => open(i)}
                >
                  <span className={cn(MARK, markColours(done, current === i))} aria-hidden="true">
                    {done ? <Tick /> : i + 1}
                  </span>
                  <span className="flex min-w-0 flex-col leading-tight" aria-hidden="true">
                    <span className="text-[0.85rem] font-semibold whitespace-nowrap text-foreground">{s.name}</span>
                    <span className={cn(STEP_STATE, done && 'text-[var(--good)]')}>{state}</span>
                  </span>
                </Button>
              </li>
            );
          })}
        </ol>
        {total > 0 && (
          <div className={METER}>
            <div className={TRACK} role="progressbar" aria-label="Required fields filled" aria-valuemin={0} aria-valuemax={total} aria-valuenow={filled} aria-valuetext={summary}>
              <span className={cn(FILL, filled === total && 'bg-[var(--good)]')} style={{ transform: `scaleX(${filled / total})` }} />
            </div>
            <span className={cn(COUNT, filled === total && 'text-[var(--good)]')} aria-hidden="true">
              {summary}
            </span>
          </div>
        )}
      </div>
    </nav>
  );
}
