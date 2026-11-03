import { motion, type Variants } from 'motion/react';
import { ArrowRight, Eye, EyeOff } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { Avatar } from '../components/ui/Avatar';
import { Button } from '../components/ui/Button';
import { Logo } from '../components/layout/Logo';
import { FOUNDER_IDS, FOUNDERS } from '../data/founders';
import { cn } from '../lib/cn';
import { REGISTER_PATH, SETUP_FRAGMENT } from '../../shared/auth';
import { ApiError, authApi, tasksApi } from '../lib/leadSearchApi';
import { useAuth, type AuthNotice } from '../state/auth';
import { readStackScope, useDemo } from '../state/demo';
import type { FounderId } from '../state/types';
import { RegisterForm } from './Register';
import { EASE_OUT } from '../lib/motion';

/** Inhalte erscheinen nacheinander: Überschrift → Text → Karten → Hinweis. */
const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.35 } },
};

// Bewegung über y/scale statt transform-Text: Nur so schaltet MotionConfig sie bei „Bewegung reduzieren“ ab.
export const rise: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.8, ease: EASE_OUT } },
};

export const cardRise: Variants = {
  hidden: { opacity: 0, y: 18, scale: 0.97 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.8, ease: EASE_OUT } },
};

/** Lichtkegel auf der Karte folgt dem Mauszeiger (nur bei echter Maus/Trackpad sichtbar). */
function trackPointer(event: PointerEvent<HTMLElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty('--mx', `${event.clientX - rect.left}px`);
  event.currentTarget.style.setProperty('--my', `${event.clientY - rect.top}px`);
}

/**
 * Schlüssel aus dem Einrichtungs-Link (`/registrieren#setup=…`, nur fürs erste Konto). Einmal gelesen, sofort aus der
 * Adresse genommen (Verlauf, Screenshots) und nur im Speicher gehalten – auch wenn die Anmeldeseite neu aufgebaut wird.
 */
let setupTokenMemo: string | null = null;
function readSetupToken(): string | null {
  const hash = window.location.hash.slice(1);
  if (hash.startsWith(SETUP_FRAGMENT)) {
    try {
      setupTokenMemo = decodeURIComponent(hash.slice(SETUP_FRAGMENT.length)).trim() || setupTokenMemo;
    } catch {
      // Kaputter Link – wie ohne Schlüssel.
    }
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }
  return setupTokenMemo;
}

/** Anmelden oder registrieren. `/registrieren` (Link fürs Team) öffnet gleich das Registrieren. */
export function Login() {
  const { auth } = useAuth();
  // Hinweis und Name der letzten Anmeldeseite festhalten: Nach erfolgreicher Anmeldung blendet das Formular
  // (mit „Anmelden…“) aus, statt kurz die Demo-Auswahl oder einen anderen Satz zu zeigen.
  const lastAnonymous = useRef<{ notice: AuthNotice | null; lastUsername: string | null }>({ notice: null, lastUsername: null });
  if (auth.status === 'anonymous') lastAnonymous.current = { notice: auth.notice, lastUsername: auth.lastUsername };
  const [mode, setModeState] = useState<'login' | 'register'>(() => (window.location.pathname === REGISTER_PATH ? 'register' : 'login'));
  const [setupToken] = useState(readSetupToken);
  // Noch kein Konto auf diesem Server? Dann gibt es nur „Gründer-Konto erstellen“. Ältere Backends: normale Anmeldung.
  const [setup, setSetup] = useState<'checking' | 'first' | 'normal'>(auth.status === 'disabled' ? 'normal' : 'checking');
  useEffect(() => {
    if (auth.status === 'disabled') return;
    let cancelled = false;
    authApi
      .setup()
      .then((info) => !cancelled && setSetup(info.firstAccount ? 'first' : 'normal'))
      .catch(() => !cancelled && setSetup('normal'));
    return () => {
      cancelled = true;
    };
  }, [auth.status]);

  const setMode = (next: 'login' | 'register') => {
    setModeState(next);
    window.history.replaceState(null, '', `${next === 'register' ? REGISTER_PATH : '/'}${window.location.search}`);
  };

  if (auth.status === 'disabled') {
    return (
      <LoginLayout>
        <FounderPicker />
      </LoginLayout>
    );
  }
  // Kurz warten statt erst die Anmeldung und dann „Gründer-Konto erstellen“ aufblitzen zu lassen.
  if (setup === 'checking') return <Connecting />;
  if (setup === 'first') {
    return (
      <LoginLayout title="Willkommen.">
        <RegisterForm first setupToken={setupToken} />
      </LoginLayout>
    );
  }
  if (mode === 'register') {
    return (
      <LoginLayout title="Konto anlegen.">
        <RegisterForm first={false} onLogin={() => setMode('login')} />
      </LoginLayout>
    );
  }
  return (
    <LoginLayout>
      <LoginForm {...lastAnonymous.current} onRegister={() => setMode('register')} />
    </LoginLayout>
  );
}

/** Sitzungsprüfung dauert länger als üblich: nach kurzer Zeit ein Hinweis statt einer schwarzen Seite. */
export function Connecting() {
  return (
    <motion.div
      role="status"
      className="flex min-h-dvh items-center justify-center gap-2.5 text-[14px] text-ink-3"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.6, duration: 0.3 }}
    >
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/15 border-t-white/60" aria-hidden />
      Verbinde …
    </motion.div>
  );
}

/** Horizont, Logo und zentrierte Spalte – gleich für Anmeldeformular, Demo-Auswahl und Einladung. */
export function LoginLayout({ children, title = 'Willkommen zurück.' }: { children: ReactNode; title?: string }) {
  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden">
      {/* Horizont: geht beim Öffnen einmal auf wie ein Sonnenaufgang. Nur Verläufe, keine Filter. */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        initial={{ opacity: 0, y: 140 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.8, ease: EASE_OUT }}
      >
        <div className="absolute left-1/2 top-[78%] h-[1400px] w-[2200px] -translate-x-1/2 rounded-[50%] border-t border-white/25 bg-canvas shadow-[0_-40px_160px_-20px_rgb(255_255_255/0.22)]" />
        <motion.div
          className="absolute left-1/2 top-[78%] h-[360px] w-[1200px] -translate-x-1/2 -translate-y-1/2 rounded-[50%] bg-[radial-gradient(closest-side,rgb(255_255_255/0.14),transparent)]"
          initial={{ opacity: 0, scaleX: 0.6 }}
          animate={{ opacity: 1, scaleX: 1 }}
          transition={{ duration: 1.6, delay: 0.5, ease: EASE_OUT }}
        />
      </motion.div>

      <motion.header
        className="relative z-10 flex h-16 items-center px-6"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.2, ease: EASE_OUT }}
      >
        <Logo />
      </motion.header>

      <motion.main
        className="relative z-10 flex flex-1 flex-col items-center justify-center px-4 pb-32 pt-6"
        variants={stagger}
        initial="hidden"
        animate="show"
      >
        <motion.h1 variants={rise} className="display text-center text-[44px] font-semibold sm:text-[64px]">
          {title}
        </motion.h1>
        {children}
      </motion.main>
    </div>
  );
}

const NOTICE_TEXT: Record<AuthNotice, string> = {
  expired: 'Deine Sitzung ist abgelaufen. Melde dich bitte erneut an.',
  offline: 'Der Server ist gerade nicht erreichbar. Versuch es gleich noch einmal.',
};

export const INPUT =
  'h-12 w-full rounded-2xl border border-transparent bg-surface-3 px-4 text-[16px] text-ink outline-none transition-colors placeholder:text-ink-4 focus:border-accent';

/** Welche Felder ein Fehler betrifft – steuert aria-invalid. Offline oder Sperre: keins. */
type FieldError = 'both' | 'username' | 'password' | 'none';

/** Echte Anmeldung: Name + Passwort, „Angemeldet bleiben“. Enter meldet an. */
function LoginForm({ notice, lastUsername, onRegister }: { notice: AuthNotice | null; lastUsername: string | null; onRegister: () => void }) {
  const { login } = useAuth();
  const [username, setUsername] = useState(lastUsername ?? '');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // `attempt` als Key: Jede Meldung ist ein neuer Knoten, damit Screenreader auch eine gleichlautende neu ansagen.
  const [error, setError] = useState<{ text: string; fields: FieldError; attempt: number } | null>(null);
  const attempts = useRef(0);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Name schon bekannt (abgelaufene Sitzung) → gleich ins Passwortfeld.
  useEffect(() => {
    (lastUsername ? passwordRef : usernameRef).current?.focus();
  }, [lastUsername]);

  const fail = (text: string, fields: FieldError) => setError({ text, fields, attempt: ++attempts.current });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    if (!username.trim()) {
      fail('Bitte gib deinen Namen ein.', 'username');
      usernameRef.current?.focus();
      return;
    }
    if (!password) {
      // Enter bzw. „Weiter“ im Namensfeld ist kein Fehler, sondern der Schritt ins Passwortfeld.
      if (document.activeElement === usernameRef.current) setError(null);
      else fail('Bitte gib dein Passwort ein.', 'password');
      passwordRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await login(username, password, remember);
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.code : null;
      fail(
        code === 'offline'
          ? 'Anmelden hat nicht geklappt – der Server antwortet nicht.'
          : caught instanceof ApiError
            ? caught.message
            : 'Anmelden hat nicht geklappt. Versuch es noch einmal.',
        code === 'invalid_credentials' ? 'both' : 'none',
      );
      setSubmitting(false);
      setPassword('');
      passwordRef.current?.focus();
    }
  };

  const usernameInvalid = error?.fields === 'both' || error?.fields === 'username';
  const passwordInvalid = error?.fields === 'both' || error?.fields === 'password';
  // Das Passwortfeld bekommt nach Fehlern und nach abgelaufener Sitzung den Fokus – dort auch den Grund vorlesen.
  const passwordDescription =
    [error && 'login-error', capsLock && 'login-capslock', notice && 'login-notice'].filter(Boolean).join(' ') || undefined;

  const trackCapsLock = (event: KeyboardEvent<HTMLInputElement>) => setCapsLock(event.getModifierState('CapsLock'));

  return (
    <>
      {/* Nur ein Satz, wenn es einen Grund gibt (abgelaufen, offline) – sonst reichen Überschrift und Formular. */}
      {notice && (
        <motion.p
          variants={rise}
          id="login-notice"
          className="mx-auto mt-4 max-w-xl text-center text-[17px] leading-relaxed text-ink-2"
          data-testid="login-notice"
        >
          {NOTICE_TEXT[notice]}
        </motion.p>
      )}

      <motion.form
        variants={cardRise}
        onSubmit={submit}
        noValidate
        data-testid="login-form"
        aria-label="Anmelden"
        className="mt-10 w-full max-w-[400px]"
      >
        <label htmlFor="login-username" className="mb-2 block text-[13px] font-medium text-ink-2">
          Name
        </label>
        <input
          ref={usernameRef}
          id="login-username"
          name="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
          placeholder="z. B. nick"
          aria-invalid={usernameInvalid}
          aria-describedby={usernameInvalid ? 'login-error' : undefined}
          className={INPUT}
        />

        <label htmlFor="login-password" className="mb-2 mt-5 block text-[13px] font-medium text-ink-2">
          Passwort
        </label>
        <div className="relative">
          <input
            ref={passwordRef}
            id="login-password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={trackCapsLock}
            onKeyUp={trackCapsLock}
            onBlur={() => setCapsLock(false)}
            autoComplete="current-password"
            enterKeyHint="go"
            aria-invalid={passwordInvalid}
            aria-describedby={passwordDescription}
            className={cn(INPUT, 'pr-12')}
          />
          <button
            type="button"
            onClick={() => setShowPassword((value) => !value)}
            aria-label="Passwort anzeigen"
            aria-pressed={showPassword}
            className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        {capsLock && (
          <p id="login-capslock" className="mt-2 flex items-center gap-2 text-[12.5px] text-ink-2">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden />
            Die Feststelltaste ist an.
          </p>
        )}

        <label className="mt-5 flex cursor-pointer select-none items-center gap-2.5 text-[14px] text-ink-2">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            data-testid="login-remember"
            className="h-[18px] w-[18px] shrink-0 cursor-pointer accent-white"
          />
          Angemeldet bleiben
        </label>

        {error && (
          <motion.p
            key={error.attempt}
            id="login-error"
            role="alert"
            data-testid="login-error"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className="mt-5 flex items-baseline gap-2 text-[14px] leading-snug text-ink"
          >
            <span className="h-1.5 w-1.5 shrink-0 -translate-y-0.5 rounded-full bg-bad" aria-hidden />
            {error.text}
          </motion.p>
        )}

        <Button
          type="submit"
          variant="primary"
          size="xl"
          shortcut={submitting ? undefined : '↵'}
          disabled={submitting}
          aria-busy={submitting}
          data-testid="login-submit"
          className="mt-7 w-full"
        >
          {submitting ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black" aria-hidden />
              Anmelden…
            </>
          ) : (
            'Anmelden'
          )}
        </Button>
        <p className="mt-6 text-center text-[14px] text-ink-3">
          Noch kein Konto?{' '}
          <button type="button" onClick={onRegister} className="font-medium text-ink-2 underline-offset-4 hover:text-ink hover:underline" data-testid="login-to-register">
            Registrieren
          </button>
        </p>
      </motion.form>
    </>
  );
}

/** Backend ohne Login (nur lokale Entwicklung): Gründer per Karte wählen. */
function FounderPicker() {
  const { dispatch } = useDemo();
  const [loading, setLoading] = useState<FounderId | null>(null);
  // Ohne Login im Backend gibt es die Aufgaben je Gründer auch ohne Sitzung.
  const [counts, setCounts] = useState<Partial<Record<FounderId, number>>>({});
  useEffect(() => {
    let cancelled = false;
    for (const id of FOUNDER_IDS) {
      tasksApi
        .get(id)
        // Heute übersprungene Aufgaben lässt das Backend schon weg.
        .then((response) => !cancelled && setCounts((current) => ({ ...current, [id]: response.tasks.length })))
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const login = (id: FounderId) => {
    if (loading) return;
    setLoading(id);
    dispatch({ type: 'LOGIN', founder: id, scope: readStackScope(id) });
  };

  return (
    <>
      <div className="mt-10 grid w-full max-w-[640px] gap-4 sm:grid-cols-2">
        {FOUNDER_IDS.map((id) => {
          const founder = FOUNDERS[id];
          const count = counts[id];
          const isLoading = loading === id;
          return (
            <motion.div key={id} variants={cardRise}>
              <button
                type="button"
                data-testid={`login-${id}`}
                onClick={() => login(id)}
                onPointerMove={trackPointer}
                className={cn(
                  'group relative flex w-full flex-col items-start overflow-hidden rounded-[24px] border bg-surface-1 p-6 text-left',
                  'transition-[border-color,background-color,opacity,transform] duration-200 ease-out active:scale-[0.98]',
                  isLoading ? 'border-white/40' : 'border-line-strong hover:border-white/30',
                  loading && !isLoading && 'opacity-40',
                )}
              >
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100"
                  style={{
                    background:
                      'radial-gradient(260px circle at var(--mx, 50%) var(--my, 50%), rgb(255 255 255 / 0.08), transparent 70%)',
                  }}
                />
                <div className="relative flex w-full items-center justify-between">
                  <Avatar name={founder.name} initials={founder.initials} size={52} />
                  <span
                    className={cn(
                      'flex h-9 w-9 items-center justify-center rounded-full transition-[background-color,transform] duration-200 ease-out',
                      isLoading ? 'bg-ink' : 'bg-surface-3 group-hover:translate-x-0.5 group-hover:bg-ink',
                    )}
                  >
                    {isLoading ? (
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black" />
                    ) : (
                      <ArrowRight className="h-4 w-4 text-ink-2 transition-colors duration-200 group-hover:text-black" />
                    )}
                  </span>
                </div>
                <p className="display relative mt-6 text-[24px] font-semibold">{founder.name}</p>
                <p className="relative mt-5 text-[12.5px] text-ink-3">
                  {isLoading ? 'Anmelden…' : count === undefined ? 'Aufgaben für heute' : `${count} ${count === 1 ? 'Aufgabe' : 'Aufgaben'} für heute`}
                </p>
              </button>
            </motion.div>
          );
        })}
      </div>
    </>
  );
}
