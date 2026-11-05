// Accounts that are not people (migration 0146; B1 line 2800). They cannot sign in, hold an assignment or approve anything. Code
// that writes as the system passes SYSTEM_ACTOR_ID explicitly: no trigger or default fills an actor in, so a write that
// forgets one is refused rather than attributed to someone.

/** Who the scheduler and the notification dispatcher act as. */
export const SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000001';

/** Rows whose creator was not recorded before 0146. Nothing writes this; it only ever appears on those stored rows. */
export const CREATOR_NOT_RECORDED_ID = '00000000-0000-4000-8000-000000000002';
