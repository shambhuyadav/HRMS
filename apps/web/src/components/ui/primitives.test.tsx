// The shadcn/ui primitives under React 18, and the ui.tsx pieces built on them: refs reach the DOM element, and each piece keeps
// the element, role, words and marker classes the screens, their tests and the contextual rules of styles.css rely on.
// Synthetic data only.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge as BadgePrimitive } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '../../api';
import { Badge, CompactEmptyContext, Empty, ErrorNote, NotPermitted, Notice, PageTitleContext, Pager, Section, SortHeader, StateBadge } from '../../ui';

const classes = (el: Element) => el.className.split(/\s+/);

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error');
});
afterEach(() => {
  // React 18 warns when a ref is given to a function component that does not forward it.
  expect(consoleError).not.toHaveBeenCalled();
  consoleError.mockRestore();
  cleanup();
});

describe('primitives pass refs to the DOM element (React 18)', () => {
  it('Button, also as its child element', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Save</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Save' }));

    const link = createRef<HTMLButtonElement>();
    render(
      <Button asChild ref={link} variant="outline">
        <a href="/synthetic">Open</a>
      </Button>,
    );
    expect(link.current).toBeInstanceOf(HTMLAnchorElement);
    expect(link.current?.getAttribute('data-slot')).toBe('button');
  });

  it('Input, Textarea and the select of NativeSelect', () => {
    const input = createRef<HTMLInputElement>();
    const area = createRef<HTMLTextAreaElement>();
    const select = createRef<HTMLSelectElement>();
    render(
      <>
        <Input ref={input} aria-label="Name" />
        <Textarea ref={area} aria-label="Reason" rows={4} />
        <NativeSelect ref={select} aria-label="Type" defaultValue="b">
          <NativeSelectOption value="a">A</NativeSelectOption>
          <NativeSelectOption value="b">B</NativeSelectOption>
        </NativeSelect>
      </>,
    );
    expect(input.current).toBe(screen.getByRole('textbox', { name: 'Name' }));
    expect(area.current).toBe(screen.getByRole('textbox', { name: 'Reason' }));
    expect(area.current?.rows).toBe(4);
    expect(select.current).toBe(screen.getByRole('combobox', { name: 'Type' }));
    expect(select.current?.value).toBe('b');
  });

  it('Label and FieldLabel', () => {
    const label = createRef<HTMLLabelElement>();
    const fieldLabel = createRef<HTMLLabelElement>();
    render(
      <>
        <Label ref={label} htmlFor="one">
          One
        </Label>
        <input id="one" />
        <FieldLabel ref={fieldLabel} htmlFor="two">
          Two
        </FieldLabel>
        <input id="two" />
      </>,
    );
    expect(label.current).toBeInstanceOf(HTMLLabelElement);
    expect(fieldLabel.current).toBeInstanceOf(HTMLLabelElement);
    expect(screen.getByLabelText('Two').id).toBe('two');
  });

  it('a button keeps the native type and disabled state it is given', () => {
    const onClick = vi.fn();
    render(
      <>
        <Button type="button" onClick={onClick}>
          Go
        </Button>
        <Button disabled onClick={onClick}>
          Stop
        </Button>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Go' }).getAttribute('type')).toBe('button');
    expect((screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('an alert on the caller’s own element takes that element’s role', () => {
    render(
      <Alert asChild variant="success">
        <p role="status">Saved.</p>
      </Alert>,
    );
    const status = screen.getByRole('status');
    expect(status.tagName).toBe('P');
    expect(status.getAttribute('data-slot')).toBe('alert');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an alert title and description can be the caller’s own elements', () => {
    render(
      <Alert>
        <AlertTitle asChild>
          <strong>Title</strong>
        </AlertTitle>
        <AlertDescription>Line</AlertDescription>
      </Alert>,
    );
    expect(screen.getByText('Title').tagName).toBe('STRONG');
    expect(screen.getByText('Title').getAttribute('data-slot')).toBe('alert-title');
  });

  it('a badge tone keeps its tint beside the dot drawn as a background image', () => {
    render(<BadgePrimitive variant="good">ok</BadgePrimitive>);
    expect(classes(screen.getByText('ok'))).toContain('bg-[var(--good-soft)]');
  });
});

describe('ui.tsx pieces keep their markup', () => {
  it('Badge and StateBadge: a span with the badge classes, inline-block for the raised first letter', () => {
    render(
      <>
        <Badge tone="good">active</Badge>
        <StateBadge state="MANAGER_PENDING" />
        <StateBadge state={null} />
      </>,
    );
    const good = screen.getByText('active');
    expect(good.tagName).toBe('SPAN');
    expect(classes(good)).toEqual(expect.arrayContaining(['badge', 'badge-good', 'inline-block', 'bg-[var(--good-soft)]']));
    expect(classes(good)).not.toContain('inline-flex');
    expect(classes(screen.getByText('manager pending'))).toEqual(expect.arrayContaining(['badge', 'badge-warn']));
    expect(classes(screen.getByText('—'))).toEqual(expect.arrayContaining(['badge', 'badge-neutral']));
  });

  it('ErrorNote: one alert with the message and code first, then the details in order', () => {
    render(
      <ErrorNote
        error={new ApiError(422, 'ACTIVATION_REQUIREMENTS_MISSING', 'The employee cannot be activated yet', { missing: ['WORK_EMAIL'], errors: [{ line: 2, code: 'BAD' }] })}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.tagName).toBe('DIV');
    expect(classes(alert)).toContain('error');
    expect(alert.querySelector(':scope > strong')?.textContent).toBe('The employee cannot be activated yet (ACTIVATION_REQUIREMENTS_MISSING)');
    expect(alert.textContent).toBe('The employee cannot be activated yet (ACTIVATION_REQUIREMENTS_MISSING)Missing: WORK_EMAILline 2: BAD');
  });

  it('ErrorNote: the bare refusal explains itself and keeps its code', () => {
    render(<ErrorNote error={new ApiError(403, 'FORBIDDEN', 'Not permitted')} />);
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('strong')?.textContent).toBe('Not permitted');
    expect(alert.querySelector('.error-code')?.textContent).toBe('FORBIDDEN');
    expect(alert.textContent).toBe(
      'Not permittedThe selected role does not allow this. Switch to a role that does, or ask your administrator for access. FORBIDDEN',
    );
  });

  it('ErrorNote: nothing without an error, and a plain line for an unknown one', () => {
    const { container } = render(<ErrorNote error={null} />);
    expect(container.innerHTML).toBe('');
    render(<ErrorNote error={new Error('x')} />);
    expect(screen.getByRole('alert').textContent).toBe('Something went wrong');
  });

  it('Notice: a status paragraph when it worked, an alert paragraph when it did not', () => {
    const { rerender } = render(<Notice notice={{ text: 'Saved.', ok: true }} />);
    const status = screen.getByRole('status');
    expect(status.tagName).toBe('P');
    expect(classes(status)).toContain('ok');
    expect(status.textContent).toBe('Saved.');
    expect(screen.getByText('Saved.')).toBe(status);
    rerender(<Notice notice={{ text: 'Could not save.', ok: false }} />);
    const alert = screen.getByRole('alert');
    expect(alert.tagName).toBe('P');
    expect(classes(alert)).toContain('error');
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<Notice notice={null} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('NotPermitted: a note paragraph opening with the "not permitted" badge', () => {
    render(<NotPermitted>The selected role cannot approve claims.</NotPermitted>);
    const note = screen.getByRole('note');
    expect(note.tagName).toBe('P');
    const badge = note.firstElementChild!;
    expect(badge.textContent).toBe('not permitted');
    expect(classes(badge)).toEqual(expect.arrayContaining(['badge', 'badge-warn']));
    expect(note.textContent).toBe('not permitted The selected role cannot approve claims.');
  });

  it('Empty: a paragraph, compact inside CompactEmptyContext', () => {
    render(
      <CompactEmptyContext.Provider value={true}>
        <Empty refusal>Hidden from this role.</Empty>
      </CompactEmptyContext.Provider>,
    );
    const line = screen.getByText('Hidden from this role.');
    expect(line.tagName).toBe('P');
    expect(line.className).toBe('empty compact empty-refusal');
  });

  it('SortHeader: a column heading with its order announced and a button that sorts', () => {
    const onSort = vi.fn();
    const table = (children: ReactNode) => (
      <table>
        <thead>
          <tr>{children}</tr>
        </thead>
      </table>
    );
    const { rerender } = render(table(<SortHeader column="name" label="Name" sort={{ column: 'name', direction: 'ASC' }} onSort={onSort} />));
    const head = screen.getByRole('columnheader');
    expect(head.getAttribute('scope')).toBe('col');
    expect(head.getAttribute('aria-sort')).toBe('ascending');
    const button = within(head).getByRole('button', { name: 'Name ▲' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.parentElement).toBe(head);
    fireEvent.click(button);
    expect(onSort).toHaveBeenCalledWith('name');
    rerender(table(<SortHeader column="name" label="Name" sort={{ column: 'name', direction: 'DESC' }} onSort={onSort} />));
    expect(screen.getByRole('columnheader').getAttribute('aria-sort')).toBe('descending');
    expect(screen.getByRole('button').textContent).toBe('Name ▼');
    rerender(table(<SortHeader column="name" label="Name" sort={{ column: 'code', direction: 'ASC' }} onSort={onSort} />));
    expect(screen.getByRole('columnheader').getAttribute('aria-sort')).toBe('none');
    expect(screen.getByRole('button').textContent).toBe('Name');
  });

  it('Pager: a named navigation with previous, the count and next', () => {
    const onPage = vi.fn();
    const { container, rerender } = render(<Pager page={1} pageSize={25} total={60} onPage={onPage} label="Claim pages" noun="claim" />);
    const nav = screen.getByRole('navigation', { name: 'Claim pages' });
    expect(classes(nav)).toContain('pager');
    expect(nav.textContent).toBe('Previous pagePage 1 of 3 · 60 claimsNext page');
    const previous = within(nav).getByRole('button', { name: 'Previous page' }) as HTMLButtonElement;
    const next = within(nav).getByRole('button', { name: 'Next page' }) as HTMLButtonElement;
    expect(previous.type).toBe('button');
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect(onPage).toHaveBeenCalledWith(2);
    rerender(<Pager page={1} pageSize={25} total={1} onPage={onPage} label="Claim pages" noun="claim" />);
    expect(container.innerHTML).toBe('');
  });

  it('Section: a card section whose header holds the h2 and the actions, children directly inside', () => {
    render(
      <Section title="Claims" actions={<a href="/new">New claim</a>}>
        <p className="hint">Synthetic note.</p>
      </Section>,
    );
    const section = screen.getByRole('heading', { level: 2, name: 'Claims' }).closest('section')!;
    expect(classes(section)).toEqual(expect.arrayContaining(['card', 'rounded-xl', 'border', 'bg-card', 'shadow-sm']));
    const header = section.querySelector(':scope > header')!;
    expect(classes(header)).toContain('card-header');
    expect(classes(header)).not.toContain('card-header-plain');
    expect(header.querySelector(':scope > h2')?.textContent).toBe('Claims');
    expect(header.querySelector(':scope > a')?.textContent).toBe('New claim');
    expect(section.querySelector(':scope > p.hint')?.textContent).toBe('Synthetic note.');
  });

  it('Section under a page of the same title: the h2 for assistive technology only, the count and actions kept', () => {
    render(
      <PageTitleContext.Provider value="Employees">
        <Section title="Employees (16)" actions={<a href="/new">Add</a>}>
          <table />
        </Section>
      </PageTitleContext.Provider>,
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'Employees (16)' });
    expect(heading.className).toBe('sr-only');
    const section = heading.closest('section')!;
    expect(heading.parentElement).toBe(section);
    const header = section.querySelector(':scope > header')!;
    expect(classes(header)).toEqual(expect.arrayContaining(['card-header', 'card-header-plain']));
    expect(header.querySelector(':scope > .card-count')?.textContent).toBe('16 in total');
    expect(header.querySelector(':scope > a')?.textContent).toBe('Add');
    expect(section.querySelector(':scope > table')).not.toBeNull();
  });
});
