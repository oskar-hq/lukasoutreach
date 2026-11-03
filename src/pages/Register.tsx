import { motion } from 'motion/react';
import { Eye, EyeOff, Lock } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ACCOUNT_USERNAME_PATTERN, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../shared/auth';
import { nameProblem, normalizeUsername, usernameProblem } from '../components/accounts/accountText';
import { Button } from '../components/ui/Button';
import { cn } from '../lib/cn';
import { ApiError } from '../lib/leadSearchApi';
import { useAuth } from '../state/auth';
import { EASE_OUT } from '../lib/motion';
import { INPUT, cardRise, rise } from './Login';

type Field = 'name' | 'username' | 'password';

/** Vorschlag für den Anmeldenamen aus dem Namen: „Anna Berg“ → „anna.berg“. */
export function suggestUsername(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 40);
  return ACCOUNT_USERNAME_PATTERN.test(base) ? base : '';
}

/**
 * Selbst registrieren (Vertrag „Registrierung und Einarbeitung“). `first`: Es gibt noch kein Konto – wer sich jetzt
 * registriert, wird Gründer und richtet danach alles im Browser ein. Sonst wartet das Konto auf Freigabe.
 */
export function RegisterForm({ first, onLogin, setupToken = null }: { first: boolean; onLogin?: () => void; setupToken?: string | null }) {
  const { register } = useAuth();
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  // Solange niemand den Anmeldenamen selbst ändert, folgt er dem Namen.
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<{ text: string; id: number } | null>(null);
  const counter = useRef(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const refs = { name: nameRef, username: usernameRef, password: passwordRef };

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const shownUsername = usernameTouched ? username : suggestUsername(name);
  const strength = password.length === 0 ? 0 : password.length < PASSWORD_MIN_LENGTH ? 1 : password.length < 14 ? 2 : password.length < 20 ? 3 : 4;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    const found: Partial<Record<Field, string>> = {};
    const nameIssue = nameProblem(name);
    if (nameIssue) found.name = nameIssue.replace('Anzeigenamen', 'Namen');
    const usernameIssue = usernameProblem(shownUsername);
    if (usernameIssue) found.username = usernameIssue;
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      found.password = `Das Passwort braucht mindestens ${PASSWORD_MIN_LENGTH} Zeichen.`;
    }
    setErrors(found);
    setFormError(null);
    const firstField = (['name', 'username', 'password'] as const).find((field) => found[field]);
    if (firstField) {
      refs[firstField].current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      await register(normalizeUsername(shownUsername), name, password, remember, first ? (setupToken ?? undefined) : undefined);
    } catch (caught) {
      setSubmitting(false);
      if (caught instanceof ApiError && caught.code === 'account_exists') {
        setUsernameTouched(true);
        setUsername(shownUsername);
        setErrors({ username: caught.message });
        refs.username.current?.focus();
        return;
      }
      if (caught instanceof ApiError && caught.code === 'weak_password') {
        setErrors({ password: caught.message });
        refs.password.current?.focus();
        return;
      }
      const text =
        caught instanceof ApiError && caught.code === 'offline'
          ? 'Registrieren hat nicht geklappt – der Server antwortet nicht.'
          : caught instanceof ApiError && caught.status === 404
            ? 'Registrieren gibt es auf diesem Server noch nicht – das kommt mit dem nächsten Update.'
            : caught instanceof ApiError && caught.code !== 'error'
              ? caught.message
              : 'Registrieren hat nicht geklappt. Versuch es noch einmal.';
      setFormError({ text, id: ++counter.current });
    }
  };

  const describedBy = (field: Field, extra?: string) => [errors[field] && `register-${field}-error`, extra].filter(Boolean).join(' ') || undefined;

  // Erstes Konto nur über den Einrichtungs-Link (Schutz davor, dass ein Fremder schneller Gründer wird).
  if (first && !setupToken) {
    return (
      <motion.div variants={rise} className="mx-auto mt-4 max-w-xl text-center text-[17px] leading-relaxed text-ink-2" data-testid="register-setup-missing">
        <p>
          Hier gibt es noch kein Konto. Das erste Konto legst du über den <span className="text-ink">Einrichtungs-Link</span> an
          – den kennt nur, wer Zugang zum Server hat.
        </p>
        <p className="mt-4 text-[14px] text-ink-3">So findest du ihn: auf dem Server im Projektordner</p>
        <code className="mt-2 inline-block max-w-full break-all rounded-lg bg-surface-3 px-3 py-1.5 text-[13px] text-ink">
          docker compose logs backend | grep Einrichtung
        </code>
        <p className="mt-3 text-[14px] text-ink-3">ausführen und den Link genau so im Browser öffnen.</p>
      </motion.div>
    );
  }

  return (
    <>
      <motion.p variants={rise} className="mx-auto mt-4 max-w-xl text-center text-[17px] leading-relaxed text-ink-2" data-testid="register-intro">
        {first ? (
          <>
            Du bist die erste Person hier. Dein Konto wird automatisch <span className="text-ink">Gründer</span> – danach
            richtest du alles im Browser ein. Die Shell brauchst du nicht mehr.
          </>
        ) : (
          'Leg dir ein Konto an. Ein Gründer gibt es danach frei und legt fest, was du im Cockpit machst.'
        )}
      </motion.p>

      <motion.form
        variants={cardRise}
        onSubmit={(event) => void submit(event)}
        noValidate
        data-testid="register-form"
        aria-label={first ? 'Gründer-Konto erstellen' : 'Registrieren'}
        className="mt-10 w-full max-w-[400px]"
      >
        <label htmlFor="register-name" className="mb-2 block text-[13px] font-medium text-ink-2">
          Dein Name
        </label>
        <input
          ref={refs.name}
          id="register-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setErrors((current) => ({ ...current, name: undefined, username: usernameTouched ? current.username : undefined }));
          }}
          autoComplete="name"
          enterKeyHint="next"
          placeholder="z. B. Anna Berg"
          aria-invalid={!!errors.name}
          aria-describedby={describedBy('name')}
          data-testid="register-name"
          className={INPUT}
        />
        <FieldError id="register-name-error" text={errors.name} />

        <label htmlFor="register-username" className="mb-2 mt-5 block text-[13px] font-medium text-ink-2">
          Anmeldename
        </label>
        <input
          ref={refs.username}
          id="register-username"
          value={shownUsername}
          onChange={(event) => {
            setUsernameTouched(true);
            setUsername(event.target.value);
            setErrors((current) => ({ ...current, username: undefined }));
          }}
          onBlur={() => usernameTouched && setUsername((value) => normalizeUsername(value))}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
          placeholder="z. B. anna"
          aria-invalid={!!errors.username}
          aria-describedby={describedBy('username', 'register-username-hint')}
          data-testid="register-username"
          className={INPUT}
        />
        <p id="register-username-hint" className="mt-2 text-[12.5px] text-ink-3">
          Damit meldest du dich an. Kleinbuchstaben, Ziffern, Punkt oder Bindestrich.
        </p>
        <FieldError id="register-username-error" text={errors.username} />

        <label htmlFor="register-password" className="mb-2 mt-5 block text-[13px] font-medium text-ink-2">
          Passwort
        </label>
        <div className="relative">
          <input
            ref={refs.password}
            id="register-password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setErrors((current) => ({ ...current, password: undefined }));
            }}
            autoComplete="new-password"
            enterKeyHint="go"
            aria-invalid={!!errors.password}
            aria-describedby={describedBy('password', 'register-password-hint')}
            data-testid="register-password"
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
        <div className="mt-2.5 flex gap-1.5" aria-hidden>
          {[1, 2, 3, 4].map((step) => (
            <span
              key={step}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors duration-200',
                strength >= step ? (strength === 1 ? 'bg-warn' : 'bg-good') : 'bg-surface-3',
              )}
            />
          ))}
        </div>
        <p id="register-password-hint" className="mt-2 text-[12.5px] text-ink-3">
          {strength === 0 || strength === 1 ? `Mindestens ${PASSWORD_MIN_LENGTH} Zeichen.` : strength === 2 ? 'Reicht. Länger ist sicherer.' : 'Stark.'}
        </p>
        <FieldError id="register-password-error" text={errors.password} />

        <label className="mt-5 flex cursor-pointer select-none items-center gap-2.5 text-[14px] text-ink-2">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            className="h-[18px] w-[18px] shrink-0 cursor-pointer accent-white"
          />
          Angemeldet bleiben
        </label>

        {formError && (
          <motion.p
            key={formError.id}
            role="alert"
            data-testid="register-error"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className="mt-5 flex items-baseline gap-2 text-[14px] leading-snug text-ink"
          >
            <span className="h-1.5 w-1.5 shrink-0 -translate-y-0.5 rounded-full bg-bad" aria-hidden />
            {formError.text}
          </motion.p>
        )}

        <Button
          type="submit"
          variant="primary"
          size="xl"
          shortcut={submitting ? undefined : '↵'}
          disabled={submitting}
          aria-busy={submitting}
          data-testid="register-submit"
          className="mt-7 w-full"
        >
          {submitting ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black" aria-hidden />
              Wird angelegt…
            </>
          ) : first ? (
            'Gründer-Konto erstellen'
          ) : (
            'Konto anlegen'
          )}
        </Button>

        {first ? (
          <p className="mt-5 flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-3">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Alle weiteren Registrierungen landen erst bei dir zur Freigabe.
          </p>
        ) : (
          onLogin && (
            <p className="mt-6 text-center text-[14px] text-ink-3">
              Schon ein Konto?{' '}
              <button type="button" onClick={onLogin} className="font-medium text-ink-2 underline-offset-4 hover:text-ink hover:underline" data-testid="register-to-login">
                Anmelden
              </button>
            </p>
          )
        )}
      </motion.form>
    </>
  );
}

function FieldError({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return (
    <p id={id} role="alert" className="mt-2 flex items-baseline gap-2 text-[13.5px] leading-snug text-ink" data-testid={id}>
      <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
      {text}
    </p>
  );
}
