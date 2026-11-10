// Line icons for the menu and the shell (24×24, drawn with the current text colour). Drawn here rather than taken from an icon package,
// so the app loads nothing from elsewhere and needs no new dependency. Decorative: every icon sits next to its text label.
import type { ReactNode } from 'react';

const PATHS = {
  home: <path d="M3 10.5 12 3l9 7.5M5 9v11a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  idCard: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="11" r="2.5" />
      <path d="M5.5 17a3.5 3.5 0 0 1 7 0M15 10h3M15 14h3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" />
    </>
  ),
  upload: <path d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />,
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  mapPin: (
    <>
      <path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12Z" />
      <circle cx="12" cy="9" r="2.5" />
    </>
  ),
  badgeCheck: (
    <>
      <path d="M12 2.5 14.6 4.4l3.2-.2.9 3.1 2.6 1.9-1.1 3 1.1 3-2.6 1.9-.9 3.1-3.2-.2L12 21.5 9.4 19.6l-3.2.2-.9-3.1-2.6-1.9 1.1-3-1.1-3 2.6-1.9.9-3.1 3.2.2Z" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  trendingUp: <path d="M3 17 9.5 10.5l4 4L21 7m0 0h-5m5 0v5" />,
  receipt: <path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21V3Zm3 5h6m-6 4h6m-6 4h3" />,
  checkSquare: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  shield: <path d="M12 3 4.5 6v5.5c0 4.7 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.8 7.5-9.5V6L12 3Z" />,
  creditCard: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M2.5 10h19M6.5 15h4" />
    </>
  ),
  barChart: <path d="M4 20V10m6 10V4m6 16v-7m4 7H3" />,
  pieChart: (
    <>
      <path d="M12 3a9 9 0 1 0 9 9h-9V3Z" />
      <path d="M15 2.5A7.5 7.5 0 0 1 21.5 9H15V2.5Z" />
    </>
  ),
  bell: <path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9Zm4 11a2 2 0 0 0 4 0" />,
  key: (
    <>
      <circle cx="8" cy="15" r="4.5" />
      <path d="m11.2 11.8 8.3-8.3M16 7l2.5 2.5M18.5 4.5 21 7" />
    </>
  ),
  history: <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6M3 4v4.5h4.5M12 7.5V12l3 2" />,
  archive: (
    <>
      <rect x="3" y="4" width="18" height="5" rx="1" />
      <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="5" r="2" />
      <path d="M8 19h7.5a3.5 3.5 0 0 0 0-7h-7a3.5 3.5 0 0 1 0-7H16" />
    </>
  ),
  phone: (
    <>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  userPlus: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6m-3-3h6" />
    </>
  ),
  refresh: <path d="M20 11a8 8 0 0 0-14.3-4.5M4 4v4h4M4 13a8 8 0 0 0 14.3 4.5M20 20v-4h-4" />,
  folder: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-12Z" />,
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  package: <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5M12 12v9M8 5.3l8 4.5" />,
  graduation: <path d="M2.5 9 12 4.5 21.5 9 12 13.5 2.5 9Zm3.5 2v5c1.5 1.5 3.7 2.5 6 2.5s4.5-1 6-2.5v-5M21.5 9v5" />,
  wallet: (
    <>
      <path d="M4 7.5V18a2 2 0 0 0 2 2h14V9H6a2 2 0 0 1-2-1.5Zm0 0A2 2 0 0 1 6 5h11v4" />
      <circle cx="16.5" cy="14.5" r="1.2" />
    </>
  ),
  banknote: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 10v4m12-4v4" />
    </>
  ),
  fileText: <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8l-5-5Zm0 0v5h5M9 13h6m-6 4h6" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9.5 9.5h5v5h-5zM9 2.5V6m6-3.5V6M9 18v3.5m6-3.5v3.5M2.5 9H6m-3.5 6H6m12-6h3.5M18 15h3.5" />
    </>
  ),
  building: <path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M2.5 21h19M8 8h3m-3 4h3m-3 4h3" />,
  fingerprint: <path d="M7 6.5A7 7 0 0 1 19 11v1.5M5 10a7 7 0 0 1 .5-2M5 13.5c0 2.5.8 4.7 2 6.5M12 11v2.5c0 3 .9 5.5 2 7M8.5 11a3.5 3.5 0 0 1 7 0v2c0 1.8.3 3.4.8 4.8M19 15.5c0 1.3-.2 2.6-.5 3.7" />,
  logOut: <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 16l-4-4 4-4M6 12h10" />,
  landmark: <path d="M3 9.5 12 4l9 5.5M4.5 10v8m5-8v8m5-8v8m5-8v8M3 20.5h18" />,
  percent: (
    <>
      <path d="M19 5 5 19" />
      <circle cx="7" cy="7" r="2.5" />
      <circle cx="17" cy="17" r="2.5" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="5.5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="18.5" r="2.5" />
      <path d="m8.2 10.8 7.6-4.1m-7.6 6.5 7.6 4.1" />
    </>
  ),
  swap: <path d="M7 4 3.5 7.5 7 11M3.5 7.5H17M17 13l3.5 3.5L17 20m3.5-3.5H7" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  sparkles: <path d="M12 3.5 13.6 9l5.4 1.5-5.4 1.6L12 17.5l-1.6-5.4L5 10.5 10.4 9 12 3.5ZM18.5 15l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** Icons of the core menu entries, by path. */
const NAV_ICONS: Readonly<Record<string, IconName>> = {
  '/': 'home',
  '/me': 'user',
  '/me/profile': 'idCard',
  '/me/attendance': 'clock',
  '/team': 'users',
  '/employees': 'users',
  '/imports': 'upload',
  '/leave': 'calendar',
  '/work-requests': 'mapPin',
  '/confirmations': 'badgeCheck',
  '/increments': 'trendingUp',
  '/expenses': 'receipt',
  '/tasks': 'checkSquare',
  '/sensitive-changes': 'shield',
  '/payments': 'creditCard',
  '/reports': 'barChart',
  '/inbox': 'bell',
  '/access': 'key',
  '/admin/audit': 'history',
  '/admin/retention': 'archive',
  '/admin/routing': 'route',
  '/admin/mobile-links': 'phone',
};

/** Icons of the module groups, by their menu label (App.tsx moduleGroupOf); anything new gets the generic grid. */
const GROUP_ICONS: Readonly<Record<string, IconName>> = {
  Hiring: 'userPlus',
  'Employee lifecycle': 'refresh',
  'My records': 'folder',
  Appraisal: 'target',
  Timesheets: 'clock',
  Assets: 'package',
  Training: 'graduation',
  Payroll: 'wallet',
  Salary: 'banknote',
  'Documents and policies': 'fileText',
  Administration: 'settings',
  'Background jobs': 'cpu',
  Organisation: 'building',
  Access: 'key',
  Notifications: 'bell',
  Leave: 'calendar',
  Attendance: 'fingerprint',
  Calendars: 'calendar',
  Biometric: 'fingerprint',
  'Employee history': 'history',
  Employees: 'users',
  Expense: 'receipt',
  Confirmations: 'badgeCheck',
  Delegations: 'share',
  Reporting: 'pieChart',
  Statutory: 'landmark',
  Tax: 'percent',
  Exit: 'logOut',
  Settlements: 'banknote',
  Lifecycle: 'refresh',
};

export const navIcon = (path: string): IconName => NAV_ICONS[path] ?? 'grid';
export const groupIcon = (label: string): IconName => GROUP_ICONS[label] ?? 'grid';
