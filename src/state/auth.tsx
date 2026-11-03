import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AUTH_FOUNDER_IDS,
  authRole,
  canEditSettings,
  canManageAccounts,
  canSendOnLinkedIn,
  workingFounders,
  type AuthFounderId,
  type AuthRole,
  type AuthUser,
} from '../../shared/auth';
import { applyFounderNames } from '../data/founders';
import { ApiError, authApi, onUnauthorized } from '../lib/leadSearchApi';

/** Warum die Anmeldeseite zu sehen ist – steuert den Satz unter der Überschrift. */
export type AuthNotice = 'expired' | 'offline';

export type AuthState =
  /** Beim Start: `/api/auth/me` läuft noch. */
  | { status: 'checking' }
  /** Backend ohne Login (404 auf `/api/auth/*`): Demo-Auswahl „Nick oder Johannes“ wie bisher. */
  | { status: 'disabled' }
  | { status: 'anonymous'; notice: AuthNotice | null; lastUsername: string | null }
  | { status: 'authenticated'; user: AuthUser };

interface AuthContextValue {
  auth: AuthState;
  /** Wirft `ApiError` mit deutscher Meldung (falsches Passwort, zu viele Versuche, offline). */
  login: (username: string, password: string, remember: boolean) => Promise<void>;
  /** Wirft `ApiError`, wenn der Server nicht erreichbar war – dann gilt die Sitzung weiter. */
  logout: () => Promise<void>;
  /** Einladungslink annehmen: Passwort festlegen und angemeldet sein. Wirft `ApiError` wie `login`. */
  /** `name`: eigener Name (nur neue Konten), sonst gilt der Name aus der Einladung. */
  acceptInvite: (token: string, password: string, remember: boolean, name?: string) => Promise<void>;
  /** Selbst registrieren (erstes Konto: Gründer, sonst Warten auf Freigabe). Wirft `ApiError` wie `login`. */
  /** `setupToken`: nur erstes Konto – Schlüssel aus dem Einrichtungs-Link (`#setup=…`). */
  register: (username: string, name: string, password: string, remember: boolean, setupToken?: string) => Promise<void>;
  /** Einrichtung bzw. Einarbeitung abgeschlossen. Wirft `ApiError`, wenn der Server nicht erreichbar war. */
  finishOnboarding: () => Promise<void>;
  /** `/api/auth/me` neu fragen (z. B. warten auf Freigabe). */
  refresh: () => Promise<void>;
  /**
   * Passwort aus der Registrierung, nur im Speicher und nur bis die Einrichtung fertig ist – damit die Einrichtung
   * Schlüssel speichern kann, ohne gleich wieder danach zu fragen (Einstellungen verlangen es bei Schlüsseln).
   */
  setupPassword: () => string | null;
  /**
   * Admin und Mitarbeiter mit mehreren Gründern: wessen Aufgaben gerade zu sehen sind. Gemerkt im Browser.
   * Welcher Gründer wirklich gilt, sagt `sessionFounderOf`.
   */
  adminFounder: AuthFounderId;
  setAdminFounder: (founder: AuthFounderId) => void;
}

/**
 * Wessen Tagesstapel die Sitzung zeigt: Gründer sich selbst, Admin den gewählten, Mitarbeiter den gewählten, wenn er
 * für ihn arbeitet, sonst den ersten seiner Gründer. null = noch nicht freigegeben.
 */
export function sessionFounderOf(user: AuthUser, chosen: AuthFounderId): AuthFounderId | null {
  if (user.awaitingApproval) return null;
  const role = authRole(user);
  if (role === 'founder') return user.founder;
  const allowed = workingFounders(user);
  return allowed.includes(chosen) ? chosen : (allowed[0] ?? null);
}

/** Gleiches Konto mit gleichen Angaben? (Rolle, Freigabe, Einführung, Gründer) */
function sameUser(a: AuthUser, b: AuthUser): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const ADMIN_FOUNDER_KEY = 'cockpit.adminFounder';

function readAdminFounder(): AuthFounderId {
  try {
    const value = window.localStorage.getItem(ADMIN_FOUNDER_KEY);
    return (AUTH_FOUNDER_IDS as readonly string[]).includes(value ?? '') ? (value as AuthFounderId) : 'nick';
  } catch {
    return 'nick';
  }
}

/** Beim Zurückkehren in den Tab höchstens so oft nachsehen, ob die Sitzung noch gilt. */
const RECHECK_INTERVAL_MS = 60_000;
/** War der Server beim Start nicht erreichbar, so oft erneut nachsehen. */
const OFFLINE_RETRY_MS = 5_000;

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState>({ status: 'checking' });
  const [adminFounder, setAdminFounderState] = useState<AuthFounderId>(readAdminFounder);
  const setAdminFounder = useCallback((founder: AuthFounderId) => {
    setAdminFounderState(founder);
    try {
      window.localStorage.setItem(ADMIN_FOUNDER_KEY, founder);
    } catch {
      // Privates Fenster: gilt dann nur bis zum Neuladen.
    }
  }, []);
  const authRef = useRef(auth);
  authRef.current = auth;
  const lastCheck = useRef(0);
  /** Jede Anmeldung, Abmeldung und Prüfung zählt hoch – ältere Antworten von `/me` werden verworfen. */
  const generation = useRef(0);

  const expire = useCallback(() => {
    const current = authRef.current;
    generation.current++;
    if (current.status === 'authenticated') {
      setAuth({ status: 'anonymous', notice: 'expired', lastUsername: current.user.username });
    } else if (current.status === 'disabled') {
      // Das Backend hat inzwischen einen Login (z. B. nach einem Update) – Demo-Auswahl gilt nicht mehr.
      setAuth({ status: 'anonymous', notice: null, lastUsername: null });
    }
  }, []);

  /** Fragt `/api/auth/me`: 200 → angemeldet, 401 → Anmeldung, 404 → Backend ohne Login, sonst offline. */
  const check = useCallback(async () => {
    const run = ++generation.current;
    lastCheck.current = Date.now();
    try {
      const user = await authApi.me();
      if (run !== generation.current) return;
      const current = authRef.current;
      // Gleiche Sitzung → nichts ändern. Anderer Nutzer (z. B. in einem zweiten Tab angemeldet) oder geänderte Angaben
      // (Freigabe, Rolle, Einführung erledigt) → übernehmen.
      if (current.status !== 'authenticated' || !sameUser(current.user, user)) setAuth({ status: 'authenticated', user });
    } catch (error) {
      if (run !== generation.current) return;
      const current = authRef.current;
      if (error instanceof ApiError && error.status === 404) {
        if (current.status !== 'disabled') setAuth({ status: 'disabled' });
      } else if (error instanceof ApiError && error.status === 401) {
        if (current.status === 'authenticated' || current.status === 'disabled') expire();
        else if (current.status === 'checking' || current.notice === 'offline') {
          setAuth({ status: 'anonymous', notice: null, lastUsername: current.status === 'anonymous' ? current.lastUsername : null });
        }
      } else if (current.status === 'checking') {
        // Server nicht erreichbar. Eine kurze Störung während der Arbeit meldet dagegen niemanden ab.
        setAuth({ status: 'anonymous', notice: 'offline', lastUsername: null });
      }
    }
  }, [expire]);

  // Beim Start: Gibt es schon eine Sitzung (Cookie)?
  useEffect(() => {
    void check();
  }, [check]);

  // 401 auf einer geschützten Route → Sitzung abgelaufen, zurück zur Anmeldung.
  useEffect(() => onUnauthorized(expire), [expire]);

  // Tab war länger im Hintergrund: Sitzung prüfen, damit nicht erst die nächste Aktion scheitert.
  // War der Server nicht erreichbar, sofort neu prüfen – auch, sobald das Netz zurück ist.
  const offline = auth.status === 'anonymous' && auth.notice === 'offline';
  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState !== 'visible') return;
      const current = authRef.current;
      if (current.status === 'anonymous' && current.notice === 'offline') void check();
      else if (current.status === 'authenticated' || current.status === 'disabled') {
        if (Date.now() - lastCheck.current >= RECHECK_INTERVAL_MS) void check();
      }
    };
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('online', recheck);
    const timer = offline ? window.setInterval(recheck, OFFLINE_RETRY_MS) : undefined;
    return () => {
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('online', recheck);
      window.clearInterval(timer);
    };
  }, [check, offline]);

  const login = useCallback(async (username: string, password: string, remember: boolean) => {
    generation.current++;
    try {
      const user = await authApi.login({ username: username.trim().toLowerCase(), password, remember });
      generation.current++;
      lastCheck.current = Date.now();
      setAuth({ status: 'authenticated', user });
    } catch (error) {
      // Backend ohne Login (z. B. nach einem Rückbau): Demo-Auswahl statt Formular.
      if (error instanceof ApiError && error.status === 404) {
        setAuth({ status: 'disabled' });
        return;
      }
      throw error;
    }
  }, []);

  const logout = useCallback(async () => {
    if (authRef.current.status !== 'authenticated') return;
    generation.current++;
    // Erst abmelden, dann die Seite wechseln – sonst gilt das Cookie nach dem Neuladen noch.
    try {
      await authApi.logout();
    } catch (error) {
      // 401/404: Es gibt ohnehin keine Sitzung mehr. Sonst (offline, Serverfehler) bleibt das Cookie gültig.
      if (!(error instanceof ApiError && (error.status === 401 || error.status === 404))) {
        throw new ApiError('logout_failed', 'Abmelden hat nicht geklappt – der Server ist nicht erreichbar. Versuch es gleich noch einmal.', 0);
      }
    }
    generation.current++;
    setAuth({ status: 'anonymous', notice: null, lastUsername: null });
  }, []);

  const acceptInvite = useCallback(async (token: string, password: string, remember: boolean, name?: string) => {
    // Zähler erst nach Erfolg erhöhen: Scheitert das Einrichten, darf eine noch laufende Startprüfung nicht verfallen.
    const user = await authApi.acceptInvite({ token, password, remember, ...(name ? { name } : {}) });
    generation.current++;
    lastCheck.current = Date.now();
    setAuth({ status: 'authenticated', user });
  }, []);

  const freshPassword = useRef<string | null>(null);

  const register = useCallback(async (username: string, name: string, password: string, remember: boolean, setupToken?: string) => {
    const user = await authApi.register({ username: username.trim().toLowerCase(), name: name.trim(), password, remember, ...(setupToken ? { setupToken } : {}) });
    generation.current++;
    lastCheck.current = Date.now();
    freshPassword.current = user.onboarding === 'setup' ? password : null;
    setAuth({ status: 'authenticated', user });
  }, []);

  const finishOnboarding = useCallback(async () => {
    const user = await authApi.onboardingDone();
    generation.current++;
    lastCheck.current = Date.now();
    freshPassword.current = null;
    setAuth({ status: 'authenticated', user });
  }, []);

  const setupPassword = useCallback(() => freshPassword.current, []);

  // Beim Abmelden das Passwort aus der Registrierung vergessen.
  useEffect(() => {
    if (auth.status !== 'authenticated') freshPassword.current = null;
  }, [auth.status]);

  // Namen der Gründer aus den Konten – im Zeichnen, damit das Cockpit schon beim ersten Bild die richtigen zeigt.
  if (auth.status === 'authenticated') applyFounderNames(auth.user.founderNames);

  const value = useMemo(
    () => ({ auth, login, logout, acceptInvite, register, finishOnboarding, refresh: check, setupPassword, adminFounder, setAdminFounder }),
    [auth, login, logout, acceptInvite, register, finishOnboarding, check, setupPassword, adminFounder, setAdminFounder],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth muss innerhalb von AuthProvider verwendet werden');
  return context;
}

export interface Access {
  /** Angemeldetes Konto – null in der reinen Demo (Backend ohne Login). */
  user: AuthUser | null;
  role: AuthRole;
  /** Wessen Tagesstapel diese Sitzung zeigt (Gründer, Mitarbeiter: ihr gewählter Gründer, Admin: gewählt). */
  founder: AuthFounderId | null;
  /** Zwischen diesen Gründern kann das Konto oben wechseln (Admin: alle, Mitarbeiter: seine; sonst leer). */
  switchableFounders: AuthFounderId[];
  canEditSettings: boolean;
  canManageAccounts: boolean;
  canSendOnLinkedIn: boolean;
}

/** Was das angemeldete Konto darf (Regeln in `shared/auth.ts`). Die Demo ohne Login darf alles außer Konten. */
export function useAccess(): Access {
  const { auth, adminFounder } = useAuth();
  if (auth.status !== 'authenticated') {
    return { user: null, role: 'founder', founder: null, switchableFounders: [], canEditSettings: true, canManageAccounts: false, canSendOnLinkedIn: true };
  }
  const user = auth.user;
  const role = authRole(user);
  const working = role === 'founder' ? [] : workingFounders(user);
  return {
    user,
    role,
    founder: sessionFounderOf(user, adminFounder),
    switchableFounders: working.length > 1 ? working : [],
    canEditSettings: canEditSettings(user),
    canManageAccounts: canManageAccounts(user),
    canSendOnLinkedIn: canSendOnLinkedIn(user),
  };
}
