import { Check, Minus } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AUTH_FOUNDER_IDS,
  AUTH_ROLE_LABELS,
  invitableRoles,
  type AccountInfo,
  type AuthFounderId,
  type AuthRole,
  type AuthUser,
  type ApproveRequest,
} from '../../../shared/auth';
import { cn } from '../../lib/cn';
import { accountsApi } from '../../lib/leadSearchApi';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { accountError, founderName, founderNames } from './accountText';
import { FounderChecks, founderFields } from './FounderChecks';
import { RadioChoice } from './RadioChoice';

/** Was eine Rolle darf – fürs Auge, die Regeln stehen in `shared/auth.ts`. */
const RIGHTS: Record<AuthRole, [boolean, string][]> = {
  assistant: [
    [true, 'Tagesstapel abarbeiten, in deren Namen senden'],
    [true, 'Leads ansehen und bewerten'],
    [false, 'Einstellungen und Schlüssel'],
    [false, 'Konten freigeben'],
  ],
  founder: [
    [true, 'Eigener Tagesstapel und LinkedIn-Account'],
    [true, 'Leads ansehen und bewerten'],
    [true, 'Einstellungen und Schlüssel'],
    [true, 'Konten freigeben'],
  ],
  admin: [
    [false, 'Kein eigener Tagesstapel, sendet nichts'],
    [true, 'Leads ansehen, Entscheidungen eintragen'],
    [true, 'Einstellungen und Schlüssel'],
    [true, 'Konten freigeben'],
  ],
};

const ROLE_SHORT: Record<AuthRole, string> = {
  assistant: 'Arbeitet Aufgaben für Gründer ab.',
  founder: 'Eigener Stapel, darf alles einstellen.',
  admin: 'Verwaltet alles, sendet selbst nichts.',
};

/** Reihenfolge im Dialog: das Häufigste zuerst. */
const ROLE_ORDER: AuthRole[] = ['assistant', 'founder', 'admin'];

/**
 * Registrierung freigeben (Vertrag „Registrierung und Einarbeitung“): Rolle wählen, bei Mitarbeitern die Gründer
 * (auch beide), bei Gründern welcher. ↵ gibt frei, Esc schließt.
 */
export function ApproveDialog({
  account,
  user,
  onClose,
  onApproved,
}: {
  account: AccountInfo | null;
  user: AuthUser;
  onClose: () => void;
  onApproved: (account: AccountInfo) => void;
}) {
  const [busy, setBusy] = useState(false);
  // Beim Ausblenden noch den letzten Inhalt zeigen.
  const shown = useRef(account);
  if (account) shown.current = account;
  return (
    <Modal open={!!account} onClose={() => !busy && onClose()} labelledBy="approve-dialog-title" className="sm:max-w-[620px]">
      {shown.current && (
        <ApproveForm key={shown.current.username} account={shown.current} user={user} busy={busy} setBusy={setBusy} onClose={onClose} onApproved={onApproved} />
      )}
    </Modal>
  );
}

function ApproveForm({
  account,
  user,
  busy,
  setBusy,
  onClose,
  onApproved,
}: {
  account: AccountInfo;
  user: AuthUser;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onClose: () => void;
  onApproved: (account: AccountInfo) => void;
}) {
  const roles = ROLE_ORDER.filter((role) => invitableRoles(user).includes(role));
  const [role, setRole] = useState<AuthRole>('assistant');
  // Mitarbeiter: vorgewählt der eigene Gründer (Gründer) bzw. nichts (Admin).
  const [assistantFor, setAssistantFor] = useState<AuthFounderId[]>(user.role === 'founder' && user.founder ? [user.founder] : []);
  const [founder, setFounder] = useState<AuthFounderId | null>(null);
  const [error, setError] = useState<{ text: string; id: number } | null>(null);
  const counter = useRef(0);
  const firstRoleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstRoleRef.current?.focus();
  }, []);

  const roleLabel = AUTH_ROLE_LABELS[role];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    let body: ApproveRequest;
    if (role === 'assistant') {
      if (assistantFor.length === 0) {
        setError({ text: 'Wähl aus, für wen das Konto arbeitet – auch beide.', id: ++counter.current });
        return;
      }
      body = { role, ...founderFields(assistantFor) };
    } else if (role === 'founder') {
      if (!founder) {
        setError({ text: 'Wähl aus, welcher Gründer das ist.', id: ++counter.current });
        return;
      }
      body = { role, founder };
    } else {
      body = { role, founder: null };
    }
    setBusy(true);
    setError(null);
    try {
      const approved = await accountsApi.approve(account.username, body);
      setBusy(false);
      onApproved(approved);
    } catch (caught) {
      setBusy(false);
      setError({ text: accountError(caught, 'Freigeben hat nicht geklappt. Versuch es noch einmal.'), id: ++counter.current });
    }
  };

  return (
    <form className="max-h-[var(--sheet-inner-max-h)] overflow-y-auto overscroll-contain p-6 sm:p-8" noValidate onSubmit={(event) => void submit(event)} data-testid="approve-dialog">
      <h2 id="approve-dialog-title" className="text-[22px] font-semibold tracking-[-0.015em]">
        {account.name} möchte mitmachen
      </h2>
      <p className="mt-1.5 text-[14px] text-ink-3">Anmeldename {account.username}</p>

      <p id="approve-role-label" className="mb-3 mt-7 text-[15px] font-semibold tracking-[-0.01em]">
        Welche Rolle bekommt {account.name}?
      </p>
      <div role="radiogroup" aria-labelledby="approve-role-label" className="grid gap-2 sm:grid-cols-3" data-testid="approve-role">
        {roles.map((value, index) => {
          const checked = value === role;
          return (
            <button
              key={value}
              ref={index === 0 ? firstRoleRef : undefined}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => {
                setRole(value);
                setError(null);
              }}
              className={cn(
                'flex min-h-[96px] flex-col gap-1.5 rounded-2xl border p-4 text-left transition-colors',
                checked ? 'border-ink bg-surface-3' : 'border-line bg-surface-1 hover:border-line-strong',
              )}
            >
              <span className="flex w-full items-center justify-between">
                <span className="text-[15px] font-semibold">{AUTH_ROLE_LABELS[value]}</span>
                <span className={cn('flex h-[18px] w-[18px] items-center justify-center rounded-full', checked ? 'bg-ink' : 'border border-line-strong')} aria-hidden>
                  {checked && <Check className="h-2.5 w-2.5 text-black" strokeWidth={3.5} />}
                </span>
              </span>
              <span className={cn('text-[13px] leading-snug', checked ? 'text-ink-2' : 'text-ink-3')}>{ROLE_SHORT[value]}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <div>
          <p className="mb-2.5 text-[13px] font-medium text-ink-2">Darf</p>
          <ul className="flex flex-col gap-2" data-testid="approve-rights">
            {RIGHTS[role].map(([on, text]) => (
              <li key={text} className={cn('flex items-start gap-2.5 text-[13.5px] leading-snug', on ? 'text-ink' : 'text-ink-3')}>
                {on ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" strokeWidth={2.6} aria-label="ja" /> : <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-4" aria-label="nein" />}
                {text}
              </li>
            ))}
          </ul>
        </div>
        {role === 'assistant' && (
          <div>
            <p id="approve-founders-label" className="mb-2.5 text-[13px] font-medium text-ink-2">
              Arbeitet die Tagesstapel ab von
            </p>
            <FounderChecks labelledBy="approve-founders-label" value={assistantFor} onChange={setAssistantFor} testId="approve-founders" />
            <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-3" data-testid="approve-founders-hint">
              {assistantFor.length > 1
                ? `Beide gewählt: ${account.name} wechselt oben im Cockpit, für wen gerade gearbeitet wird. Gesendet wird immer über den LinkedIn-Account des jeweiligen Gründers.`
                : assistantFor.length === 1
                  ? `Gesendet wird über den LinkedIn-Account von ${founderNames(assistantFor)}. Mehrere möglich.`
                  : 'Mehrere möglich.'}
            </p>
          </div>
        )}
        {role === 'founder' && (
          <div>
            <p id="approve-founder-label" className="mb-2.5 text-[13px] font-medium text-ink-2">
              Welcher Gründer?
            </p>
            <RadioChoice
              labelledBy="approve-founder-label"
              options={AUTH_FOUNDER_IDS.map((value) => ({ value, label: founderName(value) }))}
              value={founder}
              onChange={setFounder}
              testId="approve-founder"
            />
          </div>
        )}
      </div>

      {error && (
        <p key={error.id} role="alert" className="mt-5 flex items-baseline gap-2 text-[14px] leading-snug text-ink" data-testid="approve-error">
          <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
          {error.text}
        </p>
      )}

      <div className="mt-8 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Abbrechen
        </Button>
        <Button type="submit" variant="primary" shortcut={busy ? undefined : '↵'} disabled={busy} aria-busy={busy} data-testid="approve-confirm">
          {busy ? 'Wird freigegeben…' : `Als ${roleLabel} freigeben`}
        </Button>
      </div>
    </form>
  );
}
