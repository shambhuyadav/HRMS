// The Home dashboard's chart pieces (owner's request of 20 Nov 2026: charts beside the number tiles): a card whose chart has a
// table view, a thin segmented bar, a legend and a hover/focus tooltip. Marks follow the dataviz method: thin bars with 2px gaps
// of the surface between parts, a legend whenever there are two or more series, values in text colours (never a series colour),
// and every value a tooltip shows also readable in the table view. Colours are CSS custom properties only (dashboard-charts.css
// maps each fill name to a token), so the charts follow the light and dark themes.

import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { Section } from '../../ui';
import '../../styles/dashboard-charts.css';

/**
 * What a mark is filled with, by meaning: the status set (good, warn, bad, info), a day off, a day not yet calculated, or the
 * first categorical series with its lighter step and the track behind a part-of-whole bar.
 */
export type Fill = 'good' | 'warn' | 'bad' | 'info' | 'off' | 'none' | 'series1' | 'series1-soft' | 'track';

/**
 * A chart in a dashboard card: its title, the chart, and a button that swaps the chart for a table holding the same numbers (the
 * chart's text equivalent, so nothing is told by colour or by a tooltip alone). Without a table there is no button.
 */
export function ChartCard({ title, table, foot, children }: { title: string; table?: ReactNode; foot?: ReactNode; children: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  const toggle = table ? (
    <button type="button" className="link dash-chart-toggle" onClick={() => setAsTable((v) => !v)}>
      {asTable ? 'Show as chart' : 'Show as table'}
    </button>
  ) : undefined;
  return (
    <Section title={title} actions={toggle}>
      {asTable && table ? table : children}
      {foot}
    </Section>
  );
}

/** Where a tooltip points: the target's horizontal centre and its top and bottom, in the frame's coordinates. */
export interface TipAt {
  x: number;
  top: number;
  bottom: number;
  content: ReactNode;
}

/** One tooltip per chart frame: shown beside the hovered or focused mark, hidden when the pointer or focus leaves. */
export function useChartTip() {
  const frame = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<TipAt | null>(null);
  const show = (target: Element, content: ReactNode) => {
    const box = frame.current;
    if (!box) return;
    const f = box.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    setTip({ x: t.left - f.left + t.width / 2, top: t.top - f.top, bottom: t.bottom - f.top, content });
  };
  const hide = () => setTip(null);
  return { frame, tip, show, hide };
}

/**
 * The tooltip: placed above its mark and kept inside the frame's width (below the mark when there is no room above). It repeats
 * what the mark's accessible name and the table view already say, so assistive technology skips it.
 */
export function ChartTip({ tip, frame }: { tip: TipAt; frame: RefObject<HTMLDivElement> }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = frame.current;
    if (!el || !box) return;
    const left = Math.max(0, Math.min(tip.x - el.offsetWidth / 2, box.clientWidth - el.offsetWidth));
    const above = tip.top - el.offsetHeight - 6;
    el.style.left = `${left}px`;
    // Up to the card header's height above the frame is still inside the card; further up, the tip goes below the mark.
    el.style.top = `${above >= -40 ? above : tip.bottom + 6}px`;
  }, [tip, frame]);
  return (
    <div ref={ref} className="dash-chart-tip" aria-hidden="true">
      {tip.content}
    </div>
  );
}

/** One tooltip line: the value first and strong, then what it is; a short stroke of the mark's fill keys it. */
export function TipLine({ fill, value, label }: { fill?: Fill; value: ReactNode; label: ReactNode }) {
  return (
    <span className="dash-tip-line">
      {fill && <i className={`dash-tip-key dash-fill-${fill}`} />}
      <strong>{value}</strong> <span className="dash-tip-label">{label}</span>
    </span>
  );
}

export interface Part {
  key: string;
  label: string;
  value: number;
  /** The value as it is written (a decimal without padding zeros, or a count). */
  text: string;
  fill: Fill;
}

/** A part's share of the whole, rounded to a whole percent for the tooltip ("<1%" rather than a misleading 0%). */
export function share(value: number, total: number): string {
  if (total <= 0) return '0%';
  const pct = (value / total) * 100;
  return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}

/**
 * A thin segmented bar: one whole split into its parts, widths proportional to the values, a 2px gap between parts and fully
 * rounded ends; a part at zero draws nothing. The text beside the bar carries the figures, so the bar prints none. Pointing at a
 * part shows its value and share; focusing the bar (one tab stop) shows every part. Its accessible name says it all in words.
 */
export function SegmentedBar({ parts, label, total: whole }: { parts: Part[]; label: string; total?: number }) {
  const { frame, tip, show, hide } = useChartTip();
  const total = whole ?? parts.reduce((n, p) => n + Math.max(0, p.value), 0);
  const drawn = parts.filter((p) => p.value > 0);
  const all = (
    <>
      {parts.map((p) => (
        <TipLine key={p.key} fill={p.fill} value={p.text} label={`${p.label} · ${share(Math.max(0, p.value), total)}`} />
      ))}
    </>
  );
  return (
    <div className="dash-bar-frame" ref={frame}>
      <div className="dash-bar" role="img" aria-label={label} tabIndex={0} onFocus={(e) => show(e.currentTarget, all)} onBlur={hide} onMouseLeave={hide}>
        {drawn.map((p) => (
          <span
            key={p.key}
            className="dash-bar-part"
            style={{ flexGrow: p.value }}
            data-part={p.key}
            onMouseEnter={(e) => show(e.currentTarget, <TipLine fill={p.fill} value={p.text} label={`${p.label} · ${share(p.value, total)}`} />)}
          >
            <i className={`dash-fill-${p.fill}`} />
          </span>
        ))}
        {drawn.length === 0 && (
          <span className="dash-bar-part" style={{ flexGrow: 1 }}>
            <i className="dash-fill-track" />
          </span>
        )}
      </div>
      {tip && <ChartTip tip={tip} frame={frame} />}
    </div>
  );
}

/** The legend: a swatch shaped like the mark beside each name (and its figure, when given), in text colours. */
export function Legend({ items, label }: { items: { key: string; label: string; fill: Fill; value?: ReactNode }[]; label: string }) {
  return (
    <ul className="dash-legend" aria-label={label}>
      {items.map((i) => (
        <li key={i.key}>
          <i className={`dash-swatch dash-fill-${i.fill}`} aria-hidden="true" />
          <span>{i.label}</span>
          {i.value !== undefined && <strong>{i.value}</strong>}
        </li>
      ))}
    </ul>
  );
}
