import type { AuthFounderId } from '../../shared/auth';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LinkedInAccountStatus, LinkedInStatusResponse, LinkedInSyncResponse } from '../../shared/linkedin';
import { ApiError, linkedinApi } from '../lib/leadSearchApi';
import { readableError } from '../lib/leadView';
import { useAccess } from './auth';
import { useCockpit } from './cockpit';
import { useDemo } from './demo';

/** Älter als das, dann gleicht das Cockpit beim Öffnen einmal selbst ab (live läuft der Abgleich zusätzlich im Backend). */
const AUTO_SYNC_AFTER_MS = 10 * 60_000;

export type SyncState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: LinkedInSyncResponse }
  | { status: 'error'; message: string };

interface LinkedInContextValue {
  /** null, solange der Status lädt oder das Backend ihn nicht liefert (dann gilt „eintragen“). */
  status: LinkedInStatusResponse | null;
  /** Account des angemeldeten Gründers. */
  account: LinkedInAccountStatus | null;
  /** Gesendet wird über LinkedIn (Simulation oder echt) – sonst trägt das Cockpit nur ein. */
  canSend: boolean;
  sync: SyncState;
  runSync: () => Promise<void>;
  reloadStatus: () => void;
}

const LinkedInContext = createContext<LinkedInContextValue | null>(null);

/** Status der LinkedIn-Aktionen (`GET /api/linkedin/status`) und Abgleich (`POST /api/linkedin/sync`). */
export function LinkedInProvider({ children }: { children: ReactNode }) {
  const { state } = useDemo();
  const access = useAccess();
  const { refresh } = useCockpit();
  const [status, setStatus] = useState<LinkedInStatusResponse | null>(null);
  const [sync, setSync] = useState<SyncState>({ status: 'idle' });
  const requestId = useRef(0);
  const syncing = useRef(false);
  const autoSynced = useRef(false);

  const reloadStatus = useCallback(() => {
    const id = ++requestId.current;
    linkedinApi
      .status()
      .then((next) => {
        if (id === requestId.current) setStatus(next);
      })
      // Kein Status (älteres Backend, offline): Knöpfe bleiben beim ehrlichen „eintragen“ bzw. beim letzten Stand.
      .catch(() => undefined);
  }, []);

  const runSync = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    setSync({ status: 'running' });
    try {
      const result = await linkedinApi.sync();
      setSync({ status: 'done', result });
      if (result.accepted.length || result.replied.length) refresh();
      else reloadStatus();
    } catch (error) {
      setSync({ status: 'error', message: error instanceof ApiError ? readableError(error, 'Der Abgleich hat nicht geklappt.') : 'Der Abgleich hat nicht geklappt.' });
    } finally {
      syncing.current = false;
    }
  }, [refresh, reloadStatus]);

  // Nach jedem Neuladen des Stapels (also auch nach jeder gesendeten Aktion) stimmen die Zähler wieder.
  useEffect(() => reloadStatus(), [reloadStatus, state.stack.fetchedAt]);

  useEffect(() => {
    // Auch beim Eintragen von Hand prüft das Backend angenommene Anfragen, wenn Unipile eingerichtet ist (`watching`).
    if (!status || autoSynced.current || (status.mode === 'off' && !status.watching)) return;
    autoSynced.current = true;
    if (status.lastSyncAt === null || Date.now() - status.lastSyncAt > AUTO_SYNC_AFTER_MS) void runSync();
  }, [status, runSync]);

  const value = useMemo<LinkedInContextValue>(() => {
    const account = status?.accounts.find((entry) => entry.founder === state.founder) ?? null;
    // Admin-Konten tragen nur ein (`canSendOnLinkedIn`), auch wenn der Account des Gründers verbunden ist.
    const canSend = access.canSendOnLinkedIn && !!status && status.mode !== 'off' && !!account?.connected;
    return { status, account, canSend, sync, runSync, reloadStatus };
  }, [status, state.founder, sync, runSync, reloadStatus, access.canSendOnLinkedIn]);

  return <LinkedInContext.Provider value={value}>{children}</LinkedInContext.Provider>;
}

export function useLinkedIn(): LinkedInContextValue {
  const value = useContext(LinkedInContext);
  if (!value) throw new Error('useLinkedIn braucht den LinkedInProvider.');
  return value;
}

export type BlockKind = 'invite' | 'message';

/** Warum gerade nichts über LinkedIn rausgeht – ein Satz, oder null. Das Backend prüft trotzdem selbst. */
export function linkedInBlock(
  status: LinkedInStatusResponse | null,
  account: LinkedInAccountStatus | null,
  kind: BlockKind,
  now = Date.now(),
  /** `TasksResponse.inviteVia`: Geht die nächste Anfrage über den Account des anderen, sperrt das eigene Limit nicht. */
  inviteVia?: AuthFounderId | null,
): string | null {
  if (!status || !account?.connected || status.mode === 'off') return null;
  if (account.pausedUntil && account.pausedUntil > now) {
    const until = new Date(account.pausedUntil).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    return `LinkedIn ist pausiert bis ${until} Uhr.${account.pauseReason ? ` ${account.pauseReason}` : ''}`;
  }
  if (!status.withinWorkHours) return `Gesendet wird nur zu Arbeitszeiten (${workHoursText(status)}).`;
  if (kind === 'invite') {
    if (inviteVia && inviteVia !== account.founder) return null;
    if (account.invitesToday.used >= account.invitesToday.limit) return `Tageslimit für Vernetzungsanfragen erreicht (${account.invitesToday.limit}) – morgen geht es weiter.`;
    if (account.invitesWeek.used >= account.invitesWeek.limit) return `Wochenlimit für Vernetzungsanfragen erreicht (${account.invitesWeek.limit} in 7 Tagen).`;
  } else if (account.messagesToday.used >= account.messagesToday.limit) {
    return `Tageslimit für Nachrichten erreicht (${account.messagesToday.limit}) – morgen geht es weiter.`;
  }
  return null;
}

const DAY_NAMES = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

export function workHoursText(status: LinkedInStatusResponse): string {
  const { fromHour, toHour, days } = status.workHours;
  const sorted = [...days].sort((a, b) => a - b);
  const contiguous = sorted.every((day, index) => index === 0 || day === sorted[index - 1] + 1);
  const dayText =
    sorted.length === 7 ? 'täglich' : contiguous && sorted.length > 2 ? `${DAY_NAMES[sorted[0]]}–${DAY_NAMES[sorted[sorted.length - 1]]}` : sorted.map((day) => DAY_NAMES[day]).join(', ');
  return `${dayText} ${fromHour}–${toHour} Uhr`;
}
