// Batch imports (FR-009, FR-023, DF09, I-13, I-20) and employee documents (FR-010).
//
// The code is in ./records/: the import screen and a batch's preview (imports), the user's own batches and a batch held for the
// malware scan (batches), the published templates and the job view (templates), an employee's documents (documents) and the layout
// pieces they share (layout). This entry module re-exports what other modules import from it: the import screens of salary, payroll,
// lifecycle documents, attendance, timesheets, appraisal and documents reuse the template download, the preview and the batches.
export { type HeldBatchWatch, HELD_BATCH_NOTE, HeldBatchCheck, HeldBatchWatchNote, type ImportBatch, ImportBatches, importBatchesKey, useBatchFollowUp, useHeldBatchWatch } from './records/batches';
export { EmployeeDocumentsPage } from './records/documents';
export { ImportJobView, ImportsPage, TemplateDownload } from './records/imports';
export type { ImportJob, ImportRow, ImportTemplate } from './records/templates';
