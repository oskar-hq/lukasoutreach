import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AUTH_FOUNDER_IDS,
  AUTH_ROLE_LABELS,
  invitableRoles,
  type AuthFounderId,
  type AuthRole,
  type AuthUser,
  type CreateInviteRequest,
  type CreateInviteResponse,
} from '../../../shared/auth';
import { cn } from '../../lib/cn';
import { ApiError, accountsApi } from '../../lib/leadSearchApi';
import { INPUT } from '../../pages/Login';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import {
  accountError,
  ASSISTANT_HINT_FOR_FOUNDER,
  founderName,
  nameProblem,
  normalizeUsername,
  ROLE_HINTS,
  usernameProblem,
} from './accountText';
import { FounderChecks, founderFields } from './FounderChecks';
import { RadioChoice } from './RadioChoice';

type Field = 'username' | 'name' | 'founder';

interface InviteDialogProps {
  open: boolean;
  user: AuthUser;
  onClose: () => void;
  /** Link erzeugt – die Seite zeigt ihn an und lädt die Liste neu. */
  onCreated: (response: CreateInviteResponse, name: string) => void;
}

/** Dialog „Konto einladen“: Anmeldename, Anzeigename, Rolle (nur Admin), Gründer (nur Admin). ↵ sendet, Esc schließt. */
export function InviteDialog({ open, user, onClose, onCreated }: InviteDialogProps) {
  const [sending, setSending] = useState(false);
  return (
    <Modal
      open={open}
      // Während des Sendens nicht schließen – sonst ginge der Link verloren.
      onClose={() => !sending && onClose()}
      labelledBy="invite-dialog-title"
    >
      {/* Der Inhalt lebt nur, solange der Dialog zu sehen ist – jedes Öffnen beginnt mit einem leeren Formular. */}
      <InviteForm user={user} sending={sending} setSending={setSending} onClose={onClose} onCreated={onCreated} />

    </Modal>
  );
}

function InviteForm({
  user,
  sending,
  setSending,
  onClose,
  onCreated,
}: Omit<InviteDialogProps, 'open'> & { sending: boolean; setSending: (value: boolean) => void }) {
  const roles = invitableRoles(user);
  const isAdmin = roles.length > 1;
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<AuthRole>(roles.includes('assistant') ? 'assistant' : roles[0]);
  const [founder, setFounder] = useState<AuthFounderId | null>(null);
  // Mitarbeiter: mehrere Gründer möglich. Gründer laden für sich selbst ein – vorausgewählt.
  const [assistantFor, setAssistantFor] = useState<AuthFounderId[]>(user.founder && user.role === 'founder' ? [user.founder] : []);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  // Jede Meldung ein neuer Knoten, damit Screenreader auch eine gleichlautende neu ansagen.
  const [formError, setFormError] = useState<{ text: string; id: number } | null>(null);
  const errorCount = useRef(0);
  const usernameRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const founderRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    usernameRef.current?.focus();
  }, []);

  const needsFounder = isAdmin && role !== 'admin';

  const focusField = (field: Field) => {
    if (field === 'username') usernameRef.current?.focus();
    else if (field === 'name') nameRef.current?.focus();
    else founderRef.current?.querySelector<HTMLElement>('[role=radio][tabindex="0"], input[type=checkbox]')?.focus();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Portale reichen Ereignisse im React-Baum weiter – ein Formular der Seite darf das nicht noch einmal bekommen.
    event.stopPropagation();
    if (sending) return;
    const found: Partial<Record<Field, string>> = {};
    const usernameIssue = usernameProblem(username);
    if (usernameIssue) found.username = usernameIssue;
    const nameIssue = nameProblem(name);
    if (nameIssue) found.name = nameIssue;
    if (needsFounder && role === 'founder' && !founder) found.founder = 'Wähl aus, welcher Gründer das ist.';
    if (needsFounder && role === 'assistant' && assistantFor.length === 0) found.founder = 'Wähl aus, für wen das Konto arbeitet – auch beide.';
    setErrors(found);
    setFormError(null);
    const first = (['username', 'name', 'founder'] as const).find((field) => found[field]);
    if (first) {
      focusField(first);
      return;
    }

    const body: CreateInviteRequest = { username: normalizeUsername(username), name: name.trim(), role };
    // Gründer als Einladende schicken keinen Gründer – das Backend setzt sie selbst ein.
    if (isAdmin) {
      if (role === 'assistant') Object.assign(body, founderFields(assistantFor));
      else body.founder = role === 'admin' ? null : founder;
    }
    setSending(true);
    try {
      const response = await accountsApi.invite(body);
      setSending(false);
      onCreated(response, body.name!);
    } catch (error) {
      setSending(false);
      if (error instanceof ApiError && error.code === 'account_exists') {
        setErrors({ username: error.message || 'Diesen Anmeldenamen gibt es schon.' });
        usernameRef.current?.focus();
        return;
      }
      const field = error instanceof ApiError && (['username', 'name', 'founder'] as string[]).includes(error.field ?? '') ? (error.field as Field) : null;
      if (field && error instanceof ApiError) {
        setErrors({ [field]: error.message });
        focusField(field);
        return;
      }
      setFormError({ text: accountError(error, 'Der Link ließ sich nicht erzeugen. Versuch es noch einmal.'), id: ++errorCount.current });
    }
  };

  const describedBy = (field: Field, hint?: string) => [errors[field] && `invite-${field}-error`, hint].filter(Boolean).join(' ') || undefined;

  return (
    <form
      // Auf dem Handy ist das Formular höher als der Dialog – dann scrollt es in sich.
      className="max-h-[var(--sheet-inner-max-h)] overflow-y-auto overscroll-contain p-6 sm:p-8"
      noValidate
      onSubmit={(event) => void submit(event)}
      data-testid="invite-dialog"
    >
      <h2 id="invite-dialog-title" className="text-[20px] font-semibold tracking-[-0.01em]">
        {isAdmin ? 'Konto einladen' : 'Mitarbeiter einladen'}
      </h2>
      <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2">
        Du bekommst einen Link, mit dem die Person ihr Passwort selbst festlegt.
      </p>

      <label htmlFor="invite-username-input" className="mb-2 mt-6 block text-[13px] font-medium text-ink-2">
        Anmeldename
      </label>
      <input
        ref={usernameRef}
        id="invite-username-input"
        value={username}
        onChange={(event) => {
          setUsername(event.target.value);
          setErrors((current) => ({ ...current, username: undefined }));
        }}
        onBlur={() => setUsername((value) => normalizeUsername(value))}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="next"
        aria-invalid={!!errors.username}
        aria-describedby={describedBy('username')}
        placeholder="z. B. anna"
        data-testid="invite-username-input"
        className={cn(INPUT, errors.username && 'border-white/25')}
      />
      <FieldError id="invite-username-error" text={errors.username} />

      <label htmlFor="invite-name-input" className="mb-2 mt-5 block text-[13px] font-medium text-ink-2">
        Anzeigename
      </label>
      <input
        ref={nameRef}
        id="invite-name-input"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setErrors((current) => ({ ...current, name: undefined }));
        }}
        autoComplete="off"
        enterKeyHint="go"
        aria-invalid={!!errors.name}
        aria-describedby={describedBy('name')}
        placeholder="z. B. Anna Berg"
        data-testid="invite-name-input"
        className={cn(INPUT, errors.name && 'border-white/25')}
      />
      <FieldError id="invite-name-error" text={errors.name} />

      {isAdmin ? (
        <>
          <p id="invite-role-label" className="mb-2 mt-6 text-[13px] font-medium text-ink-2">
            Rolle
          </p>
          <RadioChoice
            labelledBy="invite-role-label"
            describedBy="invite-role-hint"
            options={roles.map((value) => ({ value, label: AUTH_ROLE_LABELS[value] }))}
            value={role}
            onChange={(value) => {
              setRole(value);
              setErrors((current) => ({ ...current, founder: undefined }));
            }}
            testId="invite-role"
          />
          <p id="invite-role-hint" className="mt-2 text-[13px] leading-snug text-ink-3" data-testid="invite-role-hint">
            {ROLE_HINTS[role]}
          </p>
          {needsFounder && (
            <div ref={founderRef}>
              <p id="invite-founder-label" className="mb-2 mt-5 text-[13px] font-medium text-ink-2">
                {role === 'founder' ? 'Welcher Gründer?' : 'Arbeitet für (mehrere möglich)'}
              </p>
              {role === 'founder' ? (
                <RadioChoice
                  labelledBy="invite-founder-label"
                  describedBy={errors.founder ? 'invite-founder-error' : undefined}
                  invalid={!!errors.founder}
                  options={AUTH_FOUNDER_IDS.map((value) => ({ value, label: founderName(value) }))}
                  value={founder}
                  onChange={(value) => {
                    setFounder(value);
                    setErrors((current) => ({ ...current, founder: undefined }));
                  }}
                  testId="invite-founder"
                />
              ) : (
                <FounderChecks
                  labelledBy="invite-founder-label"
                  describedBy={errors.founder ? 'invite-founder-error' : undefined}
                  invalid={!!errors.founder}
                  value={assistantFor}
                  onChange={(value) => {
                    setAssistantFor(value);
                    setErrors((current) => ({ ...current, founder: undefined }));
                  }}
                  testId="invite-founders"
                />
              )}
              <FieldError id="invite-founder-error" text={errors.founder} />
            </div>
          )}
        </>
      ) : (
        <p className="mt-6 text-[14px] leading-relaxed text-ink-2" data-testid="invite-role-hint">
          {ASSISTANT_HINT_FOR_FOUNDER}
        </p>
      )}

      {formError && (
        <p key={formError.id} role="alert" className="mt-5 flex items-baseline gap-2 text-[14px] leading-snug text-ink" data-testid="invite-form-error">
          <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
          {formError.text}
        </p>
      )}

      <div className="mt-7 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onClose} disabled={sending}>
          Abbrechen
        </Button>
        <Button
          type="submit"
          variant="primary"
          shortcut={sending ? undefined : '↵'}
          disabled={sending}
          aria-busy={sending}
          data-testid="invite-create"
        >
          {sending ? 'Link wird erzeugt…' : 'Link erzeugen'}
        </Button>
      </div>
    </form>
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
