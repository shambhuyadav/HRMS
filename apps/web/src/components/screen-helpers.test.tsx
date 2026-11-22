// The helpers promoted from the screens' own copies in the cleanup of 22 Nov 2026 (status notes, loading and hint lines, warning
// notes, card subheadings, pagers, tabs and segmented choices, row action cells, fieldsets, the in-sentence button, the information
// badge), and NativeSelect's list box rows: each keeps the element, role, name and words the screens, their tests and the behaviour snapshot rely on.
// Synthetic data only.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef, type FormEvent } from 'react';
import { MemoryRouter, Link } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardSubheading } from '@/components/card-subheading';
import { ChoiceRow, CheckField, FormGrid, FramedFieldset, LabelledFieldset } from '@/components/form-field';
import { HintLine } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { PagerButton, PagerCount, PagerRow } from '@/components/pager';
import { RowActions, RowActionsCell, RowPanel } from '@/components/row-actions';
import { NothingChanged, StatusNote } from '@/components/status-note';
import { SegmentedChoice, SegmentedOption, Tab, TabList } from '@/components/tab-list';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableRow } from '@/components/ui/table';
import { Badge, WarningNote } from '../ui';

const classes = (el: Element) => el.className.split(/\s+/);

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

describe('StatusNote', () => {
  it('a success whose words hold a link: one paragraph, its role as given, the sentence kept in one run of text', () => {
    render(
      <MemoryRouter>
        <StatusNote tone="success" role="status">
          The plan TRN-009 was created. <Link to="/training/plans/1">Open the plan</Link>
        </StatusNote>
      </MemoryRouter>,
    );
    const note = screen.getByRole('status');
    expect(note.tagName).toBe('P');
    expect(note.getAttribute('data-slot')).toBe('alert');
    expect(note.textContent).toBe('The plan TRN-009 was created. Open the plan');
    // The mark, then one wrapper holding the words and the link (an Alert's grid would put the link on a row of its own).
    expect(note.children).toHaveLength(2);
    expect(note.children[0]!.tagName.toLowerCase()).toBe('svg');
    expect(note.children[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(within(note.children[1] as HTMLElement).getByRole('link', { name: 'Open the plan' }).getAttribute('href')).toBe('/training/plans/1');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a problem announced at once, and a line with no role at all', () => {
    render(
      <>
        <StatusNote tone="error" role="alert" id="blocked">
          A mandatory value is missing.
        </StatusNote>
        <StatusNote tone="success">Request submitted for review.</StatusNote>
      </>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.id).toBe('blocked');
    expect(alert.textContent).toBe('A mandatory value is missing.');
    const shown = screen.getByText('Request submitted for review.').closest('p')!;
    expect(shown.getAttribute('role')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('each tone has its own look; information and warning lines too', () => {
    render(
      <>
        <StatusNote tone="info" role="status">
          26 days
        </StatusNote>
        <StatusNote tone="warning">Check the dates.</StatusNote>
        <StatusNote tone="success" className="m-0">
          Saved.
        </StatusNote>
      </>,
    );
    expect(classes(screen.getByRole('status'))).toContain('bg-[var(--info-soft)]');
    expect(classes(screen.getByText('Check the dates.').closest('p')!)).toContain('bg-[var(--warn-soft)]');
    expect(classes(screen.getByText('Saved.').closest('p')!)).toEqual(expect.arrayContaining(['bg-[var(--good-soft)]', 'm-0']));
  });

  it('NothingChanged: an informational status', () => {
    render(<NothingChanged />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Nothing changed.');
    expect(classes(status)).toContain('bg-[var(--info-soft)]');
  });
});

describe('lines', () => {
  it('LoadingLine: a quiet paragraph with no role', () => {
    render(<LoadingLine>Loading the register…</LoadingLine>);
    const line = screen.getByText('Loading the register…');
    expect(line.tagName).toBe('P');
    expect(line.getAttribute('role')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('HintLine: a muted line of its own inside a cell, as a span', () => {
    render(
      <p>
        <strong>Asha Synthetic</strong>
        <HintLine>SYN-001</HintLine>
      </p>,
    );
    const line = screen.getByText('SYN-001');
    expect(line.tagName).toBe('SPAN');
    expect(line.getAttribute('data-slot')).toBe('hint');
    expect(classes(line)).toContain('block');
  });
});

describe('WarningNote and the information badge', () => {
  it('a note opening with a badge of its own words, the badge on the card colour', () => {
    render(
      <WarningNote badge="payroll locked">A processed payroll used this day, so its attendance can no longer change here.</WarningNote>,
    );
    const note = screen.getByRole('note');
    expect(note.tagName).toBe('P');
    expect(note.textContent).toBe('payroll locked A processed payroll used this day, so its attendance can no longer change here.');
    const badge = note.firstElementChild!;
    expect(badge.textContent).toBe('payroll locked');
    expect(classes(badge)).toEqual(expect.arrayContaining(['badge', 'badge-warn', 'bg-card']));
  });

  it('a warning that reports what an action did is a status', () => {
    render(<WarningNote badge="changed" role="status">The grant was changed by someone else.</WarningNote>);
    expect(screen.getByRole('status').textContent).toBe('changed The grant was changed by someone else.');
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('Badge has an information tone, keeping the badge-info marker class', () => {
    render(<Badge tone="info">new</Badge>);
    const badge = screen.getByText('new');
    expect(badge.tagName).toBe('SPAN');
    expect(classes(badge)).toEqual(expect.arrayContaining(['badge', 'badge-info', 'inline-block', 'bg-[var(--info-soft)]']));
  });
});

describe('CardSubheading', () => {
  it('an h3 by default, an h4 when the outline needs one; the ref and id reach the heading', () => {
    const ref = createRef<HTMLHeadingElement>();
    render(
      <>
        <CardSubheading id="part-title" ref={ref} tabIndex={-1}>
          Lines
        </CardSubheading>
        <CardSubheading level={4}>Earlier snapshots</CardSubheading>
      </>,
    );
    const h3 = screen.getByRole('heading', { level: 3, name: 'Lines' });
    expect(h3.id).toBe('part-title');
    expect(ref.current).toBe(h3);
    expect(h3.tabIndex).toBe(-1);
    expect(screen.getByRole('heading', { level: 4, name: 'Earlier snapshots' })).toBeTruthy();
  });
});

describe('pager parts', () => {
  it('a row of outline buttons that never send a form, around the count', () => {
    const onSubmit = vi.fn((e: FormEvent) => e.preventDefault());
    const onNext = vi.fn();
    render(
      <form aria-label="Synthetic list" onSubmit={onSubmit}>
        <PagerRow role="navigation" aria-label="Batch pages">
          <PagerButton disabled>Newer batches</PagerButton>
          <PagerCount>Page 1 of 3</PagerCount>
          <PagerButton onClick={onNext}>Older batches</PagerButton>
        </PagerRow>
      </form>,
    );
    const nav = screen.getByRole('navigation', { name: 'Batch pages' });
    expect(nav.textContent).toBe('Newer batchesPage 1 of 3Older batches');
    const newer = within(nav).getByRole('button', { name: 'Newer batches' }) as HTMLButtonElement;
    const older = within(nav).getByRole('button', { name: 'Older batches' }) as HTMLButtonElement;
    expect(newer.disabled).toBe(true);
    expect(older.type).toBe('button');
    fireEvent.click(older);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(classes(screen.getByText('Page 1 of 3'))).toContain('tabular-nums');
  });

  it('a pager line has no role unless the screen gives it one', () => {
    const { container } = render(
      <PagerRow>
        <PagerButton>Next lines</PagerButton>
      </PagerRow>,
    );
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(container.firstElementChild!.getAttribute('role')).toBeNull();
  });
});

describe('tabs and segmented choices', () => {
  it('a tab list of buttons with role tab, the chosen one selected; refs reach the buttons', () => {
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <TabList aria-label="Synthetic views">
        <Tab ref={ref} selected id="t-all" aria-controls="panel" tabIndex={0}>
          All
        </Tab>
        <Tab selected={false} id="t-due" aria-controls="panel" tabIndex={-1} onClick={onClick}>
          Due (2)
        </Tab>
      </TabList>,
    );
    const list = screen.getByRole('tablist', { name: 'Synthetic views' });
    const all = within(list).getByRole('tab', { name: 'All' });
    expect(ref.current).toBe(all);
    expect(all.getAttribute('aria-selected')).toBe('true');
    expect(all.getAttribute('type')).toBe('button');
    const due = within(list).getByRole('tab', { name: 'Due (2)' });
    expect(due.getAttribute('aria-selected')).toBe('false');
    fireEvent.click(due);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a segmented choice: toggle buttons, the chosen one pressed, the strip with no role', () => {
    const { container } = render(
      <SegmentedChoice>
        <SegmentedOption pressed>Waiting for review</SegmentedOption>
        <SegmentedOption pressed={false}>Active</SegmentedOption>
      </SegmentedChoice>,
    );
    expect(container.firstElementChild!.getAttribute('role')).toBeNull();
    expect(screen.getByRole('button', { name: 'Waiting for review' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Active' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('row actions cell', () => {
  it('as narrow as its buttons above phone width, wider while a form shows in it', () => {
    const table = (expanded: boolean) => (
      <Table aria-label="Synthetic rows">
        <TableBody>
          <TableRow>
            <RowActionsCell expanded={expanded}>
              <RowActions>
                <Button variant="outline" size="sm">
                  Edit
                </Button>
              </RowActions>
              {expanded && <RowPanel>Synthetic form</RowPanel>}
            </RowActionsCell>
          </TableRow>
        </TableBody>
      </Table>
    );
    const { rerender } = render(table(false));
    const cell = screen.getByRole('cell');
    expect(classes(cell)).toContain('min-[561px]:w-px');
    rerender(table(true));
    expect(classes(screen.getByRole('cell'))).not.toContain('min-[561px]:w-px');
    expect(classes(screen.getByText('Synthetic form'))).toEqual(expect.arrayContaining(['mt-3', 'min-[561px]:min-w-[31rem]', 'phone:basis-full']));
  });
});

describe('fieldsets', () => {
  it('framed and frameless fieldsets are groups named by their legends, spanning a form grid', () => {
    render(
      <FormGrid aria-label="Synthetic form">
        <FramedFieldset legend="Goal 1">
          <input aria-label="Description" />
        </FramedFieldset>
        <LabelledFieldset legend="Consent">
          <ChoiceRow>
            <CheckField>
              <input type="radio" name="consent" /> Given
            </CheckField>
            <CheckField>
              <input type="radio" name="consent" /> Withdrawn
            </CheckField>
          </ChoiceRow>
        </LabelledFieldset>
      </FormGrid>,
    );
    const goal = screen.getByRole('group', { name: 'Goal 1' });
    expect(goal.tagName).toBe('FIELDSET');
    expect(goal.querySelector(':scope > legend')?.textContent).toBe('Goal 1');
    expect(classes(goal)).toEqual(expect.arrayContaining(['rounded-md', 'border']));
    const consent = screen.getByRole('group', { name: 'Consent' });
    expect(consent.tagName).toBe('FIELDSET');
    expect(within(consent).getByRole('radio', { name: 'Given' })).toBeTruthy();
    expect(classes(consent)).not.toContain('border');
  });
});

describe('NativeSelect list boxes', () => {
  it('rows sets the list box’s visible rows; a list box has no chevron and no padding above and below its rows', () => {
    const ref = createRef<HTMLSelectElement>();
    render(
      <>
        <NativeSelect ref={ref} aria-label="Departments" multiple rows={3} defaultValue={['b']}>
          <option value="a">A</option>
          <option value="b">B</option>
          <option value="c">C</option>
        </NativeSelect>
        <NativeSelect aria-label="Status" size="sm" defaultValue="">
          <option value="">All</option>
        </NativeSelect>
      </>,
    );
    const listBox = screen.getByRole('listbox', { name: 'Departments' }) as HTMLSelectElement;
    expect(ref.current).toBe(listBox);
    expect(listBox.size).toBe(3);
    expect(listBox.multiple).toBe(true);
    expect(classes(listBox)).toEqual(expect.arrayContaining(['h-auto', 'py-0']));
    expect(listBox.parentElement!.querySelector('[data-slot=native-select-icon]')).toBeNull();
    const dropDown = screen.getByRole('combobox', { name: 'Status' }) as HTMLSelectElement;
    expect(dropDown.getAttribute('size')).toBeNull();
    expect(dropDown.getAttribute('data-size')).toBe('sm');
    expect(dropDown.parentElement!.querySelector('[data-slot=native-select-icon]')).not.toBeNull();
  });
});

describe('the in-sentence button', () => {
  it('a link-styled button with no box of its own, still a button', () => {
    render(
      <p>
        Showing page 3.{' '}
        <Button type="button" variant="link" size="inline">
          Back to the first page
        </Button>
      </p>,
    );
    const button = screen.getByRole('button', { name: 'Back to the first page' });
    expect(button.getAttribute('data-size')).toBe('inline');
    expect(classes(button)).toEqual(expect.arrayContaining(['h-auto', 'p-0', 'align-baseline']));
    expect(classes(button)).not.toContain('h-[var(--control-h)]');
  });
});
