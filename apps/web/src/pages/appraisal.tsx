// Appraisal (FR-040 to FR-044; F1 "Appraisal"; H3 TN18; decisions I-23 and I-24; DF02; DF03; C4).
//
// Cycles (FR-040): the company's cycle start month (1, 4, 7 or 10; no default, so cycles are refused until it is set),
// financial-year cycles of twelve months from the 1st of that month with three inclusive windows (goal setting,
// self-entry, manager rating; each fully dated or unscheduled) and one or two reviewer levels, closed once every
// appraisal in them is finished. Appraisals (FR-041): HR or the direct manager enrols an employee in an open cycle as a
// DRAFT with goals (whole-number weights 1 to 100 that must total exactly 100 when the employee submits), never on their
// own appraisal; authorised window exceptions per appraisal and stage; HR cancels with a confidential reason. Review
// (FR-042, FR-043): the employee's self-entry and submission in the Employee OWN context (My ESS TN18); the manager's
// rating per goal (integer 1 to 5) with remarks, submitted as the F1 weighted manager result the server computes; an
// independent reviewer confirms or returns it (a return opens the next revision). Reports (FR-044) count by state and,
// with the rating grant, by exact final rating, within the selected assignment's row scope. The KRA upload only enrols
// new DRAFT appraisals; it never submits, rates or approves anything. A goal file the malware scan has not released is
// held unread (FR-106); the user's own uploads are listed, so a held one is opened again and checked again from the
// file the server stored (records.tsx).
// Competencies and sections (FR-041, FR-042; decided under owner delegation, 6 Nov 2026, I-86): HR keeps a dated goals /
// competencies split, a competency master with one behavioural indicator per level 1 to 5, and dated competency sets per grade
// (optionally one designation); enrolment copies the employee's set into the appraisal, fixed. The employee self-scores and the
// manager rates each competency like a goal; the weighted result is (goals % x goal result + competencies % x competency result)
// / 100, rounded once half up, or the goal result alone without competencies. A cycle includes any of four unscored sections
// (improvement areas, training needs, activity performance, stretched KPIs); an included one must be filled by its party before
// they submit, an excluded one never blocks. Training needs are listed for training planning as a suggestion only.
// Ratings, comments, results, remarks and reasons are confidential: the server leaves them out of its answers unless the
// selected assignment may see them, and these screens render only what it returned. One's own appraisal never shows a
// rating, and no employee-visible result is published (no setting authorises one). The server authorises every call
// and decides every rule; these screens hide what the selected assignment cannot use and say its refusals in plain words.
//
// The code is in ./appraisal/: one module per screen (cycles, register, detail, queues, reports, goal-upload, my-appraisal,
// competency-config, bell-curve), the views they share (lookups, goals, competency-views, score-form), shared.ts (permission
// keys, constants, API shapes, query keys, helpers), refusals.tsx, and routes.ts, which this entry module re-exports.
export { APPRAISAL_ESS_PANELS, APPRAISAL_SCREENS, APPRAISAL_TASK_QUEUES } from './appraisal/routes';
