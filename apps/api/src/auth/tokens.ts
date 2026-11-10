// Access-token verification. Production will verify OIDC tokens against the provider's key set (ADR-06,
// T-03 pending); development and tests use an HS256 secret with synthetic users only.
// DF10: tokens are bounded by the 12-hour absolute session; every token names its server-side session (sid),
// which enforces the 30-minute idle timeout and revocation (see sessions.ts).
import { jwtVerify, SignJWT } from 'jose';

export const ABSOLUTE_SESSION_SECONDS = 12 * 60 * 60;

export interface VerifiedToken {
  userId: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

export interface DevTokenConfig {
  issuer: string;
  audience: string;
  secret: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function devTokenVerifier(config: DevTokenConfig): TokenVerifier {
  if (config.secret.length < 32) throw new Error('Development token secret must be at least 32 characters');
  const key = new TextEncoder().encode(config.secret);
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        issuer: config.issuer,
        audience: config.audience,
        requiredClaims: ['sub', 'sid', 'iat', 'exp'],
      });
      const { sub, sid, iat, exp } = payload as { sub?: unknown; sid?: unknown; iat?: unknown; exp?: unknown };
      if (typeof sub !== 'string' || !UUID.test(sub) || typeof sid !== 'string' || !UUID.test(sid) || typeof iat !== 'number' || typeof exp !== 'number') {
        throw new Error('Malformed token claims');
      }
      if (exp - iat > ABSOLUTE_SESSION_SECONDS) throw new Error('Token lifetime exceeds the absolute session limit');
      return { userId: sub, sessionId: sid, issuedAt: iat, expiresAt: exp };
    },
  };
}

/**
 * The HRMS session token: HS256, bound to a server-side session (sid), at most the absolute session lifetime. Development and tests issue
 * it from the development sign-in; production issues it after an OIDC sign-in (auth/oidc.ts), with its own secret and issuer, and
 * verifies it with `sessionTokenVerifier` (the same checks).
 */
export const sessionTokenVerifier = devTokenVerifier;

/** Issues the session token for an existing session (production: after the provider's sign-in was verified). */
export async function issueSessionToken(config: DevTokenConfig, userId: string, sessionId: string, lifetimeSeconds: number): Promise<string> {
  if (lifetimeSeconds > ABSOLUTE_SESSION_SECONDS) throw new Error('A session token never outlives the absolute session limit');
  return issueDevToken(config, userId, sessionId, lifetimeSeconds);
}

/** Issues development/test tokens for an existing session. Production issues them only through issueSessionToken. */
export async function issueDevToken(config: DevTokenConfig, userId: string, sessionId: string, lifetimeSeconds = 3600): Promise<string> {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt()
    .setExpirationTime(`${lifetimeSeconds}s`)
    .sign(new TextEncoder().encode(config.secret));
}
