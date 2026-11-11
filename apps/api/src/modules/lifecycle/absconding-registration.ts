// Absconding warnings and the absconding audit report (BRD coverage CL-052, under FR-018 and FR-056 to FR-058; BR-045; DF02; migration
// 0283; decided under owner delegation, 6 Nov 2026). Data only: the report is lifecycle/absconding-audit.ts; the warning category is
// written with the note (lifecycle/notes.ts). The report is derived from restricted notes, so its export right is confidential: ceiling
// only for the HR Administrator, approved per assignment, never a default duty.
import type { ModuleRegistration } from '../registry-types.js';

export const abscondingAuditRegistration: ModuleRegistration = {
  key: 'absconding-audit',
  active: true,
  roleGrants: {
    HR_ADMINISTRATOR: { ceiling: ['employee_note.export.restricted'] },
  },
};
