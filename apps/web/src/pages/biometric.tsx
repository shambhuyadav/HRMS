// Biometric administration: API Profiles, Field Mapping, Employee Mapping and Sync Monitor (FR-086, FR-087, FR-088; BR-035;
// BR-036; BR-037; DF09; DF13).
//
// Profile settings are references to the private store, entered once and never shown again. A mapping revision is versioned
// and approved by someone other than its author, and a safe preview applies nothing. Employee links are ended or moved with a
// reason, never rewritten, and punches already made stay on record. The monitor shows runs and what they rejected or
// quarantined: an unknown identity is reprocessed once a link exists, and an ambiguous local time is settled by a person. A
// conflicting repeat has no action here: nothing overwrites the kept event, and a day that needs changing goes through
// attendance control. The page proposes no value. The server re-checks every duty and rule.
//
// The code is in ./biometric/: one module per screen (profiles, field-mapping, employee-mapping, sync-monitor), shared.tsx
// (permission keys, the API's shapes, helpers and the profile picker), refusals.tsx, and routes.ts. This entry module
// re-exports what other modules import from it.
export { BiometricEmployeeMappingPage } from './biometric/employee-mapping';
export { BiometricFieldMappingPage } from './biometric/field-mapping';
export { BiometricProfilesPage } from './biometric/profiles';
export { BIOMETRIC_SCREENS } from './biometric/routes';
export type { EmployeeLink, MappingField, MappingRevision, Profile, SyncException, SyncRun } from './biometric/shared';
export { BiometricSyncMonitorPage } from './biometric/sync-monitor';
