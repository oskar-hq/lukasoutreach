import { DelayedStatus } from '../stack/FocusView';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AUTH_ROLES, invitableRoles, type AccountInfo, type AuthRole, type AuthUser, type CreateInviteRequest } from '../../../shared/auth';
import { FOUNDERS } from '../../data/founders';
import { accountsApi } from '../../lib/leadSearchApi';
import { useHotkeys } from '../../lib/useHotkeys';
import { useAccess } from '../../state/auth';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { PageHeader } from '../ui/PageHeader';
import { StatusLine } from '../ui/Status';
import { SectionLabel } from '../ui/SectionLabel';
import { accountError, formatExpiry, roleText } from './accountText';
import { ApproveDialog } from './ApproveDialog';
import { InviteDialog } from './InviteDialog';
import { LinkResult, type CreatedLink } from './LinkResult';

/** Seite „Konten“: Konten sehen, einladen (Link kopieren), Passwort-Link, entfernen. Regeln: `shared/auth.ts`. */
export function AccountsPage() {
  const access = useAccess();
  if (!access.user) {
    return (
      <Notice title="Konten" text="Konten gibt es, sobald das Cockpit mit Anmeldung läuft." />
    );
  }
  if (!access.canManageAccounts) {
    const founder = access.founder ? FOUNDERS[access.founder].name : null;
    return (
      <Notice
        title="Konten"
        text={`Konten verwalten Gründer und Admins.${founder ? ` Braucht jemand Zugang, sag ${founder} Bescheid.` : ''}`}
      />
    );
  }
  return <AccountsManager user={access.user} />;
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <div className="mx-auto max-w-[760px] px-4 pb-24 pt-8 sm:px-6" data-testid="accounts-page">
      <h1 className="display text-[34px] font-semibold sm:text-[40px]">{title}</h1>
      <p className="mt-3 max-w-xl text-[16px] leading-relaxed text-ink-2" data-testid="accounts-not-allowed">
        {text}
      </p>
    </div>
  );
}

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; accounts: AccountInfo[] };

/** Was gerade an einem Konto läuft bzw. schiefging – steht direkt unter dem Eintrag. */
type RowState = { username: string; busy: boolean; error: string | null; errorId: number };

function AccountsManager({ user }: { user: AuthUser }) {
  // Admins und Gründer verwalten alle Konten (Entscheidung 06.10.: nie auf die Shell).
  const managesAll = invitableRoles(user).length > 1;
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<CreatedLink | null>(null);
  const [removing, setRemoving] = useState<AccountInfo | null>(null);
  const [approving, setApproving] = useState<AccountInfo | null>(null);
  const [row, setRow] = useState<RowState | null>(null);
  // Dauerhafter, unsichtbarer Bereich für Ansagen (kopiert, entfernt) – Screenreader lesen ihn zuverlässig.
  const [announcement, setAnnouncement] = useState('');
  const counter = useRef(0);
  const inviteButtonRef = useRef<HTMLButtonElement>(null);
  const loadRun = useRef<AbortController | null>(null);
  /** Knopf, der den Entfernen-Dialog geöffnet hat – bekommt beim Abbrechen den Fokus zurück. */
  const removeTrigger = useRef<HTMLElement | null>(null);

  const reload = useCallback((showLoading = false) => {
    loadRun.current?.abort();
    const controller = new AbortController();
    loadRun.current = controller;
    if (showLoading) setLoad({ status: 'loading' });
    accountsApi
      .list({ signal: controller.signal })
      .then((response) => !controller.signal.aborted && setLoad({ status: 'ready', accounts: response.accounts }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = accountError(error, 'Die Konten ließen sich nicht laden. Ist der Server erreichbar?');
        // Neu laden im Hintergrund (nach Einladen/Entfernen) scheitert: Die bisherige Liste bleibt stehen.
        setLoad((current) => (showLoading || current.status !== 'ready' ? { status: 'error', message } : current));
      });
  }, []);

  useEffect(() => {
    reload(true);
    return () => loadRun.current?.abort();
  }, [reload]);

  // ↵ öffnet „Konto einladen“ – die eine Haupt-Aktion der Seite. Steht ein neuer Link da, gehört ↵ dem Knopf
  // „Link kopieren“ (hat den Fokus, auch nach einem Mausklick).
  useHotkeys({ enter: () => setInviting(true) }, load.status === 'ready' && !inviting && !removing && !approving && !link);

  const showLink = (next: Omit<CreatedLink, 'id'>) => setLink({ ...next, id: ++counter.current });

  /** Neuer Passwort-Link (bestehendes Konto) bzw. neuer Einladungslink (noch nicht eingelöst). */
  const renewLink = async (account: AccountInfo) => {
    if (row?.busy) return;
    setRow({ username: account.username, busy: true, error: null, errorId: 0 });
    const body: CreateInviteRequest = account.pending
      ? {
          username: account.username,
          name: account.name,
          role: account.role,
          ...(managesAll ? { founder: account.founder, ...(account.founders ? { founders: account.founders } : {}) } : {}),
        }
      : { username: account.username, reset: true };
    try {
      const response = await accountsApi.invite(body);
      setRow(null);
      showLink({ token: response.token, username: response.username, name: account.name, expiresAt: response.expiresAt, reset: !account.pending });
      if (account.pending) reload();
    } catch (error) {
      setRow({ username: account.username, busy: false, error: accountError(error, 'Der Link ließ sich nicht erzeugen. Versuch es noch einmal.'), errorId: ++counter.current });
    }
  };

  const afterRemove = (account: AccountInfo) => {
    setRemoving(null);
    if (link?.username === account.username) setLink(null);
    setAnnouncement(
      account.awaitingApproval
        ? `Registrierung von ${account.name} abgelehnt.`
        : account.pending
          ? `Einladung für ${account.name} zurückgezogen.`
          : `Konto von ${account.name} entfernt.`,
    );
    reload();
    // Der Eintrag verschwindet – der Fokus geht zur Haupt-Aktion statt ins Leere.
    requestAnimationFrame(() => inviteButtonRef.current?.focus());
  };

  return (
    <div className="mx-auto max-w-[760px] px-4 pb-24 pt-8 sm:px-6" data-testid="accounts-page">
      <p className="sr-only" aria-live="polite" data-testid="accounts-announcement">
        {announcement}
      </p>
      <PageHeader
        title="Konten"
        action={
          <Button
            ref={inviteButtonRef}
            variant="primary"
            size="lg"
            icon={<Plus className="h-4 w-4" />}
            shortcut="↵"
            onClick={() => setInviting(true)}
            disabled={load.status !== 'ready'}
            data-testid="accounts-invite"
          >
            {managesAll ? 'Konto einladen' : 'Mitarbeiter einladen'}
          </Button>
        }
      />

      {link && (
        <LinkResult
          key={link.id}
          link={link}
          announce={setAnnouncement}
          onDismiss={() => {
            setLink(null);
            inviteButtonRef.current?.focus();
          }}
        />
      )}

      {load.status === 'loading' ? (
        <div className="mt-16" data-testid="accounts-loading">
          {/* Erst nach kurzer Zeit zeigen – wie auf der Startseite, damit bei schneller Antwort nichts aufblitzt. */}
          <DelayedStatus className="text-[14px]">Konten werden geladen …</DelayedStatus>
        </div>
      ) : load.status === 'error' ? (
        <div className="mt-14">
          <p role="alert" className="flex items-baseline gap-2 text-[15px] text-ink" data-testid="accounts-load-error">
            <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
            {load.message}
          </p>
          <Button variant="secondary" className="mt-5" onClick={() => reload(true)} data-testid="accounts-retry">
            Erneut versuchen
          </Button>
        </div>
      ) : (
        <>
        <WaitingList
          accounts={load.accounts.filter((account) => account.awaitingApproval)}
          onApprove={(account) => {
            removeTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setApproving(account);
          }}
          onReject={(account) => {
            removeTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setRemoving(account);
          }}
        />
        <AccountList
          accounts={load.accounts.filter((account) => !account.awaitingApproval)}
          user={user}
          row={row}
          onRenew={(account) => void renewLink(account)}
          onRemove={(account) => {
            removeTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setRemoving(account);
          }}
        />
        </>
      )}

      <ApproveDialog
        account={approving}
        user={user}
        onClose={() => {
          setApproving(null);
          removeTrigger.current?.focus();
        }}
        onApproved={(account) => {
          setApproving(null);
          setAnnouncement(`${account.name} ist freigegeben als ${roleText(account)}.`);
          reload();
          requestAnimationFrame(() => inviteButtonRef.current?.focus());
        }}
      />

      <InviteDialog
        open={inviting}
        user={user}
        onClose={() => {
          setInviting(false);
          inviteButtonRef.current?.focus();
        }}
        onCreated={(response, name) => {
          setInviting(false);
          showLink({ token: response.token, username: response.username, name, expiresAt: response.expiresAt, reset: false });
          reload();
        }}
      />

      <RemoveDialog
        account={removing}
        onCancel={() => {
          setRemoving(null);
          removeTrigger.current?.focus();
        }}
        onRemoved={afterRemove}
      />
    </div>
  );
}

const relativeFormat = new Intl.RelativeTimeFormat('de-DE', { numeric: 'auto' });

/** „vor 4 Minuten“, „gestern“ */
function since(ms: number): string {
  const minutes = Math.round((ms - Date.now()) / 60_000);
  if (minutes > -60) return relativeFormat.format(Math.min(-1, minutes), 'minute');
  const hours = Math.round(minutes / 60);
  if (hours > -24) return relativeFormat.format(hours, 'hour');
  return relativeFormat.format(Math.round(hours / 24), 'day');
}

/** Selbst registrierte Konten, die auf eine Entscheidung warten – oben, damit sie niemand übersieht. */
function WaitingList({ accounts, onApprove, onReject }: { accounts: AccountInfo[]; onApprove: (account: AccountInfo) => void; onReject: (account: AccountInfo) => void }) {
  if (accounts.length === 0) return null;
  return (
    <section className="mt-8" aria-labelledby="accounts-waiting-title" data-testid="accounts-waiting">
      <SectionLabel as="h2" id="accounts-waiting-title">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
        Warten auf Freigabe · {accounts.length}
      </SectionLabel>
      <ul className="mt-3 space-y-1">
        {accounts.map((account) => (
          <li key={account.username} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4" data-testid={`waiting-${account.username}`}>
            <div className="min-w-0 flex-1 basis-[220px]">
              <p className="text-[15px] font-medium text-ink">{account.name}</p>
              <p className="mt-0.5 text-[13px] text-ink-3">
                {account.username}
                {account.registeredAt ? ` · registriert ${since(account.registeredAt)}` : ''}
              </p>
            </div>
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => onReject(account)} data-testid="waiting-reject">
                Ablehnen
              </Button>
              <Button size="md" variant="primary" onClick={() => onApprove(account)} data-testid="waiting-approve">
                Freigeben
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AccountList({
  accounts,
  user,
  row,
  onRenew,
  onRemove,
}: {
  accounts: AccountInfo[];
  user: AuthUser;
  row: RowState | null;
  onRenew: (account: AccountInfo) => void;
  onRemove: (account: AccountInfo) => void;
}) {
  const others = accounts.filter((account) => account.username !== user.username);
  // Eine Liste: nach Rolle (Admin, Gründer, Mitarbeiter), dann nach Name.
  const rank = (role: AuthRole) => AUTH_ROLES.indexOf(role);
  const sorted = [...accounts].sort((a, b) => rank(a.role) - rank(b.role) || a.name.localeCompare(b.name, 'de'));
  return (
    <div data-testid="accounts-list">
      <ul className="mt-8 space-y-1">
        {sorted.map((account) => (
          <AccountRow
            key={account.username}
            account={account}
            own={account.username === user.username}
            row={row?.username === account.username ? row : null}
            onRenew={() => onRenew(account)}
            onRemove={() => onRemove(account)}
          />
        ))}
      </ul>
      {others.length === 0 && (
        <p className="mt-10 text-[14.5px] text-ink-3" data-testid="accounts-empty">
          {invitableRoles(user).length > 1 ? 'Außer dir gibt es noch keine Konten.' : 'Noch keine Mitarbeiter.'}
        </p>
      )}
    </div>
  );
}

function AccountRow({
  account,
  own,
  row,
  onRenew,
  onRemove,
}: {
  account: AccountInfo;
  own: boolean;
  row: RowState | null;
  onRenew: () => void;
  onRemove: () => void;
}) {
  const actions = !own && !account.demo;
  const busy = !!row?.busy;
  return (
    <li className="py-4" data-testid={`account-${account.username}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-[240px]">
          <div className="min-w-0">
            <p className="flex flex-wrap items-baseline gap-x-2 text-[15px] font-medium text-ink">
              <span className="min-w-0 break-words">{account.name}</span>
              {own && <span className="text-[13px] font-normal text-ink-3" data-testid="account-own">du</span>}
            </p>
            <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-[13px] text-ink-2">
              <span className="break-all text-ink-3">{account.username}</span>
              <span className="text-ink-4" aria-hidden>·</span>
              <span data-testid="account-role">{roleText(account)}</span>
              {account.demo && (
                <>
                  <span className="text-ink-4" aria-hidden>·</span>
                  <span className="text-ink-3" data-testid="account-status">
                    Testkonto
                  </span>
                </>
              )}
            </p>
            {account.pending && !account.demo && (
              <StatusLine testId="account-status" className="mt-1 text-[12.5px]">
                {account.inviteExpiresAt && account.inviteExpiresAt > Date.now()
                  ? `Eingeladen · Link gültig bis ${formatExpiry(account.inviteExpiresAt)} Uhr`
                  : 'Eingeladen · Link abgelaufen'}
              </StatusLine>
            )}
          </div>
        </div>
        {actions && (
          <div className="-ml-3 flex min-w-0 flex-wrap gap-1 sm:-mr-3 sm:ml-0 sm:shrink-0">
            <Button size="sm" variant="ghost" onClick={onRenew} disabled={busy} data-testid="account-renew">
              {busy ? 'Wird erzeugt…' : account.pending ? 'Neuen Link erzeugen' : 'Neuer Passwort-Link'}
            </Button>
            <Button size="sm" variant="ghost" onClick={onRemove} disabled={busy} data-testid="account-remove">
              {account.pending ? 'Einladung zurückziehen' : 'Entfernen'}
            </Button>
          </div>
        )}
      </div>
      {row?.error && (
        <p key={row.errorId} role="alert" className="mt-2 flex items-baseline gap-2 text-[13.5px] text-ink" data-testid="account-error">
          <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
          {row.error}
        </p>
      )}
    </li>
  );
}

/** Bestätigung vor dem Entfernen – zerstörerisch, deshalb ein Dialog (Esc bricht ab, ↵ bestätigt). */
function RemoveDialog({
  account,
  onCancel,
  onRemoved,
}: {
  account: AccountInfo | null;
  onCancel: () => void;
  onRemoved: (account: AccountInfo) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; id: number } | null>(null);
  const counter = useRef(0);
  // Beim Ausblenden noch den letzten Inhalt zeigen.
  const shown = useRef(account);
  if (account) shown.current = account;
  const target = shown.current;

  useEffect(() => {
    if (account) setError(null);
  }, [account]);

  const confirm = async () => {
    if (!account || busy) return;
    setBusy(true);
    try {
      await accountsApi.remove(account.username);
      setBusy(false);
      onRemoved(account);
    } catch (caught) {
      setBusy(false);
      setError({ text: accountError(caught, 'Entfernen hat nicht geklappt. Versuch es noch einmal.'), id: ++counter.current });
    }
  };

  return (
    <Modal open={!!account} onClose={() => !busy && onCancel()} labelledBy="remove-dialog-title" className="sm:max-w-[480px]">
      {target && (
        <form
          className="p-6 sm:p-8"
          noValidate
          data-testid="remove-dialog"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void confirm();
          }}
        >
          <h2 id="remove-dialog-title" className="text-[20px] font-semibold tracking-[-0.01em]">
            {target.awaitingApproval
              ? `Registrierung von ${target.name} ablehnen?`
              : target.pending
                ? `Einladung für ${target.name} zurückziehen?`
                : `${target.name} entfernen?`}
          </h2>
          <p className="mt-3 text-[14.5px] leading-relaxed text-ink-2">
            {target.awaitingApproval
              ? 'Die Registrierung wird gelöscht. Wer sich vertan hat, kann sich einfach noch einmal registrieren.'
              : target.pending
                ? 'Der Link gilt dann nicht mehr. Du kannst später jederzeit neu einladen.'
                : `${target.name} wird überall abgemeldet und kann sich nicht mehr anmelden. Offene Links gelten nicht mehr.`}
          </p>
          {error && (
            <p key={error.id} role="alert" className="mt-4 flex items-baseline gap-2 text-[14px] text-ink" data-testid="remove-error">
              <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
              {error.text}
            </p>
          )}
          <div className="mt-7 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              Abbrechen
            </Button>
            <Button type="submit" variant="primary" shortcut={busy ? undefined : '↵'} disabled={busy} autoFocus data-testid="remove-confirm">
              {busy ? 'Wird entfernt…' : target.awaitingApproval ? 'Ablehnen' : target.pending ? 'Zurückziehen' : 'Entfernen'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
