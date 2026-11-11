// State, city and bank masters (BRD coverage CL-005, CL-006, CL-010, under FR-004 configurable entities; DF04; migration 0280;
// decided under owner delegation, 6 Nov 2026). Data only: the city routes are org/cities.ts; the lists are kept on the Reference values
// screen (reference/maintenance.ts). No permission is added: everything here is read and changed under the organisation master
// permissions (org_master.read / create / update, operational), which the HR Administrator already holds.
import type { ModuleRegistration } from '../registry-types.js';

/**
 * The states and union territories of India by their ISO 3166-2:IN codes (2023 revision), the same two letters the professional
 * tax state of a work location uses (0220). One list per country (STATE_<ISO alpha-2>); India is the first.
 */
export const STATES_OF_INDIA: Readonly<Record<string, string>> = {
  AN: 'Andaman and Nicobar Islands',
  AP: 'Andhra Pradesh',
  AR: 'Arunachal Pradesh',
  AS: 'Assam',
  BR: 'Bihar',
  CH: 'Chandigarh',
  CG: 'Chhattisgarh',
  DH: 'Dadra and Nagar Haveli and Daman and Diu',
  DL: 'Delhi',
  GA: 'Goa',
  GJ: 'Gujarat',
  HR: 'Haryana',
  HP: 'Himachal Pradesh',
  JK: 'Jammu and Kashmir',
  JH: 'Jharkhand',
  KA: 'Karnataka',
  KL: 'Kerala',
  LA: 'Ladakh',
  LD: 'Lakshadweep',
  MP: 'Madhya Pradesh',
  MH: 'Maharashtra',
  MN: 'Manipur',
  ML: 'Meghalaya',
  MZ: 'Mizoram',
  NL: 'Nagaland',
  OD: 'Odisha',
  PY: 'Puducherry',
  PB: 'Punjab',
  RJ: 'Rajasthan',
  SK: 'Sikkim',
  TN: 'Tamil Nadu',
  TS: 'Telangana',
  TR: 'Tripura',
  UP: 'Uttar Pradesh',
  UK: 'Uttarakhand',
  WB: 'West Bengal',
};

/** The countries whose state lists exist (STATE_<code>), in the order a screen offers them. */
export const STATE_COUNTRIES: readonly { code: string; name: string; category: string }[] = [{ code: 'IN', name: 'India', category: 'STATE_IN' }];

export const orgMastersRegistration: ModuleRegistration = {
  key: 'org-masters',
  active: true,
  referenceValues: {
    STATE_IN: STATES_OF_INDIA,
    // Each company adds the banks it pays through; nothing is assumed.
    BANK: {},
  },
  // The city screen chooses a city's state under the organisation master read permission.
  referenceReaders: { STATE_IN: 'org_master.read.operational' },
};
