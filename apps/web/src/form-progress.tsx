// Progress through a long form (owner's request of 20 Nov 2026: "long forms grouped into steps with a progress indicator"). The
// form keeps every field on the page, in its order, with its own state and its own checks: this only reads the form as it stands
// and shows its groups as numbered steps, each ticked once its required fields are filled, with the share of the form's required
// fields filled so far. Choosing a step moves to that group and puts the cursor in its first field still to fill.
//
// The groups are the form's own: its outermost fieldsets with a legend, or else the headings that divide it. A field is required
// when it says so (required or aria-required), or when the page names it in `required` because the form checks it in code rather
// than with the attribute. Nothing here changes what the form sends or refuses.

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import './styles/form-progress.css';

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
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
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
    <nav className="form-progress" aria-label={`Steps of ${label}`}>
      <div className="form-progress-card">
        <ol className="form-progress-steps">
          {steps.map((s, i) => {
            const done = s.required > 0 && s.filled === s.required;
            const state = s.required === 0 ? 'No required fields' : done ? 'Complete' : `${s.filled} of ${s.required} required`;
            return (
              <li key={`${i}-${s.name}`} className={done ? 'done' : undefined}>
                <button type="button" aria-label={`Step ${i + 1}: ${s.name}, ${state.toLowerCase()}`} aria-current={current === i ? 'step' : undefined} onClick={() => open(i)}>
                  <span className="form-progress-mark" aria-hidden="true">
                    {done ? <Tick /> : i + 1}
                  </span>
                  <span className="form-progress-text" aria-hidden="true">
                    <span className="form-progress-name">{s.name}</span>
                    <span className="form-progress-state">{state}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        {total > 0 && (
          <div className={filled === total ? 'form-progress-meter complete' : 'form-progress-meter'}>
            <div className="form-progress-track" role="progressbar" aria-label="Required fields filled" aria-valuemin={0} aria-valuemax={total} aria-valuenow={filled} aria-valuetext={summary}>
              <span className="form-progress-fill" style={{ transform: `scaleX(${filled / total})` }} />
            </div>
            <span className="form-progress-count" aria-hidden="true">
              {summary}
            </span>
          </div>
        )}
      </div>
    </nav>
  );
}
