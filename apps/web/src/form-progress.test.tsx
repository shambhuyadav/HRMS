// Progress through a long form (form-progress.tsx), jsdom: the form's own groups as numbered steps, what counts as a required field
// and as filled, a step that takes the cursor to its group, and fields the page adds later. The form itself is left as it is.
// Synthetic data only.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fieldName, FormProgress } from './form-progress';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Grouped({ required }: { required?: string[] }) {
  const ref = useRef<HTMLFormElement>(null);
  const [more, setMore] = useState(false);
  return (
    <>
      <FormProgress form={ref} label="Synthetic form" {...(required ? { required } : {})} />
      <form ref={ref} aria-label="Synthetic form" onSubmit={(e) => e.preventDefault()}>
        <fieldset>
          <legend>Who</legend>
          <label>
            Full name
            <input required />
          </label>
          <label>
            Nickname
            <input />
          </label>
        </fieldset>
        <fieldset>
          <legend>Where</legend>
          <label>
            City
            <select required defaultValue="">
              <option value="">Choose a city</option>
              <option value="SYN">Synthetic city</option>
            </select>
          </label>
          <fieldset>
            <legend>Kind of place</legend>
            <label>
              <input type="radio" name="kind" value="HOME" required /> Home
            </label>
            <label>
              <input type="radio" name="kind" value="WORK" required /> Work
            </label>
          </fieldset>
          <label>
            Notes
            <textarea />
          </label>
        </fieldset>
        <fieldset>
          <legend>Extras</legend>
          <label>
            Code
            <input />
          </label>
          {more && (
            <label>
              Reference
              <input required />
            </label>
          )}
        </fieldset>
        <input type="hidden" name="token" required value="x" />
        <button type="button" onClick={() => setMore(true)}>
          Ask for a reference
        </button>
      </form>
    </>
  );
}

const steps = () => within(screen.getByRole('navigation', { name: 'Steps of Synthetic form' })).getAllByRole('button');
const stepNames = () => steps().map((b) => b.getAttribute('aria-label'));
const meter = () => screen.getByRole('progressbar', { name: 'Required fields filled' });
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('steps of a long form', () => {
  it('shows the outermost groups as numbered steps, with their required fields, and the share filled', () => {
    render(<Grouped />);
    expect(stepNames()).toEqual(['Step 1: Who, 0 of 1 required', 'Step 2: Where, 0 of 2 required', 'Step 3: Extras, no required fields']);
    expect(meter().getAttribute('aria-valuenow')).toBe('0');
    expect(meter().getAttribute('aria-valuemax')).toBe('3');
    expect(meter().getAttribute('aria-valuetext')).toBe('0 of 3 required fields filled');
    // A step shows its number, its name and what is left; a hidden value is not a field to fill.
    expect(steps()[0]!.textContent).toBe('1Who0 of 1 required');
  });

  it('counts what is typed or chosen; blank text is not filled; a set of radio buttons is one field; a complete step is ticked', () => {
    render(<Grouped />);
    type('Full name', '   ');
    expect(stepNames()[0]).toBe('Step 1: Who, 0 of 1 required');
    type('Full name', 'Synthetic Person');
    expect(stepNames()[0]).toBe('Step 1: Who, complete');
    expect(steps()[0]!.closest('li')!.className).toBe('done');
    expect(steps()[0]!.querySelector('svg')).toBeTruthy();
    type('City', 'SYN');
    expect(stepNames()[1]).toBe('Step 2: Where, 1 of 2 required');
    fireEvent.click(screen.getByLabelText('Work'));
    expect(stepNames()[1]).toBe('Step 2: Where, complete');
    expect(meter().getAttribute('aria-valuetext')).toBe('All 3 required fields filled');
    expect(screen.getByText('All 3 required fields filled')).toBeTruthy();
  });

  it('follows a field the page adds later', async () => {
    render(<Grouped />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask for a reference' }));
    await waitFor(() => expect(stepNames()[2]).toBe('Step 3: Extras, 0 of 1 required'));
    expect(meter().getAttribute('aria-valuemax')).toBe('4');
  });

  it('counts the fields a form checks in its own code, named by their labels', () => {
    render(<Grouped required={['Nickname', 'Code']} />);
    expect(stepNames()).toEqual(['Step 1: Who, 0 of 2 required', 'Step 2: Where, 0 of 2 required', 'Step 3: Extras, 0 of 1 required']);
    type('Code', 'SYN-1');
    expect(stepNames()[2]).toBe('Step 3: Extras, complete');
  });

  it('a step moves to its group and puts the cursor in its first field still to fill', () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      render(<Grouped />);
      type('City', 'SYN');
      fireEvent.click(steps()[1]!);
      expect(document.activeElement).toBe(screen.getByLabelText('Home'));
      expect(scrolled.map((el) => el.querySelector(':scope > legend')?.textContent)).toEqual(['Where']);
      expect(steps()[1]!.getAttribute('aria-current')).toBe('step');
      // A step with nothing to fill puts the cursor in its first field.
      fireEvent.click(steps()[2]!);
      expect(document.activeElement).toBe(screen.getByLabelText('Code'));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('the step holding the cursor is the current one', () => {
    render(<Grouped />);
    fireEvent.focusIn(screen.getByLabelText('Notes'));
    expect(steps()[1]!.getAttribute('aria-current')).toBe('step');
    expect(steps()[0]!.getAttribute('aria-current')).toBeNull();
  });

  it('a form divided by headings rather than fieldsets has a step for each heading', () => {
    function Headed() {
      const ref = useRef<HTMLFormElement>(null);
      return (
        <>
          <FormProgress form={ref} label="Synthetic form" />
          <form ref={ref} aria-label="Synthetic form">
            <h3>Period</h3>
            <label>
              From
              <input type="date" required />
            </label>
            <input aria-label="Until" type="date" required defaultValue="2026-12-31" />
            <h3>Amounts</h3>
            <div>
              <label>
                Amount
                <input required />
              </label>
            </div>
          </form>
        </>
      );
    }
    render(<Headed />);
    expect(stepNames()).toEqual(['Step 1: Period, 1 of 2 required', 'Step 2: Amounts, 0 of 1 required']);
  });

  it('shows nothing without a form, or for a form without groups', () => {
    function Missing() {
      const ref = useRef<HTMLFormElement>(null);
      return <FormProgress form={ref} label="Synthetic form" />;
    }
    render(<Missing />);
    expect(screen.queryByRole('navigation')).toBeNull();
    cleanup();

    function Flat() {
      const ref = useRef<HTMLFormElement>(null);
      return (
        <>
          <FormProgress form={ref} label="Synthetic form" />
          <form ref={ref} aria-label="Synthetic form">
            <label>
              Only field
              <input required />
            </label>
          </form>
        </>
      );
    }
    render(<Flat />);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByRole('form', { name: 'Synthetic form' })).toBeTruthy();
  });

  it('a field’s name leaves out the words of the choices inside its label', () => {
    render(
      <label>
        Delimiter{' '}
        <select>
          <option>Comma</option>
          <option>Pipe</option>
        </select>
      </label>,
    );
    expect(fieldName(screen.getByLabelText('Delimiter') as HTMLSelectElement)).toBe('Delimiter');
  });
});
