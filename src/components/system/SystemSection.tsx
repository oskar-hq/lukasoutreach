import { Archive, ArrowDownToLine, Copy, KeyRound } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackupInfo, BackupListResponse, SettingsKeyResponse, UpdateStatusResponse } from '../../../shared/system';
import { cn } from '../../lib/cn';
import { ApiError, saveBlob, systemApi } from '../../lib/leadSearchApi';
import { formatDateTime } from '../../lib/time';
import { Button } from '../ui/Button';
import { PasswordDialog } from '../ui/PasswordDialog';
import { Dot } from '../ui/Status';

/** Solange ein Update läuft oder das Cockpit neu startet: so oft nachfragen. */
const POLL_MS = 3_000;
/** Nach so langer Zeit ohne Antwort gilt das Update als hängend (Hinweis, nicht abbrechen). */
const SLOW_UPDATE_MS = 8 * 60_000;

type Tone = 'good' | 'bad' | 'neutral';
type Notice = { tone: Tone; text: string } | null;

/** So viele Sicherungen stehen sofort da, der Rest hinter „Alle … anzeigen“. */
const BACKUPS_SHOWN = 3;

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toLocaleString('de-DE', { maximumFractionDigits: 1 })} GB`;
  return `${(bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
}

/** Wartet, bis das Backend wieder antwortet (nach Update oder Wiederherstellen), dann neu laden. */
function reloadWhenBack(onTick?: () => void) {
  const timer = window.setInterval(() => {
    onTick?.();
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((response) => {
        if (response.status < 500) {
          window.clearInterval(timer);
          window.location.reload();
        }
      })
      .catch(() => undefined);
  }, POLL_MS);
  return () => window.clearInterval(timer);
}

/**
 * Einstellungen → Sicherungen (einfache Seite, Wunsch des Nutzers 23.10.): großer Knopf „Jetzt sichern“, die letzten
 * Sicherungen. Den Schalter „Jede Nacht sichern“ und den Schlüssel für Geheimnisse setzt die Seite darunter.
 */
export function SystemSection({ active }: { active: boolean }) {
  return (
    <div className="pt-8" data-testid="system-section">
      <BackupCard active={active} />
    </div>
  );
}

function StatusLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p role={notice.tone === 'bad' ? 'alert' : 'status'} className="mt-4 flex items-baseline gap-2 text-[14px] text-ink" data-testid="system-notice">
      <span
        className={cn('h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full', notice.tone === 'good' ? 'bg-good' : notice.tone === 'bad' ? 'bg-bad' : 'bg-ink-3')}
        aria-hidden
      />
      {notice.text}
    </p>
  );
}

// ───────────────────────────── Updates ─────────────────────────────

export interface SoftwareUpdate {
  status: UpdateStatusResponse | null;
  loadError: string | null;
  notice: Notice;
  /** Gibt es etwas einzuspielen? */
  hasUpdate: boolean;
  running: boolean;
  checking: boolean;
  starting: boolean;
  check: () => Promise<void>;
  /** Ein Klick, kein Passwort (Wunsch des Nutzers 23.10.). */
  start: () => Promise<void>;
  /** Knopf „Update“: nachsehen, falls nötig, und gleich einspielen. */
  run: () => Promise<void>;
}

/**
 * Stand des Software-Updates für die ganze Einstellungs-Seite: Die erste Ebene zeigt bei einem neuen Update gleich
 * den Knopf, die Seite „Software-Update“ denselben Stand. Lädt einmal beim Öffnen; solange ein Update läuft, fragt
 * er nach und lädt die Seite nach dem Neustart neu.
 */
export function useSoftwareUpdate(): SoftwareUpdate {
  const [status, setStatus] = useState<UpdateStatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [starting, setStarting] = useState(false);
  /** In diesem Tab gestartet: Nach dem Neustart lädt die Seite selbst neu. */
  const startedAt = useRef<number | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    let alive = true;
    systemApi
      .update()
      .then((next) => alive && setStatus(next))
      .catch((error: unknown) => alive && setLoadError(errorText(error, 'Update-Stand ließ sich nicht laden.')));
    return () => {
      alive = false;
    };
  }, []);

  // Solange es läuft: nachfragen. Antwortet das Backend nicht mehr, startet es gerade neu.
  const running = status?.state === 'running' || startedAt.current !== null;
  useEffect(() => {
    if (!running || restarting) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await systemApi.update();
        setStatus(next);
        if (startedAt.current === null) return;
        // Fertig nur, wenn das Backend einen abgeschlossenen Lauf meldet, der nach unserem Start begann – ein kurz
        // nicht erreichbarer Update-Dienst (unter Last) ist kein „fertig“.
        const finished = next.lastRun && next.lastRun.finishedAt !== null && next.lastRun.startedAt >= startedAt.current - 60_000;
        if (next.state === 'done' && finished && next.lastRun?.ok !== false) {
          startedAt.current = null;
          setNotice({ tone: 'good', text: 'Fertig – die Seite lädt neu.' });
          // Neue Oberfläche laden (das Frontend wurde mit neu gebaut).
          window.setTimeout(() => window.location.reload(), 1500);
        } else if (next.state === 'failed' || (finished && next.lastRun?.ok === false)) {
          startedAt.current = null;
          setNotice({ tone: 'bad', text: next.lastRun?.message ?? 'Das Update hat nicht geklappt.' });
        } else if (Date.now() - startedAt.current > SLOW_UPDATE_MS) {
          setNotice({ tone: 'neutral', text: 'Das dauert ungewöhnlich lange. Lade die Seite in ein paar Minuten neu.' });
        }
      } catch {
        // Backend weg = wird gerade neu gestartet. Warten, bis es wieder da ist, dann neu laden.
        if (startedAt.current !== null) {
          setRestarting(true);
          setNotice({ tone: 'neutral', text: 'Das Cockpit startet neu – die Seite lädt gleich von selbst.' });
        }
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, restarting]);

  useEffect(() => {
    if (!restarting) return;
    return reloadWhenBack();
  }, [restarting]);

  const check = useCallback(async () => {
    setChecking(true);
    setNotice(null);
    try {
      setStatus(await systemApi.checkUpdate());
    } catch (error) {
      setNotice({ tone: 'bad', text: errorText(error, 'Nachsehen hat nicht geklappt.') });
    } finally {
      setChecking(false);
    }
  }, []);

  const start = useCallback(async () => {
    setStarting(true);
    setNotice(null);
    try {
      const next = await systemApi.startUpdate();
      startedAt.current = Date.now();
      setStatus(next);
      setNotice({ tone: 'neutral', text: 'Update läuft – das Cockpit ist ein paar Minuten weg und lädt dann neu.' });
    } catch (error) {
      setNotice({ tone: 'bad', text: errorText(error, 'Das Update ließ sich nicht starten.') });
    } finally {
      setStarting(false);
    }
  }, []);

  const hasUpdate = !!status?.available && (status.behind > 0 || !!status.pendingBuild);

  /** Der eine Knopf: Ist schon bekannt, dass es etwas Neues gibt, sofort einspielen – sonst erst nachsehen. */
  const run = useCallback(async () => {
    if (hasUpdate) return start();
    setChecking(true);
    setNotice(null);
    try {
      const next = await systemApi.checkUpdate();
      setStatus(next);
      if (next.available && (next.behind > 0 || next.pendingBuild)) {
        setChecking(false);
        await start();
      }
    } catch (error) {
      setNotice({ tone: 'bad', text: errorText(error, 'Nachsehen hat nicht geklappt.') });
    } finally {
      setChecking(false);
    }
  }, [hasUpdate, start]);

  return { status, loadError, notice, hasUpdate, running, checking, starting, check, start, run };
}

/** Der eine Knopf: „Update“ – startet sofort. */
export function UpdateButton({ update, size = 'lg', testId = 'update-start' }: { update: SoftwareUpdate; size?: 'sm' | 'lg'; testId?: string }) {
  const busy = update.running || update.starting;
  return (
    <Button
      variant="primary"
      size={size}
      icon={<ArrowDownToLine className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />}
      disabled={busy || update.checking}
      onClick={() => void update.run()}
      data-testid={testId}
    >
      {busy ? 'Update läuft …' : update.checking ? 'Wird geprüft …' : 'Update'}
    </Button>
  );
}

/**
 * Einstellungen → Software-Update (Wunsch des Nutzers 23.10.): ein Satz, der große Knopf „Update“, die Version als
 * Nummer (für Screenshots) – mehr nicht. Den Schalter „Jede Nacht automatisch updaten“ setzt die Seite darunter.
 */
export function UpdatePage({ update }: { update: SoftwareUpdate }) {
  const { status, loadError, hasUpdate, running } = update;

  return (
    <section className="pt-8" aria-label="Software-Update" data-testid="system-update">
      {loadError && !status ? (
        <p className="text-[15px] text-ink-2">{loadError}</p>
      ) : !status ? (
        <p className="text-[15px] text-ink-3">Wird geladen …</p>
      ) : !status.available ? (
        <p className="text-[15px] leading-relaxed text-ink-2" data-testid="update-unavailable">
          {status.reason ?? 'Der Update-Dienst ist nicht erreichbar.'}
        </p>
      ) : (
        <>
          <p className="text-[22px] font-bold leading-tight tracking-[-0.02em] text-ink" data-testid={hasUpdate ? 'update-available' : 'update-current-state'}>
            {running ? 'Update läuft …' : hasUpdate ? 'Neue Version da.' : 'Du hast die neueste Version.'}
          </p>
          <div className="mt-6">
            <UpdateButton update={update} />
          </div>
        </>
      )}
      <StatusLine notice={update.notice} />
      {status?.current && (
        <p className="mt-10 flex items-baseline justify-between gap-6 text-[16px]">
          <span className="font-semibold text-ink">Version</span>
          <span className="font-mono tabular-nums text-ink-2" data-testid="update-current">
            {status.current.commit}
          </span>
        </p>
      )}
    </section>
  );
}

// ───────────────────────────── Sicherungen ─────────────────────────────

type BackupDialog = { kind: 'download' | 'restore'; backup: BackupInfo; error: { text: string; id: number } | null };

function BackupCard({ active }: { active: boolean }) {
  const [list, setList] = useState<BackupListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<BackupDialog | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [restarting, setRestarting] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await systemApi.backups());
      setLoadError(null);
    } catch (error) {
      setLoadError(errorText(error, 'Sicherungen ließen sich nicht laden.'));
    }
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  useEffect(() => {
    if (!restarting) return;
    return reloadWhenBack();
  }, [restarting]);

  const createNow = async () => {
    setCreating(true);
    setNotice(null);
    try {
      await systemApi.backupNow();
      // Die große Zeile oben („Zuletzt gesichert: …“) sagt es schon.
      setNotice(null);
      await load();
    } catch (error) {
      setNotice({ tone: 'bad', text: errorText(error, 'Sichern hat nicht geklappt.') });
    } finally {
      setCreating(false);
    }
  };

  const confirm = async (password: string) => {
    if (!dialog) return;
    setBusy(true);
    try {
      if (dialog.kind === 'download') {
        saveBlob(await systemApi.downloadBackup(dialog.backup.name, password), dialog.backup.name);
        setNotice({ tone: 'good', text: `${dialog.backup.name} wird heruntergeladen.` });
      } else {
        const result = await systemApi.restoreBackup(dialog.backup.name, password);
        setNotice({ tone: 'neutral', text: result.message });
        // Simulation: nichts ersetzt, kein Neustart. Sonst warten, bis das Backend wieder da ist.
        if (result.safetyBackup !== null) setRestarting(true);
        else void load();
      }
      setDialog(null);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'reauth_failed') {
        setDialog({ ...dialog, error: { text: error.message, id: Date.now() } });
      } else {
        setDialog(null);
        setNotice({ tone: 'bad', text: errorText(error, 'Das hat nicht geklappt.') });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Sicherungen" data-testid="system-backups">
      {loadError && !list ? (
        <p className="text-[15px] text-ink-2">{loadError}</p>
      ) : !list ? (
        <p className="text-[15px] text-ink-3">Wird geladen …</p>
      ) : (
        <p className="text-[22px] font-bold leading-tight tracking-[-0.02em] text-ink" aria-live="polite" data-testid="backup-state">
          {list.backups.length ? `Zuletzt gesichert: ${formatDateTime(list.backups[0].createdAt)}` : 'Noch keine Sicherung.'}
        </p>
      )}
      <div className="mt-6">
        <Button variant="primary" size="lg" icon={<Archive className="h-4 w-4" />} disabled={creating || restarting} onClick={() => void createNow()} data-testid="backup-now">
          {creating ? 'Wird gesichert …' : 'Jetzt sichern'}
        </Button>
      </div>
      <StatusLine notice={notice} />

      {/* Nur was man wissen muss: Fehler und knapper Speicher. */}
      {list?.lastError && (
        <p role="alert" className="mt-4 flex items-baseline gap-2 text-[14px] text-ink">
          <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
          {list.lastError}
        </p>
      )}
      {list?.disk?.low && (
        <p className="mt-4 text-[14px] text-ink" data-testid="backup-disk">
          <Dot tone="warn" className="mr-2 -translate-y-px" />
          Wenig Platz auf dem Server: {formatSize(list.disk.freeBytes)} frei.
        </p>
      )}

      {list && list.backups.length > 0 && (
        <>
          <ul id="backup-list" className="mt-10" data-testid="backup-list">
            {(showAll ? list.backups : list.backups.slice(0, BACKUPS_SHOWN)).map((backup) => (
              <li key={backup.name} className="flex min-h-[48px] items-center justify-between gap-4" data-testid="backup-row">
                <span className="text-[16px] font-semibold tabular-nums text-ink">{formatDateTime(backup.createdAt)}</span>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Sicherung vom ${formatDateTime(backup.createdAt)} herunterladen`}
                    disabled={restarting}
                    onClick={() => setDialog({ kind: 'download', backup, error: null })}
                  >
                    Laden
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Sicherung vom ${formatDateTime(backup.createdAt)} wiederherstellen`}
                    disabled={restarting}
                    onClick={() => setDialog({ kind: 'restore', backup, error: null })}
                  >
                    Wiederherstellen
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {list.backups.length > BACKUPS_SHOWN && (
            <Button
              size="sm"
              variant="ghost"
              className="-ml-3 mt-1"
              aria-expanded={showAll}
              aria-controls="backup-list"
              onClick={() => setShowAll((value) => !value)}
              data-testid="backup-show-all"
            >
              {showAll ? 'Weniger anzeigen' : `Alle ${list.backups.length} anzeigen`}
            </Button>
          )}
        </>
      )}

      <PasswordDialog
        open={!!dialog}
        title={dialog?.kind === 'restore' ? 'Sicherung wiederherstellen' : 'Sicherung herunterladen'}
        confirmLabel={dialog?.kind === 'restore' ? 'Wiederherstellen' : 'Herunterladen'}
        busyLabel={dialog?.kind === 'restore' ? 'Wird eingespielt…' : 'Wird geladen…'}
        busy={busy}
        error={dialog?.error ?? null}
        onCancel={() => setDialog(null)}
        onConfirm={(password) => void confirm(password)}
      >
        {dialog?.kind === 'restore' ? (
          <>
            <p>
              Das Cockpit springt auf den Stand vom <strong className="font-medium text-ink">{formatDateTime(dialog.backup.createdAt)}</strong> zurück.
              Alles, was danach eingetragen wurde, ist dann weg.
            </p>
            <p>Der jetzige Stand wird vorher gesichert – du kannst also zurück. Das Cockpit startet dabei kurz neu.</p>
          </>
        ) : (
          <p>Die Datei enthält alle Leads und Konten (Passwörter nur verschlüsselt). Speichere sie nur an einem sicheren Ort.</p>
        )}
      </PasswordDialog>
    </section>
  );
}

// ───────────────────────────── Schlüssel für Geheimnisse ─────────────────────────────

/**
 * Die Geheimnisse der Einstellungen (API-Schlüssel) liegen verschlüsselt in der Datenbank – und damit in jeder
 * Sicherung. Den Schlüssel dazu enthält keine Sicherung: Er gehört getrennt in den Passwort-Manager.
 */
export function SecretKeyCard() {
  const [dialog, setDialog] = useState<{ error: { text: string; id: number } | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SettingsKeyResponse | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const show = async (password: string) => {
    setBusy(true);
    try {
      setResult(await systemApi.settingsKey(password));
      setNotice(null);
      setDialog(null);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'reauth_failed') {
        setDialog({ error: { text: error.message, id: Date.now() } });
      } else {
        setDialog(null);
        setNotice({ tone: 'bad', text: errorText(error, 'Der Schlüssel ließ sich nicht anzeigen.') });
      }
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!result?.key) return;
    try {
      await navigator.clipboard.writeText(result.key);
      setNotice({ tone: 'good', text: 'Schlüssel kopiert – jetzt im Passwort-Manager ablegen.' });
    } catch {
      setNotice({ tone: 'neutral', text: 'Kopieren ging nicht – markier den Schlüssel und kopier ihn von Hand.' });
    }
  };

  return (
    <section className="pb-10 pt-7" aria-labelledby="system-key-title" data-testid="system-key">
      <div className="flex min-h-[44px] items-center justify-between gap-6">
        <h2 id="system-key-title" className="text-[16px] font-semibold tracking-[-0.01em] text-ink">
          Schlüssel für Geheimnisse
        </h2>
        {result ? (
          <Button size="sm" variant="ghost" onClick={() => setResult(null)} data-testid="settings-key-hide">
            Ausblenden
          </Button>
        ) : (
          <Button size="sm" variant="secondary" icon={<KeyRound className="h-3.5 w-3.5" />} onClick={() => setDialog({ error: null })} data-testid="settings-key-show">
            Anzeigen
          </Button>
        )}
      </div>
      {result && (
        <div className="mt-4" data-testid="settings-key-result">
          <p className="text-[14px] text-ink">{result.message}</p>
          {result.key && (
            <div className="mt-3 flex items-center gap-2">
              <code className="min-w-0 flex-1 select-all break-all rounded-xl border border-transparent bg-surface-3 px-3 py-2.5 font-mono text-[13px] text-ink" data-testid="settings-key-value">
                {result.key}
              </code>
              <Button size="sm" variant="ghost" className="w-8 shrink-0 px-0" icon={<Copy className="h-3.5 w-3.5" />} aria-label="Schlüssel kopieren" onClick={() => void copy()} />
            </div>
          )}
        </div>
      )}
      <StatusLine notice={notice} />

      <PasswordDialog
        open={!!dialog}
        title="Schlüssel für Geheimnisse anzeigen"
        confirmLabel="Anzeigen"
        busyLabel="Wird geladen…"
        busy={busy}
        error={dialog?.error ?? null}
        onCancel={() => setDialog(null)}
        onConfirm={(password) => void show(password)}
      >
        <p>Mit diesem Schlüssel lassen sich alle gespeicherten API-Schlüssel entschlüsseln. Zeig ihn nur an, wenn niemand mitliest.</p>
      </PasswordDialog>
    </section>
  );
}
