import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, type SessionState, setSession, setUnauthenticatedHandler } from './api';
import { providerLogout } from './oidc';

export interface Company {
  id: string;
  code: string;
  name: string;
}

export interface MeContext {
  /** The signed-in user (GET /v1/me/context), e.g. to tell one's own proposals apart. */
  userId: string;
  accountKey: string;
  companyName: string;
  roleCode: string;
  roleName: string;
  scopeKind: string;
  employeeId: string | null;
  displayName: string | null;
}

interface Stored {
  token: string;
  companies: Company[];
  companyId: string | null;
  assignmentId: string | null;
}

interface SessionValue {
  stored: Stored | null;
  me: MeContext | null;
  /** The selected role's context or permissions could not be loaded (the shell offers to try again). */
  contextFailed: boolean;
  retryContext(): void;
  permissions: Set<string>;
  can(permission: string): boolean;
  signIn(token: string, companies: Company[]): void;
  selectCompany(companyId: string): void;
  selectAssignment(assignmentId: string): void;
  switchRole(): void;
  signOut(): Promise<void>;
}

const KEY = 'hrms.session';
const SessionContext = createContext<SessionValue | null>(null);

function load(): Stored | null {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Stored | null;
  } catch {
    return null;
  }
}

function save(next: Stored | null) {
  try {
    if (next) sessionStorage.setItem(KEY, JSON.stringify(next));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable (private mode): the session lives for this page only */
  }
}

const apiSession = (s: Stored | null): SessionState | null => (s ? { token: s.token, companyId: s.companyId, assignmentId: s.assignmentId } : null);

/** The same user, company and role: anything cached or loaded for one context may be shown in the other. */
const sameContext = (a: Stored | null, b: Stored | null) =>
  a !== null && b !== null && a.token === b.token && a.companyId === b.companyId && a.assignmentId === b.assignmentId;

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const persistRef = useRef<(next: Stored | null) => void>(() => undefined);
  const [stored, setStored] = useState<Stored | null>(() => {
    // Set up before any child mounts (children's effects run before this component's), so the first queries after
    // a reload already carry the stored token and selection, and a 401 is handled from the first request on.
    const initial = load();
    setSession(apiSession(initial));
    setUnauthenticatedHandler(() => persistRef.current(null));
    return initial;
  });
  const storedRef = useRef(stored);
  const [me, setMe] = useState<MeContext | null>(null);
  const [permissions, setPermissions] = useState<Set<string>>(() => new Set());
  const [contextFailed, setContextFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const persist = useCallback(
    (next: Stored | null) => {
      const previous = storedRef.current;
      storedRef.current = next;
      save(next);
      setSession(apiSession(next));
      if (!sameContext(previous, next)) {
        // Another user, company or role: nothing cached or loaded for the previous one may be shown (confidential
        // lists such as documents, the previous user's role choices, the previous role's permissions).
        queryClient.clear();
        setMe(null);
        setPermissions(new Set());
      }
      setStored(next);
    },
    [queryClient],
  );
  persistRef.current = persist;
  // Registered again once mounted, so the handler belongs to the committed instance (StrictMode renders twice).
  useEffect(() => setUnauthenticatedHandler(() => persistRef.current(null)), []);

  useEffect(() => {
    if (!stored?.assignmentId) return;
    let cancelled = false;
    setContextFailed(false);
    Promise.all([api<MeContext>('/v1/me/context'), api<{ permissions: string[] }>('/v1/me/permissions')])
      .then(([context, perms]) => {
        if (cancelled) return;
        setMe(context);
        setPermissions(new Set(perms.permissions));
      })
      .catch(() => {
        // (A 401 has already ended the session through the unauthenticated handler.)
        if (!cancelled) setContextFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [stored?.token, stored?.companyId, stored?.assignmentId, attempt]);

  const value = useMemo<SessionValue>(
    () => ({
      stored,
      me,
      contextFailed,
      retryContext: () => setAttempt((n) => n + 1),
      permissions,
      can: (p) => permissions.has(p),
      signIn: (token, companies) => persist({ token, companies, companyId: companies.length === 1 ? companies[0]!.id : null, assignmentId: null }),
      selectCompany: (companyId) => stored && persist({ ...stored, companyId, assignmentId: null }),
      selectAssignment: (assignmentId) => stored && persist({ ...stored, assignmentId }),
      switchRole: () => stored && persist({ ...stored, assignmentId: null }),
      signOut: async () => {
        try {
          await api('/v1/me/logout', { method: 'POST', withoutAssignment: true });
        } catch {
          /* the session ends here either way */
        } finally {
          persist(null);
          // Signed in through the organisation's provider: end that session too (oidc.ts).
          providerLogout();
        }
      },
    }),
    [stored, me, contextFailed, permissions, persist],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}
