// Employee processes and exit (FR-015, FR-016, FR-018 restricted remarks and notes; FR-051 as built; F1 "Exit and
// employee processes"; DF02; DF03; DF08; C4; ZT07; H3 own-record context).
//
// Process templates (FR-015): HR-controlled checklists of ordered tasks, each with exactly one owner (a role or a named
// user), an explicit required or optional flag, a due offset from the process's effective date and an evidence rule.
// A template is edited as its DRAFT revision, whose tasks are replaced as a whole against the draft's version;
// publishing freezes the draft and retires the revision published before. A template is renamed, deactivated or
// activated again against its version.
// Employee processes (FR-016): HR starts a published template for an employee in scope; its tasks are copied with their
// due dates, so a later revision never rewrites a running process. A task's owner completes it, with a remark and, where
// the task asks for it, an evidence file that nobody can open until the malware scan releases it; the owner skips an
// optional task with a reason. Completion records the actor and the business date. HR reassigns an open task (the
// prior owner stays in the history), reopens a done task or a closed process with a reason (its own duty), closes a
// process once every required task is complete and cancels an open one with a reason. Remarks and reasons are
// restricted (FR-018): they appear only when the server returned them. Restricted HR notes and warnings are
// append-only; a correction supersedes the earlier note.
// Exit (FR-051, F1): the employee resigns in their Employee OWN context with a proposed last working date; the direct
// manager (HR when the manager cannot) recommends the inclusive last working date; an independent HR Administrator
// approves it, possibly with another date, or does not approve it with a private reason and a message for the employee.
// Before that decision the employee withdraws the resignation; afterwards a withdrawal is a request that an independent
// HR Administrator decides. HR records the contractual notice period (a configured field: nothing monetary is derived
// from it here), starts the exit clearance checklist from an EXIT template and records the final release once every
// required clearance task is complete. States, the employee's NOTICE and separation status changes and every step are
// shown as the server returned them.
// The server authorises every call and decides every rule; these screens hide what the selected assignment cannot use,
// show only what the server returned and say its refusals in plain words.
export { LIFECYCLE_PROCESSES_ESS_PANELS, LIFECYCLE_PROCESSES_SCREENS, LIFECYCLE_PROCESSES_TASK_QUEUES } from './lifecycle-processes/routes';
