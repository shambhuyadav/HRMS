// Timesheets (FR-045 to FR-048; F1 "Timesheets"; BR-048; BR-049; DF02; DF03; C4; H3 TN13; decision I-30).
//
// Masters (FR-045): company-wide projects, jobs (each in exactly one project, fixed at creation) and a reusable activity
// catalogue whose activities a job permits through approved job-activity links. Each master has an owner, an inclusive
// validity period and an active flag; codes never change and nothing is deleted. Each activity carries a required
// productive flag with no default.
// Allocations (FR-046): an employee's share of daily capacity on a job for an interval. Overlapping jobs may total
// 100%; above that only the employee's current direct manager records an exception with a reason (the API decides).
// Timesheets (FR-047): one per employee and Monday-Sunday week, entered in quarter hours from the employee's own active
// allocations, at most 24 hours a day (the API enforces it and its duplicate rule; its refusals are shown). Submission
// is due by the following Monday; a later one is accepted and flagged late. The direct manager approves, returns or
// rejects (a reason for the last two); the employee continues in a new revision. An approved timesheet is corrected
// only after an independent reopen decision: the correction is a new revision and every revision stays on record.
// Missed weeks raise a reminder, never a penalty (BR-049). Reports (FR-048) count approved time in force only;
// utilisation is shown exactly as the API returns it, including N/A and not configured.
// Imports (FR-046 bulk upload; FR-047 imported entries; DF09; FR-106): allocation and timesheet-line CSV batches are
// uploaded, previewed row by row and then committed or cancelled, all or nothing (the job view of records.tsx). A file
// the malware scan has not released is held unread; checking it again resumes the batch from its stored file, and the
// user's own batches are listed, so a held batch can be opened again after leaving the page.
// The server authorises every call and decides every rule; these screens hide what the selected assignment cannot use,
// show only what the server returned and say its refusals in plain words. Every timesheet field group is operational.
export { TIMESHEET_ESS_PANELS, TIMESHEET_SCREENS, TIMESHEET_TASK_QUEUES } from './timesheet/routes';
