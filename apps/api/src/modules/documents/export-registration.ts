// Export employee documents to a ZIP (BRD coverage CL-027, under FR-010, FR-057, FR-106; BR-045; DF02; migration 0281; decided under
// owner delegation, 6 Nov 2026). Data only: the routes are documents/export.ts. The export right is confidential like the documents it
// carries, so it is a ceiling-only grant of the HR Administrator, approved per assignment, never a default duty; the export also needs
// the single download's own grant (document.read.document), which the HR Administrator's ceiling already holds.
import type { ModuleRegistration } from '../registry-types.js';

export const documentExportRegistration: ModuleRegistration = {
  key: 'document-export',
  active: true,
  roleGrants: {
    HR_ADMINISTRATOR: { ceiling: ['document.export.document'] },
  },
};
