// The shared screen patterns of Phase 3 (form fields and grids, filter bars, form steps, hints, action bars, back links, confirm steps,
// row actions, the danger button): each keeps the names, roles and words the screens, their tests and the behaviour snapshot rely on.
// Synthetic data only.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Action, ActionBar } from '@/components/action-bar';
import { BackLink } from '@/components/back-link';
import { ConfirmBox } from '@/components/confirm-box';
import { ButtonRow, CheckField, FilterBar, FormField, FormGrid, FormStep } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error');
});
afterEach(() => {
  // React warns about a ref it cannot pass and about invalid nesting (a block inside a paragraph).
  expect(consoleError).not.toHaveBeenCalled();
  consoleError.mockRestore();
  cleanup();
});

describe('form fields', () => {
  it('a field is one label holding its words and its control; the words stay exactly as written', () => {
    render(
      <FormGrid aria-label="Synthetic form">
        <FormField>
          Status{' '}
          <NativeSelect required defaultValue="">
            <option value="">All</option>
            <option value="ON">On</option>
          </NativeSelect>
        </FormField>
        <FormField>
          Name
          <Input maxLength={20} />
        </FormField>
      </FormGrid>,
    );
    const select = screen.getByLabelText('Status') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.required).toBe(true);
    // The label holds the control, so its whole text is the words and then the choices, as the old `<label>Status <select>` read.
    const label = select.closest('label')!;
    expect(label.textContent).toBe('Status AllOn');
    expect(label.getAttribute('for')).toBeNull();
    const name = screen.getByRole('textbox', { name: 'Name' });
    expect(name.closest('label')!.textContent).toBe('Name');
    expect((name as HTMLInputElement).maxLength).toBe(20);
  });

  it('with a hint the field is a shadcn Field: the label, then the lines under it', () => {
    render(
      <FormField hint={<FieldDescription>None is valid on this date.</FieldDescription>}>
        Department
        <NativeSelect defaultValue="">
          <option value="">Choose a department</option>
        </NativeSelect>
      </FormField>,
    );
    const select = screen.getByLabelText('Department');
    const field = select.closest('[data-slot="field"]')!;
    expect(field.children[0]!.tagName).toBe('LABEL');
    expect(field.children[1]!.textContent).toBe('None is valid on this date.');
    expect(field.children[1]!.getAttribute('data-slot')).toBe('field-description');
  });

  it('a checkbox sits beside its words and is named by them', () => {
    render(
      <CheckField>
        <input type="checkbox" defaultChecked /> No manager from this date
      </CheckField>,
    );
    const box = screen.getByRole('checkbox', { name: 'No manager from this date' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.parentElement!.tagName).toBe('LABEL');
  });
});

describe('form grids, filter bars and steps', () => {
  it('a form grid is a named form whose ref reaches the <form>; its steps are fieldsets with their legend first', () => {
    const ref = createRef<HTMLFormElement>();
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <FormGrid ref={ref} aria-label="New synthetic" onSubmit={onSubmit}>
        <FormStep legend="Identity">
          <FormField>
            Code
            <Input />
          </FormField>
        </FormStep>
        <FormStep legend="Terms">
          <FormField>
            Joining date
            <Input type="date" />
          </FormField>
        </FormStep>
        <ButtonRow>
          <Button type="submit">Create</Button>
        </ButtonRow>
      </FormGrid>,
    );
    const form = screen.getByRole('form', { name: 'New synthetic' });
    expect(ref.current).toBe(form);
    expect(Array.from(form.querySelectorAll(':scope > fieldset > legend')).map((l) => l.textContent)).toEqual(['Identity', 'Terms']);
    for (const step of form.querySelectorAll(':scope > fieldset')) {
      expect(step.classList.contains('form-step')).toBe(true);
      expect(step.firstElementChild!.tagName).toBe('LEGEND');
    }
    expect(within(screen.getByRole('group', { name: 'Terms' })).getByLabelText('Joining date')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create' }).parentElement!.getAttribute('data-slot')).toBe('button-row');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('a form grid drawn on another element keeps that element and its role', () => {
    render(
      <FormGrid asChild>
        <div role="group" aria-label="Input period">
          <FormField>
            Month
            <Input type="month" />
          </FormField>
        </div>
      </FormGrid>,
    );
    expect(screen.queryByRole('form')).toBeNull();
    const group = screen.getByRole('group', { name: 'Input period' });
    expect(group.tagName).toBe('DIV');
    expect(group.getAttribute('data-slot')).toBe('form-grid');
    expect(within(group).getByLabelText('Month')).toBeTruthy();
  });

  it('a filter bar is a strip of fields, not a form', () => {
    render(
      <FilterBar>
        <FormField>
          Search <Input placeholder="Name, code or email" />
        </FormField>
      </FilterBar>,
    );
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.getByLabelText('Search').closest('[data-slot="filter-bar"]')!.tagName).toBe('DIV');
    cleanup();
    render(
      <FilterBar asChild>
        <form aria-label="Report filters">
          <FormField>
            From <Input type="date" />
          </FormField>
        </form>
      </FilterBar>,
    );
    expect(screen.getByRole('form', { name: 'Report filters' }).getAttribute('data-slot')).toBe('filter-bar');
  });
});

describe('hints', () => {
  it('a hint is a paragraph whose words are unchanged by its mark; a hint in a sentence is a span with no mark', () => {
    render(
      <>
        <Hint>
          Status: current <Button variant="outline">Clear</Button>
        </Hint>
        <p>
          <Hint as="span">Requested.</Hint>
        </p>
      </>,
    );
    const note = screen.getByText(/^Status: current/);
    expect(note.tagName).toBe('P');
    expect(note.textContent).toBe('Status: current Clear');
    expect(note.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(within(note).getByRole('button', { name: 'Clear' })).toBeTruthy();
    const inline = screen.getByText('Requested.');
    expect(inline.tagName).toBe('SPAN');
    expect(inline.querySelector('svg')).toBeNull();
  });
});

describe('action bars', () => {
  it('each button opens its own form, which stays open while another is used, and closes when it says so', () => {
    render(
      <ActionBar>
        <Action label="Edit details">
          {(close) => (
            <form aria-label="Edit details">
              <Button type="button" onClick={close}>
                Done
              </Button>
            </form>
          )}
        </Action>
        <Action label="Transfer">{() => <form aria-label="Transfer" />}</Action>
      </ActionBar>,
    );
    const edit = screen.getByRole('button', { name: 'Edit details' });
    expect(edit.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('form')).toBeNull();
    fireEvent.click(edit);
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    expect(edit.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('form').map((f) => f.getAttribute('aria-label'))).toEqual(['Edit details', 'Transfer']);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('form', { name: 'Edit details' })).toBeNull();
    expect(edit.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('form', { name: 'Transfer' })).toBeTruthy();
  });
});

describe('back links, confirm steps, row actions and the danger button', () => {
  it('a back link keeps its words and address', () => {
    render(
      <MemoryRouter>
        <BackLink to="/employees">← Employees</BackLink>
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: '← Employees' }).getAttribute('href')).toBe('/employees');
  });

  it('a confirm step has no role of its own: it takes the role it is given, and on a form keeps the form', () => {
    const { rerender } = render(<ConfirmBox>Are you sure?</ConfirmBox>);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Are you sure?').getAttribute('role')).toBeNull();
    rerender(
      <ConfirmBox role="group" aria-label="Confirm your resignation">
        <p>You are resigning.</p>
      </ConfirmBox>,
    );
    expect(screen.getByRole('group', { name: 'Confirm your resignation' }).getAttribute('data-slot')).toBe('alert');
    rerender(
      <ConfirmBox asChild>
        <form aria-label="Delete syn.one">
          <Button type="submit" variant="danger">
            Delete
          </Button>
        </form>
      </ConfirmBox>,
    );
    const form = screen.getByRole('form', { name: 'Delete syn.one' });
    expect(form.getAttribute('role')).toBeNull();
    expect(form.getAttribute('data-slot')).toBe('alert');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('row actions sit side by side; an action that removes something is the outlined red button', () => {
    render(
      <table>
        <tbody>
          <tr>
            <td className="min-[561px]:w-px">
              <RowActions>
                <Button variant="outline" size="sm">
                  Edit
                </Button>{' '}
                <Button variant="danger" size="sm">
                  Remove
                </Button>
              </RowActions>
            </td>
          </tr>
        </tbody>
      </table>,
    );
    const remove = screen.getByRole('button', { name: 'Remove' });
    expect(remove.getAttribute('data-variant')).toBe('danger');
    expect(remove.parentElement!.getAttribute('data-slot')).toBe('row-actions');
    expect(screen.getByRole('cell').textContent).toBe('Edit Remove');
  });
});
