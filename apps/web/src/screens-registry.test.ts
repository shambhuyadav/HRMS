// The wave-2 page modules' screens, My ESS panels and decision queues as the hub, the inbox and (later) the router
// consume them. Synthetic data only.
import { describe, expect, it } from 'vitest';
import { ESS_PANELS_BY_TAB, MODULE_SCREENS, MODULE_TASK_QUEUES } from './screens-registry';

describe('screens registry', () => {
  it('every screen path is unique and names a component', () => {
    const paths = MODULE_SCREENS.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const s of MODULE_SCREENS) {
      expect(s.path.startsWith('/'), s.path).toBe(true);
      expect(typeof s.component, s.path).toBe('function');
    }
  });

  it('serves the H3 tabs of the active wave-2 modules, and only H3 tabs', () => {
    expect(Object.keys(ESS_PANELS_BY_TAB).sort()).toEqual(['TN06', 'TN08', 'TN09', 'TN13', 'TN15', 'TN16', 'TN17', 'TN18']);
  });

  it('every decision queue is gated by a permission key and has a distinct title', () => {
    const titles = MODULE_TASK_QUEUES.map((q) => q.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const q of MODULE_TASK_QUEUES) expect(q.permission, q.title).toMatch(/^[a-z_]+\.[a-z_]+\.[a-z_]+$/);
  });
});
