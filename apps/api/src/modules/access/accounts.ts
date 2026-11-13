// Account administration (FR-001 "initiate the visible password-recovery journey"; the source system's User Master; §5 System
// Administrator; 0311; owner request of 13 Nov 2026). From the User accounts screen the System Administrator creates an account
// with its sign-in, changes its name and sign-in email, gives it a new temporary password and deletes one that was never used.
//   - Who: an unrestricted company-scope assignment holding access.manage_accounts (re-checked inside the transaction), never on
//     their own account, and never on an account that also serves another company (one tenant's administrator does not change
//     another tenant's user; the company is not named).
//   - What an account may do still comes only from assignments approved by an independent administrator: creating one grants
//     nothing.
//   - The sign-in (password, second factor) lives at the provider (auth/identity-admin.ts). The HRMS writes its own rows first,
//     inside the transaction, then asks the provider; a refusal there rolls the HRMS change back. A temporary password is returned
//     once and never logged, audited or stored.
//   - Delete removes only an account nobody ever used (no sign-in, no link, no grant anywhere, nothing that refers to it);
//     anything else is kept for the record and deactivated instead (BR-004: what is referenced is deactivated, never deleted).
import { writeAudit } from '../../audit/audit.js';
import { type IdentityAdmin, IdentityConflict, type IdentityPerson, IdentityUnavailable, temporaryPassword } from '../../auth/identity-admin.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import type { AccessGrant } from './authorize.js';

export interface NewAccountInput {
  email: string;
  firstName: string;
  lastName: string;
}

export interface AccountChangeInput {
  expectedVersion: number;
  email?: string | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
}

export interface AccountView {
  userId: string;
  accountKey: string;
  active: boolean;
  version: number;
  firstName: string | null;
  lastName: string | null;
  /** The provider holds a sign-in for the account. */
  signInAccount: boolean;
  /** The account has signed in at least once. */
  signedIn: boolean;
  /** Never used: it may be deleted (anything else is only deactivated). */
  deletable: boolean;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const unavailable = () => new HttpError(503, 'SIGN_IN_PROVIDER_UNAVAILABLE', 'The sign-in provider cannot be reached; try again in a moment');
const selfRefusal = () => new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot change your own account here; another administrator must do it');
const exists = () => new HttpError(409, 'ACCOUNT_EXISTS', 'An account with this email already exists');

/** The provider's call, with its failures as HTTP answers (a conflict on the email reads as the HRMS's own). */
async function atProvider<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof IdentityConflict) throw exists();
    if (err instanceof IdentityUnavailable) throw unavailable();
    throw err;
  }
}

function assertCompanyAdmin(admin: AccessGrant): void {
  const { departments, locations, employees } = admin.filters;
  if (admin.scopeKind !== 'COMPANY' || departments.length + locations.length + employees.length > 0) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
}

function email(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.length < 3 || v.length > 200 || !EMAIL.test(v)) throw new HttpError(422, 'INVALID_EMAIL', 'Enter a valid email address');
  return v;
}

function name(value: string, what: string): string {
  const v = value.trim();
  if (!v || v.length > 100) throw new HttpError(422, 'NAME_REQUIRED', `Enter the ${what} (at most 100 characters)`);
  return v;
}

/** The account belongs to this company: created here, linked to one of its employees, or granted one of its roles. */
async function belongsHere(db: Queryable, companyId: string, userId: string): Promise<boolean> {
  const row = (
    await db.query<{ ok: boolean }>(
      `select exists (select 1 from company_user_account where company_id = $1 and user_id = $2)
           or exists (select 1 from user_employee_link where company_id = $1 and user_id = $2)
           or exists (select 1 from role_assignment where company_id = $1 and user_id = $2) as ok`,
      [companyId, userId],
    )
  ).rows[0];
  return row?.ok === true;
}

/** A live tie to another company (a current link, a pending or live grant, or that company created it). */
async function servesAnotherCompany(db: Queryable, companyId: string, userId: string): Promise<boolean> {
  const row = (
    await db.query<{ ok: boolean }>(
      `select exists (select 1 from user_employee_link l where l.company_id <> $1 and l.user_id = $2
                         and (l.effective_to is null or l.effective_to > hrms_business_date(l.company_id, now())))
           or exists (select 1 from role_assignment ra where ra.company_id <> $1 and ra.user_id = $2 and ra.state in ('PENDING', 'ACTIVE')
                         and (ra.effective_to is null or ra.effective_to > now()))
           or exists (select 1 from company_user_account c where c.company_id <> $1 and c.user_id = $2) as ok`,
      [companyId, userId],
    )
  ).rows[0];
  return row?.ok === true;
}

/** Ever used: signed in, linked or granted anywhere. */
async function everUsed(db: Queryable, userId: string): Promise<boolean> {
  const row = (
    await db.query<{ ok: boolean }>(
      `select exists (select 1 from user_external_identity where user_id = $1)
           or exists (select 1 from user_session where user_id = $1)
           or exists (select 1 from user_employee_link where user_id = $1)
           or exists (select 1 from role_assignment where user_id = $1) as ok`,
      [userId],
    )
  ).rows[0];
  return row?.ok === true;
}

/** The account's sign-in at the provider: by the subject recorded at its first sign-in, else by its email. */
export async function signInOf(db: Queryable, identity: IdentityAdmin, userId: string, accountKey: string): Promise<IdentityPerson | null> {
  const subject = (await db.query<{ subject: string }>(`select subject from user_external_identity where user_id = $1 order by created_at limit 1`, [userId])).rows[0]?.subject;
  return atProvider(async () => (subject ? ((await identity.get(subject)) ?? identity.findByEmail(accountKey)) : identity.findByEmail(accountKey)));
}

interface Locked {
  id: string;
  account_key: string;
  active: boolean;
  version: number;
}

/** The target account, locked, after the common checks: not one's own, the duty still held, this company's, not shared. */
async function lockTarget(tx: Queryable, admin: AccessGrant, userId: string): Promise<Locked> {
  assertCompanyAdmin(admin);
  if (userId === admin.userId) throw selfRefusal();
  const target = (await tx.query<Locked>(`select id, account_key, active, version from user_account where id = $1 for update`, [userId])).rows[0];
  await reassertAccess(tx, admin, 'access', 'manage_accounts', ['operational']);
  if (!target || !(await belongsHere(tx, admin.companyId, userId))) throw notFound();
  if (await servesAnotherCompany(tx, admin.companyId, userId)) throw new HttpError(409, 'ACCOUNT_SPANS_COMPANIES', 'This account also serves another company, so one company cannot change it');
  return target;
}

/**
 * Creates the account and its sign-in. Without a provider (the development server, which signs in by account key) the account is
 * created alone and no password is returned; in production a missing provider refuses before anything is written.
 */
export async function createAccount(
  tx: Queryable,
  admin: AccessGrant,
  identity: IdentityAdmin | null,
  input: NewAccountInput,
): Promise<{ userId: string; accountKey: string; version: number; temporaryPassword: string | null }> {
  assertCompanyAdmin(admin);
  if (!identity && process.env.NODE_ENV === 'production') throw unavailable();
  const key = email(input.email);
  const firstName = name(input.firstName, 'first name');
  const lastName = name(input.lastName, 'last name');
  await reassertAccess(tx, admin, 'access', 'manage_accounts', ['operational']);
  const created = (
    await tx.query<{ id: string; version: number }>(
      `insert into user_account (account_key, active, created_by, updated_by) values ($1, true, $2, $2)
       on conflict (account_key) do nothing returning id, version`,
      [key, admin.userId],
    )
  ).rows[0];
  if (!created) throw exists();
  await tx.query(`insert into company_user_account (company_id, user_id, created_by) values ($1, $2, $3)`, [admin.companyId, created.id, admin.userId]);
  await writeAudit(tx, {
    companyId: admin.companyId,
    resource: 'user_account',
    recordKey: created.id,
    actorUserId: admin.userId,
    actingAssignmentId: admin.assignmentId,
    action: 'CREATE',
    newVersion: created.version,
    after: { operational: { accountKey: key, firstName, lastName, active: true } },
  });
  if (!identity) return { userId: created.id, accountKey: key, version: created.version, temporaryPassword: null };
  const password = temporaryPassword();
  await atProvider(async () => {
    try {
      await identity.create({ email: key, firstName, lastName, temporaryPassword: password });
    } catch (err) {
      if (!(err instanceof IdentityConflict)) throw err;
      // A sign-in with this email but no HRMS account (left by an earlier attempt whose HRMS side did not commit): nobody could
      // use it, so it becomes this account's, with the new names and password.
      const left = await identity.findByEmail(key);
      if (!left) throw err;
      await identity.update(left.id, { firstName, lastName, enabled: true });
      await identity.setTemporaryPassword(left.id, password);
    }
  });
  return { userId: created.id, accountKey: key, version: created.version, temporaryPassword: password };
}

export async function getAccount(db: Queryable, admin: AccessGrant, identity: IdentityAdmin | null, userId: string): Promise<AccountView> {
  assertCompanyAdmin(admin);
  const row = (await db.query<Locked>(`select id, account_key, active, version from user_account where id = $1`, [userId])).rows[0];
  if (!row || !(await belongsHere(db, admin.companyId, userId))) throw notFound();
  const person = identity ? await signInOf(db, identity, userId, row.account_key) : null;
  const used = await everUsed(db, userId);
  return {
    userId,
    accountKey: row.account_key,
    active: row.active,
    version: row.version,
    firstName: person?.firstName ?? null,
    lastName: person?.lastName ?? null,
    signInAccount: person !== null,
    signedIn: (await db.query(`select 1 from user_external_identity where user_id = $1 union all select 1 from user_session where user_id = $1 limit 1`, [userId])).rowCount !== 0,
    deletable: !used && userId !== admin.userId && !(await servesAnotherCompany(db, admin.companyId, userId)),
  };
}

/** Changes the sign-in email (the account key) and the name. */
export async function updateAccount(
  tx: Queryable,
  admin: AccessGrant,
  identity: IdentityAdmin | null,
  userId: string,
  input: AccountChangeInput,
): Promise<{ userId: string; accountKey: string; version: number }> {
  if (!identity && process.env.NODE_ENV === 'production') throw unavailable();
  const target = await lockTarget(tx, admin, userId);
  if (target.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  const key = input.email === undefined ? target.account_key : email(input.email);
  const firstName = input.firstName === undefined ? undefined : name(input.firstName, 'first name');
  const lastName = input.lastName === undefined ? undefined : name(input.lastName, 'last name');
  if (key !== target.account_key && (await tx.query(`select 1 from user_account where account_key = $1`, [key])).rowCount) throw exists();
  // The version moves on every change, the name's too (it lives at the provider), so two administrators never overwrite each other.
  const updated = (await tx.query<{ version: number }>(`update user_account set account_key = $2, updated_by = $3 where id = $1 returning version`, [userId, key, admin.userId])).rows[0]!;
  await writeAudit(tx, {
    companyId: admin.companyId,
    resource: 'user_account',
    recordKey: userId,
    actorUserId: admin.userId,
    actingAssignmentId: admin.assignmentId,
    action: 'UPDATE',
    priorVersion: target.version,
    newVersion: updated.version,
    before: { operational: { accountKey: target.account_key } },
    after: { operational: { accountKey: key, ...(firstName === undefined ? {} : { firstName }), ...(lastName === undefined ? {} : { lastName }) } },
  });
  if (identity) {
    const person = await signInOf(tx, identity, userId, target.account_key);
    if (!person) throw new HttpError(409, 'NO_SIGN_IN', 'This account has no sign-in yet: reset its password to create one');
    await atProvider(() =>
      identity.update(person.id, {
        ...(key !== target.account_key ? { email: key } : {}),
        ...(firstName === undefined ? {} : { firstName }),
        ...(lastName === undefined ? {} : { lastName }),
      }),
    );
  }
  return { userId, accountKey: key, version: updated.version };
}

/**
 * A new one-time temporary password: the person is signed out everywhere (here and at the provider) and must choose their own
 * password at the next sign-in. Their authenticator app stays. An account without a sign-in yet (one made by an older set-up)
 * gets one.
 */
export async function resetPassword(
  tx: Queryable,
  admin: AccessGrant,
  identity: IdentityAdmin | null,
  userId: string,
  input: { reason: string },
): Promise<{ userId: string; temporaryPassword: string | null; sessionsRevoked: number }> {
  if (!identity && process.env.NODE_ENV === 'production') throw unavailable();
  const target = await lockTarget(tx, admin, userId);
  if (!target.active) throw new HttpError(409, 'INVALID_STATE', 'This account is inactive: reactivate it first');
  const reason = input.reason.trim();
  if (!reason) throw new HttpError(422, 'REASON_REQUIRED', 'Say why the password is reset');
  const sessionsRevoked = (await tx.query(`update user_session set revoked_at = now() where user_id = $1 and revoked_at is null`, [userId])).rowCount ?? 0;
  await writeAudit(tx, {
    companyId: admin.companyId,
    resource: 'user_account',
    recordKey: userId,
    actorUserId: admin.userId,
    actingAssignmentId: admin.assignmentId,
    action: 'RESET_PASSWORD',
    priorVersion: target.version,
    after: { operational: { sessionsRevoked } },
    reason,
  });
  if (!identity) return { userId, temporaryPassword: null, sessionsRevoked };
  const password = temporaryPassword();
  const person = await signInOf(tx, identity, userId, target.account_key);
  await atProvider(async () => {
    if (!person) {
      await identity.create({ email: target.account_key, firstName: '', lastName: '', temporaryPassword: password });
      return;
    }
    await identity.setTemporaryPassword(person.id, password);
    if (!person.enabled) await identity.update(person.id, { enabled: true });
    await identity.signOut(person.id);
  });
  return { userId, temporaryPassword: password, sessionsRevoked };
}

/** Deletes an account nobody ever used, with its sign-in. Anything used is kept for the record: deactivate it instead. */
export async function deleteAccount(
  tx: Queryable,
  admin: AccessGrant,
  identity: IdentityAdmin | null,
  userId: string,
  input: { expectedVersion: number; reason: string },
): Promise<{ userId: string; deleted: true }> {
  if (!identity && process.env.NODE_ENV === 'production') throw unavailable();
  const target = await lockTarget(tx, admin, userId);
  if (target.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  const reason = input.reason.trim();
  if (!reason) throw new HttpError(422, 'REASON_REQUIRED', 'Say why the account is deleted');
  const inUse = () => new HttpError(409, 'ACCOUNT_IN_USE', 'This account has been used, so it is kept for the record: deactivate it instead');
  if (await everUsed(tx, userId)) throw inUse();
  const person = identity ? await signInOf(tx, identity, userId, target.account_key) : null;
  // Anything else that refers to the account (it created or changed a record) keeps it: the foreign key says so.
  await tx.query('savepoint delete_account');
  try {
    await tx.query(`delete from company_user_account where user_id = $1`, [userId]);
    await tx.query(`delete from user_account where id = $1`, [userId]);
  } catch (err) {
    if ((err as { code?: string }).code !== '23503') throw err;
    await tx.query('rollback to savepoint delete_account');
    throw inUse();
  }
  await tx.query('release savepoint delete_account');
  await writeAudit(tx, {
    companyId: admin.companyId,
    resource: 'user_account',
    recordKey: userId,
    actorUserId: admin.userId,
    actingAssignmentId: admin.assignmentId,
    action: 'DELETE',
    priorVersion: target.version,
    before: { operational: { accountKey: target.account_key, active: target.active } },
    reason,
  });
  if (identity && person) await atProvider(() => identity.remove(person.id));
  return { userId, deleted: true };
}

/** Deactivating or reactivating an account turns its sign-in off or on as well (user-admin.ts setAccountActive). */
export async function setSignInEnabled(db: Queryable, identity: IdentityAdmin | null, userId: string, accountKey: string, enabled: boolean): Promise<void> {
  if (!identity) return;
  const person = await signInOf(db, identity, userId, accountKey);
  if (!person) return;
  await atProvider(async () => {
    await identity.update(person.id, { enabled });
    if (!enabled) await identity.signOut(person.id);
  });
}
