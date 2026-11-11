// HR sends one message to chosen employees by email (BRD coverage CL-041 "Send Mail", under FR-085; DF12; BR-044; migration 0282;
// decided under owner delegation, 6 Nov 2026). Data only: the routes are notification/hr-mail.ts. Sending is a confidential right of its
// own: ceiling only for the HR Administrator, approved per assignment, never a default duty.
import type { ModuleRegistration } from '../registry-types.js';

export const hrMailRegistration: ModuleRegistration = {
  key: 'hr-mail',
  active: true,
  roleGrants: {
    HR_ADMINISTRATOR: { ceiling: ['hr_mail.send.message'] },
  },
};
