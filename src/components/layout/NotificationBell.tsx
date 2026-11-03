import { AnimatePresence, motion } from 'motion/react';
import { Bell, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AUTH_FOUNDER_IDS, workingFounders } from '../../../shared/auth';
import { joinNames, type AppNotification, type NotificationListResponse, type NotificationSeverity } from '../../../shared/notifications';
import { FOUNDERS } from '../../data/founders';
import { cn } from '../../lib/cn';
import { notificationsApi } from '../../lib/leadSearchApi';
import { SPRING_MENU } from '../../lib/motion';
import { formatRelative } from '../../lib/time';
import { useAccess, useAuth } from '../../state/auth';
import { useDemo } from '../../state/demo';
import { openSettingsTab } from '../settings/SettingsPage';
import type { SettingsSection } from '../settings/settingsNav';
import { Dot, type Tone } from '../ui/Status';

/** So oft fragt das Cockpit nach Neuigkeiten (zusätzlich beim Zurückkehren in den Tab). */
const POLL_MS = 60_000;

const TONE: Record<NotificationSeverity, Tone> = { error: 'bad', warning: 'warn', info: 'accent' };
const RANK: Record<NotificationSeverity, number> = { error: 3, warning: 2, info: 1 };

/** Neuigkeiten laden: beim Start, jede Minute und beim Zurückkehren in den Tab. Fehler (offline, älteres Backend) still. */
function useNotifications(enabled: boolean) {
  const [data, setData] = useState<NotificationListResponse | null>(null);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    notificationsApi
      .list({ signal: current.signal })
      .then((response) => !current.signal.aborted && setData(response))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!enabled) {
      setData(null);
      return;
    }
    load();
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(onVisible, POLL_MS);
    return () => {
      controller.current?.abort();
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [enabled, load]);
  const markSeen = useCallback(() => {
    controller.current?.abort();
    notificationsApi
      .seen()
      .then(setData)
      .catch(() => {});
  }, []);
  return { data, load, markSeen };
}

/**
 * Glocke oben rechts neben dem Konto (Wunsch des Nutzers 08.10.): Meldungen des Programms – Registrierungen,
 * abgebrochene Suchläufe, LinkedIn-Pausen, Sicherung und Update. Keine Chats. Punkt nur, wenn etwas Neues da ist
 * (Farbe nach dem Wichtigsten). Beim Öffnen gilt alles als gesehen; in der offenen Liste bleiben die neuen markiert.
 */
export function NotificationBell() {
  const { auth } = useAuth();
  const access = useAccess();
  const { state, dispatch } = useDemo();
  const user = auth.status === 'authenticated' ? auth.user : null;
  const { data, load, markSeen } = useNotifications(!!user && !user.awaitingApproval);
  const [open, setOpen] = useState(false);
  // Was beim Öffnen neu war – bleibt markiert, auch nachdem es als gesehen gilt.
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const unread = data?.notifications.filter((item) => item.unread) ?? [];
  const top = unread.reduce<NotificationSeverity | null>((best, item) => (!best || RANK[item.severity] > RANK[best] ? item.severity : best), null);

  // Ansicht gewechselt (z. B. Registrierung freigegeben) → gleich neu laden statt bis zur nächsten Minute zu warten.
  useEffect(() => {
    if (user) load();
  }, [state.view]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user || user.awaitingApproval) return null;

  const toggle = () => {
    if (!open) {
      setFreshIds(new Set(unread.map((item) => item.id)));
      if (unread.length > 0) markSeen();
    }
    setOpen(!open);
  };

  /** Für Mitarbeiter: wem sie Bescheid sagen sollen – der betroffene Gründer, sonst alle Gründer mit Konto. */
  const tellWhom = (item: AppNotification): string => {
    if (item.founder) return FOUNDERS[item.founder].name;
    const known = AUTH_FOUNDER_IDS.filter((id) => user.founderNames?.[id]);
    const ids = known.length ? known : workingFounders(user);
    return joinNames(ids.map((id) => FOUNDERS[id].name));
  };

  /** Wohin ein Klick führt – nur, wenn das Konto die Seite sehen darf. */
  const reachable = (item: AppNotification): boolean => {
    if (!item.target) return false;
    if (item.target.view === 'settings') return access.canEditSettings;
    if (item.target.view === 'accounts') return access.canManageAccounts;
    return true;
  };

  const follow = (item: AppNotification) => {
    if (!item.target || !reachable(item)) return;
    if (item.target.view === 'settings') openSettingsTab((item.target.section as SettingsSection | undefined) ?? 'overview');
    setOpen(false);
    dispatch({ type: 'SET_VIEW', view: item.target.view });
  };

  const items = data?.notifications ?? [];
  const label = unread.length > 0 ? `Neuigkeiten · ${unread.length} neu` : 'Neuigkeiten';

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Neuigkeiten"
        data-testid="notifications-bell"
        className={cn('relative flex h-9 w-9 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink', open && 'bg-white/[0.09] text-ink')}
      >
        <Bell className="h-[18px] w-[18px]" />
        {top && (
          <span
            data-testid="notifications-dot"
            data-tone={TONE[top]}
            aria-hidden
            className={cn(
              'absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full border-2 border-canvas',
              top === 'error' ? 'bg-bad' : top === 'warning' ? 'bg-warn' : 'bg-accent',
            )}
          />
        )}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Neuigkeiten"
            data-testid="notifications-panel"
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -4, transition: { duration: 0.12 } }}
            transition={SPRING_MENU}
            style={{ transformOrigin: 'top right' }}
            className="fixed inset-x-4 top-[calc(var(--safe-top)+56px)] z-40 overflow-hidden rounded-[14px] border border-line bg-surface-2 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.85)] sm:absolute sm:inset-x-auto sm:right-0 sm:top-11 sm:w-[380px]"
          >
            <div className="border-b border-line px-4 py-3">
              <p className="text-[14px] font-semibold">Neuigkeiten</p>
            </div>
            {items.length === 0 ? (
              <p className="px-4 py-6 text-[13.5px] leading-relaxed text-ink-2" data-testid="notifications-empty">
                Alles läuft. Hier erscheint, was jemand wissen oder beheben muss – etwa neue Registrierungen oder Fehler der
                automatischen Suche.
              </p>
            ) : (
              <ul className="max-h-[min(480px,calc(100dvh-120px-var(--safe-top)-var(--nav-bottom)))] overflow-y-auto overscroll-contain">
                {items.map((item) => {
                  const clickable = reachable(item);
                  const fresh = freshIds.has(item.id);
                  const body = (
                    <>
                      <Dot tone={TONE[item.severity]} className="mt-[7px]" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14px] font-medium leading-snug text-ink">{item.title}</span>
                        <span className="mt-1 block text-[13px] leading-relaxed text-ink-2">{item.text}</span>
                        {item.needsFounder && access.role === 'assistant' && (
                          <span className="mt-1.5 block text-[13px] leading-relaxed text-ink" data-testid="notification-tell">
                            Sag {tellWhom(item)} Bescheid – beheben können das nur Gründer.
                          </span>
                        )}
                        <span className="mt-1.5 flex items-center gap-1.5 text-[12px] text-ink-3">
                          {fresh && <span className="font-medium text-accent">Neu</span>}
                          {fresh && <span aria-hidden>·</span>}
                          <span>{formatRelative(item.updatedAt)}</span>
                          {item.count > 1 && (
                            <>
                              <span aria-hidden>·</span>
                              <span>{item.count}× seit {formatRelative(item.createdAt)}</span>
                            </>
                          )}
                        </span>
                      </span>
                      {clickable && <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />}
                    </>
                  );
                  return (
                    <li key={item.id} data-testid="notification-item" data-kind={item.kind}>
                      {clickable ? (
                        <button
                          type="button"
                          onClick={() => follow(item)}
                          className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.05]"
                        >
                          {body}
                        </button>
                      ) : (
                        <div className="flex items-start gap-3 px-4 py-3">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
