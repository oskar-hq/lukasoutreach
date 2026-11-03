import { motion } from 'motion/react';
import { Eye } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ACCOUNT_NAME_MAX_LENGTH, authRole, INVITE_PATH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type InviteInfo } from '../../shared/auth';
import { Button } from '../components/ui/Button';
import { FOUNDERS } from '../data/founders';
import { cn } from '../lib/cn';
import { ApiError, authApi } from '../lib/leadSearchApi';
import { useAuth } from '../state/auth';
import { EASE_OUT } from '../lib/motion';
import { cardRise, INPUT, LoginLayout, rise } from './Login';

/**
 * Token aus einem Einladungslink `…/einladung#<token>`. null: Die Seite ist keine Einladung.
 * Das Token steht hinter `#` und geht so nie an den Server (Logs, Referer). Ohne Seiteneffekte – das Entfernen
 * aus der Adresse übernimmt `App` per Effekt (StrictMode ruft Initialisierer doppelt auf).
 */
export function readInviteToken(): string | null {
  if (window.location.pathname.replace(/\/+$/, '') !== INVITE_PATH) return null;
  try {
    return decodeURIComponent(window.location.hash.slice(1)).trim();
  } catch {
    return '';
  }
}

type CheckState =
  | { status: 'checking' }
  | { status: 'valid'; invite: InviteInfo }
  /** Link fehlt, ist abgelaufen oder schon benutzt. */
  | { status: 'invalid'; reason: 'missing' | 'used' }
  /** Backend kennt noch keine Einladungen (404 ohne Fehlercode). */
  | { status: 'unavailable' }
  /** Server nicht erreichbar oder Sperre (429) – Meldung vom Server bzw. eigener Satz. */
  | { status: 'error'; message: string };

/**
 * Laufende Prüfungen je Token. StrictMode (Entwicklung) ruft Effekte doppelt auf – so geht trotzdem nur eine Anfrage
 * raus, die bei der Begrenzung zählt. Nach der Antwort wird der Eintrag gelöscht, „Erneut versuchen“ fragt neu.
 */
const pendingChecks = new Map<string, Promise<InviteInfo>>();

function checkOnce(token: string): Promise<InviteInfo> {
  let pending = pendingChecks.get(token);
  if (!pending) {
    pending = authApi.checkInvite(token);
    pendingChecks.set(token, pending);
    const forget = () => pendingChecks.delete(token);
    pending.then(forget, forget);
  }
  return pending;
}

/** Was für ein Konto der Link einrichtet: „Admin-Konto“, „Gründer-Konto · Nick“, „Mitarbeiter für Nick“. */
export function inviteAccountKind(invite: Pick<InviteInfo, 'founder' | 'role'>): string {
  const role = authRole(invite);
  const founder = invite.founder ? FOUNDERS[invite.founder].name : null;
  if (role === 'admin') return 'Admin-Konto';
  if (role === 'assistant') return founder ? `Mitarbeiter für ${founder}` : 'Mitarbeiter-Konto';
  return founder ? `Gründer-Konto · ${founder}` : 'Gründer-Konto';
}

const expiryFormat = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Seite „Konto einrichten“: Passwort zum Einladungslink festlegen, danach angemeldet. */
export function Invite({ token, onDone }: { token: string; onDone: () => void }) {
  const [state, setState] = useState<CheckState>(() => (token ? { status: 'checking' } : { status: 'invalid', reason: 'missing' }));

  const check = useCallback(() => {
    if (!token) return () => undefined;
    let cancelled = false;
    setState({ status: 'checking' });
    checkOnce(token)
      .then((invite) => !cancelled && setState({ status: 'valid', invite }))
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === 'invite_invalid') setState({ status: 'invalid', reason: 'used' });
        // Ältere Backends: Route fehlt (404 ohne Code) oder ist nicht offen (401) – Einladungen gibt es dort noch nicht.
        else if (error instanceof ApiError && (error.status === 404 || error.status === 401)) setState({ status: 'unavailable' });
        else if (error instanceof ApiError && error.code !== 'offline') setState({ status: 'error', message: error.message });
        else setState({ status: 'error', message: 'Der Server ist gerade nicht erreichbar. Versuch es gleich noch einmal.' });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(check, [check]);

  if (state.status === 'valid') {
    const { invite } = state;
    return (
      <LoginLayout title={invite.accountExists ? `Hallo ${invite.name}.` : `Willkommen, ${invite.name}.`}>
        <InviteForm
          token={token}
          invite={invite}
          onDone={onDone}
          onInvalid={() => setState({ status: 'invalid', reason: 'used' })}
        />
      </LoginLayout>
    );
  }

  if (state.status === 'checking') {
    return (
      <LoginLayout title="Einen Moment …">
        <motion.p variants={rise} role="status" className="mx-auto mt-4 max-w-xl text-center text-[17px] leading-relaxed text-ink-2">
          Dein Link wird geprüft.
        </motion.p>
      </LoginLayout>
    );
  }

  const content =
    state.status === 'invalid' && state.reason === 'missing'
      ? {
          // Auch nach Neuladen: Die Seite merkt sich das Token absichtlich nicht – der Link kann noch gelten.
          title: 'Öffne den Link noch einmal.',
          text: 'Die Seite merkt sich deinen Link aus Sicherheitsgründen nicht – öffne ihn direkt aus der Nachricht.',
          retry: false,
        }
      : state.status === 'invalid'
      ? {
          title: 'Dieser Link gilt nicht mehr.',
          text: 'Er ist abgelaufen oder wurde schon benutzt – frag nach einem neuen Link.',
          retry: false,
        }
      : state.status === 'unavailable'
        ? { title: 'Noch nicht möglich.', text: 'Konten per Link einrichten gibt es auf diesem Server noch nicht.', retry: false }
        : { title: 'Das hat nicht geklappt.', text: state.message, retry: true };

  return (
    <LoginLayout title={content.title}>
      <motion.p
        variants={rise}
        role="alert"
        data-testid="invite-message"
        className="mx-auto mt-4 max-w-xl text-center text-[17px] leading-relaxed text-ink-2"
      >
        {content.text}
      </motion.p>
      <motion.div variants={cardRise} className="mt-10 w-full max-w-[400px]">
        {content.retry ? (
          <Button variant="primary" size="xl" className="w-full" onClick={check} autoFocus data-testid="invite-retry">
            Erneut versuchen
          </Button>
        ) : (
          <Button variant="primary" size="xl" className="w-full" onClick={onDone} autoFocus data-testid="invite-to-login">
            Zur Anmeldung
          </Button>
        )}
      </motion.div>
    </LoginLayout>
  );
}

type FieldError = 'name' | 'password' | 'repeat' | 'none';

function InviteForm({
  token,
  invite,
  onDone,
  onInvalid,
}: {
  token: string;
  invite: InviteInfo;
  onDone: () => void;
  onInvalid: () => void;
}) {
  const { acceptInvite } = useAuth();
  // Eigener Name (Wunsch des Nutzers 08.10.): vorbelegt mit dem Namen aus der Einladung, so spricht die Software dich an.
  const [name, setName] = useState(invite.name);
  const nameRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // `attempt` als Key: Jede Meldung ist ein neuer Knoten, damit Screenreader auch eine gleichlautende neu ansagen.
  const [error, setError] = useState<{ text: string; fields: FieldError; attempt: number } | null>(null);
  const attempts = useRef(0);
  const passwordRef = useRef<HTMLInputElement>(null);
  const repeatRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    passwordRef.current?.focus();
  }, []);

  const fail = (text: string, fields: FieldError) => setError({ text, fields, attempt: ++attempts.current });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    if (!invite.accountExists && (!name.trim() || name.trim().length > ACCOUNT_NAME_MAX_LENGTH)) {
      fail(`Bitte gib deinen Namen ein (1 bis ${ACCOUNT_NAME_MAX_LENGTH} Zeichen).`, 'name');
      nameRef.current?.focus();
      return;
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      fail(`Das Passwort braucht mindestens ${PASSWORD_MIN_LENGTH} Zeichen.`, 'password');
      passwordRef.current?.focus();
      return;
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
      fail(`Das Passwort darf höchstens ${PASSWORD_MAX_LENGTH} Zeichen haben.`, 'password');
      passwordRef.current?.focus();
      return;
    }
    if (!repeat) {
      // Enter im ersten Feld führt ins zweite – kein Fehler.
      if (document.activeElement === passwordRef.current) setError(null);
      else fail('Bitte gib das Passwort ein zweites Mal ein.', 'repeat');
      repeatRef.current?.focus();
      return;
    }
    if (password !== repeat) {
      fail('Die beiden Passwörter sind nicht gleich.', 'repeat');
      setRepeat('');
      repeatRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await acceptInvite(token, password, remember, invite.accountExists ? undefined : name.trim());
      onDone();
    } catch (caught) {
      setSubmitting(false);
      if (caught instanceof ApiError && caught.code === 'invite_invalid') {
        onInvalid();
        return;
      }
      fail(
        caught instanceof ApiError && caught.code === 'offline'
          ? 'Das hat nicht geklappt – der Server antwortet nicht. Versuch es gleich noch einmal.'
          : caught instanceof ApiError
            ? caught.message
            : 'Das hat nicht geklappt. Versuch es noch einmal.',
        caught instanceof ApiError && caught.code === 'weak_password' ? 'password' : 'none',
      );
      passwordRef.current?.focus();
    }
  };

  const passwordInvalid = error?.fields === 'password';
  const repeatInvalid = error?.fields === 'repeat';

  return (
    <>
      {/* Nur beim Zurücksetzen nötig: Dass man überall sonst abgemeldet wird, zeigt die Seite sonst nirgends. */}
      {invite.accountExists && (
        <motion.p variants={rise} id="invite-intro" className="mx-auto mt-4 max-w-xl text-center text-[17px] leading-relaxed text-ink-2">
          Leg ein neues Passwort fest – überall sonst wirst du dabei abgemeldet.
        </motion.p>
      )}

      <motion.form
        variants={cardRise}
        onSubmit={submit}
        noValidate
        data-testid="invite-form"
        aria-label={invite.accountExists ? 'Neues Passwort festlegen' : 'Konto einrichten'}
        className="mt-10 w-full max-w-[400px]"
      >
        {!invite.accountExists && (
          <>
            <label htmlFor="invite-name" className="mb-2 block text-[13px] font-medium text-ink-2">
              Dein Name
            </label>
            <input
              ref={nameRef}
              id="invite-name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
              enterKeyHint="next"
              maxLength={ACCOUNT_NAME_MAX_LENGTH + 20}
              aria-invalid={error?.fields === 'name'}
              aria-describedby={error?.fields === 'name' ? 'invite-error' : 'invite-name-hint'}
              data-testid="invite-name"
              className={INPUT}
            />
            <p id="invite-name-hint" className="mb-5 mt-2 text-[12.5px] text-ink-3">
              So spricht dich das Cockpit an.
            </p>
          </>
        )}
        {/* Anmeldename sichtbar und für Passwort-Manager auslesbar – damit meldet man sich künftig an. */}
        <label htmlFor="invite-username" className="mb-2 block text-[13px] font-medium text-ink-2">
          Anmeldename
        </label>
        <input
          id="invite-username"
          name="username"
          value={invite.username}
          readOnly
          autoComplete="username"
          aria-describedby="invite-footer"
          data-testid="invite-username"
          className={cn(INPUT, 'text-ink-2')}
        />

        <label htmlFor="invite-password" className="mb-2 mt-5 block text-[13px] font-medium text-ink-2">
          Passwort
        </label>
        <div className="relative">
          <input
            ref={passwordRef}
            id="invite-password"
            name="new-password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            enterKeyHint="next"
            aria-invalid={passwordInvalid}
            // Fehler zuerst, dann Hinweis und Einleitung – beim Fokus nach einem Fehler wird der Grund vorgelesen.
            aria-describedby={[error && (error.fields === 'password' || error.fields === 'none') && 'invite-error', 'invite-password-hint', invite.accountExists && 'invite-intro']
              .filter(Boolean)
              .join(' ')}
            className={cn(INPUT, 'pr-12')}
          />
          <button
            type="button"
            onClick={() => setShowPassword((value) => !value)}
            aria-label="Passwort anzeigen"
            aria-pressed={showPassword}
            className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink aria-pressed:text-ink"
          >
            <Eye className="h-4 w-4" />
          </button>
        </div>
        <p id="invite-password-hint" className="mt-2 text-[12.5px] text-ink-3">
          Mindestens {PASSWORD_MIN_LENGTH} Zeichen.
        </p>

        <label htmlFor="invite-repeat" className="mb-2 mt-5 block text-[13px] font-medium text-ink-2">
          Passwort wiederholen
        </label>
        <input
          ref={repeatRef}
          id="invite-repeat"
          name="new-password-repeat"
          type={showPassword ? 'text' : 'password'}
          value={repeat}
          onChange={(event) => setRepeat(event.target.value)}
          autoComplete="new-password"
          enterKeyHint="go"
          aria-invalid={repeatInvalid}
          aria-describedby={repeatInvalid ? 'invite-error' : undefined}
          className={INPUT}
        />

        <label className="mt-5 flex cursor-pointer select-none items-center gap-2.5 text-[14px] text-ink-2">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            data-testid="invite-remember"
            className="h-[18px] w-[18px] shrink-0 cursor-pointer accent-white"
          />
          Angemeldet bleiben
        </label>

        {error && (
          <motion.p
            key={error.attempt}
            id="invite-error"
            role="alert"
            data-testid="invite-error"
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
          data-testid="invite-submit"
          className="mt-7 w-full"
        >
          {submitting ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black" aria-hidden />
              Wird gespeichert…
            </>
          ) : invite.accountExists ? (
            'Passwort speichern'
          ) : (
            'Konto einrichten'
          )}
        </Button>
        {/* Unauffälliger Ausweg, z. B. wenn das Passwort doch wieder einfällt – die Haupt-Aktion bleibt oben. */}
        <button
          type="button"
          onClick={onDone}
          data-testid="invite-cancel"
          className="mx-auto mt-4 block rounded-full px-3 py-1.5 text-[13px] text-ink-3 transition-colors hover:text-ink-2"
        >
          Zur Anmeldung
        </button>
      </motion.form>

      <motion.p variants={rise} id="invite-footer" className="mt-6 text-center text-[12.5px] text-ink-3">
        <span data-testid="invite-account-kind">{inviteAccountKind(invite)}</span> · Link gültig bis{' '}
        {expiryFormat.format(invite.expiresAt)} Uhr
      </motion.p>
    </>
  );
}
