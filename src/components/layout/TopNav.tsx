import { AnimatePresence, motion } from 'motion/react';
import { BarChart3, Layers, LogOut, MessagesSquare, Settings, UserCog, UserSearch, Users } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FOUNDERS } from '../../data/founders';
import { useWaitingRegistrations } from '../accounts/useWaitingRegistrations';
import { cn } from '../../lib/cn';
import { useIsPhone } from '../../lib/useMediaQuery';
import { useScrolled } from '../../lib/useScrolled';
import { useAccess, useAuth } from '../../state/auth';
import { useCockpit } from '../../state/cockpit';
import { pendingCards, pendingHandoffCount, useDemo } from '../../state/demo';
import type { FounderId, View } from '../../state/types';
import { useLeadSearch } from '../leadSearch/LeadSearchProvider';
import { LogoMark } from './Logo';
import { NotificationBell } from './NotificationBell';
import { SPRING_MENU } from '../../lib/motion';

type NavItem = { view: View; label: string; icon: ReactNode; badge?: number; live?: boolean; warn?: boolean };

/** Titel der Ansichten ohne eigenen Tab (Handy-Kopfleiste). */
const EXTRA_TITLES: Partial<Record<View, string>> = { settings: 'Einstellungen', accounts: 'Konten', assistant: 'KI fragen' };

/**
 * Höchstens fünf Hauptansichten (DESIGN.md, Wunsch des Nutzers 25.10. „weniger Auswahl“): Die KI steht als Reiter
 * „KI fragen“ im Dashboard – solange sie offen ist, ist „Dashboard“ markiert.
 */
const isActive = (item: NavItem, view: View) => view === item.view || (item.view === 'dashboard' && view === 'assistant');

function useNavItems(iconClass: string): NavItem[] {
  const { state } = useDemo();
  const founder = FOUNDERS[state.founder as FounderId];
  // Eine gerade übergebene, noch nicht gespeicherte Übergabe zählt schon mit.
  const open = pendingCards(state, founder.id).length + pendingHandoffCount(state);
  const { config } = useLeadSearch();
  const searching = state.leadSearch.run?.status === 'running';
  // Abweichung markieren, nicht den Normalfall: Punkt nur, wenn die Lead-Suche nicht starten kann.
  const notReady = config.status === 'ready' && config.config.mode === 'live' && !config.config.ready;
  return [
    { view: 'home', label: 'Aufgaben', icon: <Layers className={iconClass} />, badge: open },
    { view: 'search', label: 'Lead-Suche', icon: <UserSearch className={iconClass} />, live: searching, warn: notReady && !searching },
    { view: 'leads', label: 'Leads', icon: <Users className={iconClass} /> },
    { view: 'chats', label: 'Chats', icon: <MessagesSquare className={iconClass} />, badge: state.stack.order.filter((id) => state.stack.tasks[id]?.type === 'reply' && !state.stack.outcomes[id]).length },
    { view: 'dashboard', label: 'Dashboard', icon: <BarChart3 className={iconClass} /> },
  ];
}

export function TopNav() {
  // Handy (wie eine iOS-App): schmale Kopfleiste oben, Tab-Leiste unten. Nur eine der beiden Navigationen wird
  // gerendert – sonst gäbe es jeden Knopf (und jede Test-ID) doppelt.
  return useIsPhone() ? <PhoneNav /> : <DesktopNav />;
}

function DesktopNav() {
  const { state, dispatch } = useDemo();
  const founder = FOUNDERS[state.founder as FounderId];
  const scrolled = useScrolled();
  const items = useNavItems('h-4 w-4');

  return (
    <header
      data-testid="top-nav"
      className={cn('glass sticky top-[var(--safe-top)] z-30 border-b transition-colors duration-300', scrolled ? 'border-line' : 'border-transparent')}
    >
      <div className="mx-auto flex h-[72px] max-w-[1240px] items-center gap-6 px-10 max-md:px-6">
        <button
          type="button"
          onClick={() => dispatch({ type: 'SET_VIEW', view: 'home' })}
          className="flex text-ink"
          aria-label="Zu den Aufgaben"
        >
          <LogoMark size={22} />
        </button>

        <nav className="ml-auto flex min-w-0 items-center gap-6 max-md:gap-4" aria-label="Hauptnavigation">
          {items.map((item) => {
            const active = isActive(item, state.view);
            return (
              <button
                key={item.view}
                type="button"
                onClick={(event) => {
                  dispatch({ type: 'SET_VIEW', view: item.view });
                  // Nach einem Mausklick den Fokus abgeben – sonst bleibt der Fokusring stehen, wenn danach ↵ gedrückt wird.
                  if (event.detail > 0) event.currentTarget.blur();
                }}
                aria-current={active ? 'page' : undefined}
                title={item.warn ? 'Lead-Suche ist noch nicht startklar' : undefined}
                className={cn(
                  'relative flex h-9 items-center gap-2 whitespace-nowrap text-[14px] font-semibold transition-colors',
                  active ? 'text-ink' : 'text-ink-2 hover:text-ink',
                )}
              >
                <span className="relative flex items-center gap-1.5" data-testid={`nav-${item.view}`}>
                  {/* Tablet (sm bis md) nur das Symbol (Name für Screenreader), ab md nur der Text. */}
                  <span className="md:hidden">{item.icon}</span>
                  <span className="sr-only md:not-sr-only">{item.label}</span>
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className="min-w-[18px] rounded-full bg-surface-3 px-1.5 text-center text-[11px] font-semibold tabular-nums text-ink-2">
                      {item.badge}
                    </span>
                  )}
                  <ItemMarks item={item} />
                </span>
              </button>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          <NotificationBell />
          <UserMenu founderId={founder.id} />
        </div>
      </div>
    </header>
  );
}

/** Punkt „Suche läuft“ bzw. „nicht startklar“. */
function ItemMarks({ item, className }: { item: NavItem; className?: string }) {
  if (item.live) {
    return (
      <>
        <span className={cn('h-[5px] w-[5px] animate-pulse rounded-full bg-accent motion-reduce:animate-none', className)} aria-hidden />
        <span className="sr-only">Suche läuft</span>
      </>
    );
  }
  if (item.warn) {
    return (
      <>
        <span className={cn('h-[5px] w-[5px] rounded-full bg-warn', className)} aria-hidden />
        <span className="sr-only">nicht startklar</span>
      </>
    );
  }
  return null;
}

/**
 * Handy: Kopfleiste mit Logo, Glocke und Konto; der Titel der Ansicht blendet erst ein, wenn die große Überschrift
 * darunter weggescrollt ist (wie „Large Title“ unter iOS). Die Ansichten selbst wechselt die Tab-Leiste unten.
 */
function PhoneNav() {
  const { state, dispatch } = useDemo();
  const founder = FOUNDERS[state.founder as FounderId];
  const scrolled = useScrolled(44);
  const items = useNavItems('h-[23px] w-[23px]');
  const title = EXTRA_TITLES[state.view] ?? items.find((item) => item.view === state.view)?.label ?? '';

  return (
    <>
      <header
        data-testid="top-nav"
        className={cn('glass sticky top-[var(--safe-top)] z-30 border-b transition-colors duration-300', scrolled ? 'border-line' : 'border-transparent')}
      >
        <div className="grid h-[52px] grid-cols-[1fr_auto_1fr] items-center gap-2 px-4">
          <button
            type="button"
            onClick={() => dispatch({ type: 'SET_VIEW', view: 'home' })}
            className="flex justify-self-start text-ink"
            aria-label="Zu den Aufgaben"
          >
            <LogoMark size={22} />
          </button>
          <p
            aria-hidden
            className={cn('truncate text-[16px] font-semibold tracking-[-0.01em] transition-opacity duration-200', scrolled ? 'opacity-100' : 'opacity-0')}
          >
            {title}
          </p>
          <div className="flex items-center gap-1 justify-self-end">
            <NotificationBell />
            <UserMenu founderId={founder.id} />
          </div>
        </div>
      </header>
      <TabBar items={items} />
    </>
  );
}

/** Tab-Leiste unten (Handy): Symbol über Name, aktive Ansicht weiß; erneutes Tippen scrollt nach oben (wie iOS). */
function TabBar({ items }: { items: NavItem[] }) {
  const { state, dispatch } = useDemo();
  return (
    <nav
      aria-label="Hauptnavigation"
      data-testid="tab-bar"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-canvas/90 pb-[var(--safe-bottom)] pl-[var(--safe-left)] pr-[var(--safe-right)] backdrop-blur-xl backdrop-saturate-150 reduced-transparency:bg-canvas reduced-transparency:backdrop-blur-none"
    >
      {/* Spalten nach Zahl der Tabs (fünf; die KI steht seit 25.10. im Dashboard). */}
      <div className="grid h-[var(--tab-bar-h)]" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((item) => {
          const active = isActive(item, state.view);
          return (
            <button
              key={item.view}
              type="button"
              onClick={() => {
                // „Dashboard“ aus „KI fragen“ heraus führt zurück ins Dashboard, sonst scrollt der aktive Tab nach oben.
                if (state.view === item.view) window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
                else dispatch({ type: 'SET_VIEW', view: item.view });
              }}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex select-none flex-col items-center justify-center gap-[3px] pt-1 transition-colors',
                active ? 'text-ink' : 'text-ink-3',
              )}
            >
              <span className="relative flex flex-col items-center gap-[3px]" data-testid={`nav-${item.view}`}>
                <span className="relative">
                  {item.icon}
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className="absolute -right-2.5 -top-1.5 min-w-[17px] rounded-full bg-accent px-1 text-center text-[10.5px] font-semibold leading-[17px] tabular-nums text-white">
                      {item.badge}
                    </span>
                  )}
                  <ItemMarks item={item} className="absolute -right-1.5 top-0" />
                </span>
                <span className="text-[10.5px] font-medium leading-none tracking-[0.01em]">{item.label}</span>
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function UserMenu({ founderId }: { founderId: FounderId }) {
  const { state, dispatch } = useDemo();
  const { auth, logout } = useAuth();
  const access = useAccess();
  const { prepareSignOut, discardPending } = useCockpit();
  const [unsaved, setUnsaved] = useState(0);
  const founder = FOUNDERS[founderId];
  const user = auth.status === 'authenticated' ? auth.user : null;
  const { setAdminFounder } = useAuth();
  // Neue Registrierungen: Zahl im Konto-Menü, bis jemand entscheidet (neu geladen beim Wechsel der Ansicht). Der Hinweis
  // selbst steht an der Glocke (Neuigkeiten). Auf der Seite „Konten“ nicht – dort steht die Liste ohnehin.
  const waiting = useWaitingRegistrations(!!user && access.canManageAccounts && state.view !== 'accounts', state.view);
  // Angezeigt wird das eigene Konto – bei Admin und Mitarbeiter ist das nicht der Gründer, dessen Aufgaben offen sind.
  const ownFounder = !user || (access.role === 'founder' && user.founder === founderId);
  const displayName = user?.name ?? founder.name;
  const displayInitials = ownFounder ? founder.initials : initialsOf(displayName);
  const workingFor =
    access.role === 'admin'
      ? 'Trägt nur ein – gesendet wird auf LinkedIn'
      : access.role === 'assistant'
        ? `Mitarbeiter · sendet für ${founder.name}`
        : null;
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  /**
   * Admin wechselt den Gründer: Wie beim Abmelden erst alle offenen Entscheidungen speichern – danach gehört der
   * Stapel einem anderen Gründer, Rückgängig und Fehlermeldungen der alten Karten gäbe es nicht mehr.
   */
  const switchFounder = async (id: FounderId) => {
    if (id === founderId || loggingOut) return;
    setLoggingOut(true);
    const waiting = await prepareSignOut();
    setLoggingOut(false);
    if (waiting > 0) {
      setUnsaved(waiting);
      return;
    }
    setUnsaved(0);
    setOpen(false);
    setAdminFounder(id);
  };

  const signOut = async (force = false) => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    // Erst alle Entscheidungen speichern – danach gilt die Sitzung nicht mehr.
    const waiting = force ? 0 : await prepareSignOut();
    if (waiting > 0) {
      setUnsaved(waiting);
      setLoggingOut(false);
      return;
    }
    setUnsaved(0);
    if (!user) {
      if (force) discardPending();
      setLoggingOut(false);
      setOpen(false);
      dispatch({ type: 'LOGOUT' });
      return;
    }
    try {
      await logout();
      // Erst verwerfen, wenn die Abmeldung geklappt hat – sonst wären die Entscheidungen weg und die Sitzung bliebe.
      if (force) discardPending();
    } catch (error) {
      // Menü bleibt offen und sagt, warum – die Sitzung gilt dann weiter.
      setLogoutError(error instanceof Error ? error.message : 'Abmelden hat nicht geklappt.');
      setLoggingOut(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    // Während des Abmeldens bleibt das Menü offen – sonst ginge eine Fehlermeldung unter.
    const close = (event: MouseEvent) => {
      if (!loggingOut && !ref.current?.contains(event.target as Node)) setOpen(false);
    };
    // Esc schließt das Menü und gibt den Fokus an den Avatar zurück.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || loggingOut) return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, loggingOut]);

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (loggingOut) return;
          // Beim Öffnen eine alte Fehlermeldung verwerfen.
          if (!open) setLogoutError(null);
          setOpen(!open);
        }}
        aria-label={`Konto: ${displayName}${waiting > 0 ? ` · ${waiting} ${waiting === 1 ? 'Registrierung wartet' : 'Registrierungen warten'}` : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={displayName}
        className={cn(
          'relative flex h-9 w-9 items-center justify-center rounded-full transition-[box-shadow,transform] active:scale-[0.96]',
          (open || state.view === 'settings' || state.view === 'accounts') && 'shadow-[0_0_0_2px_var(--color-canvas),0_0_0_4px_rgb(255_255_255/0.25)]',
        )}
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#2f6bff] text-[13px] font-bold text-white" aria-hidden>
          {displayInitials}
        </span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -4, transition: { duration: 0.12 } }}
            transition={SPRING_MENU}
            style={{ transformOrigin: 'top right' }}
            className="absolute right-0 top-11 z-40 w-[240px] overflow-hidden rounded-[14px] border border-line bg-surface-2 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.85)]"
          >
            <div className="border-b border-line px-4 py-3">
              <p className="text-[14px] font-semibold">{user?.name ?? founder.name}</p>
              {user && <p className="text-[12.5px] text-ink-3" data-testid="signed-in-as">Angemeldet als {user.username}</p>}
              {workingFor && <p className="text-[12.5px] text-ink-3" data-testid="account-role">{workingFor}</p>}
            </div>
            {/* Admin und Mitarbeiter mit mehreren Gründern wählen, wessen Aufgaben zu sehen sind. */}
            {access.switchableFounders.length > 1 && (
              <div className="border-b border-line px-4 py-3" data-testid="admin-founder">
                <p className="mb-2 text-[12px] font-semibold text-ink-3">Aufgaben von</p>
                <div className="flex gap-1" role="radiogroup" aria-label="Aufgaben von">
                  {access.switchableFounders.map((id) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={id === founderId}
                      onClick={() => void switchFounder(id)}
                      className={cn(
                        'h-8 flex-1 rounded-full text-[13px] font-medium transition-colors',
                        id === founderId ? 'bg-surface-4 font-semibold text-ink' : 'text-ink-2 hover:bg-surface-3 hover:text-ink',
                      )}
                    >
                      {FOUNDERS[id].name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* Einstellungen gibt es nur mit echter Anmeldung. Mitarbeiter-Konten sehen sie nicht (`shared/auth.ts` → Rollen und Rechte). */}
            {auth.status === 'authenticated' && access.canEditSettings && (
              <button
                type="button"
                data-testid="nav-settings"
                aria-current={state.view === 'settings' ? 'page' : undefined}
                onClick={() => {
                  setOpen(false);
                  dispatch({ type: 'SET_VIEW', view: 'settings' });
                }}
                className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-[13.5px] text-ink-2 transition-colors hover:bg-white/[0.05] hover:text-ink"
              >
                <Settings className="h-4 w-4" />
                Einstellungen
              </button>
            )}
            {access.canManageAccounts && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  dispatch({ type: 'SET_VIEW', view: 'accounts' });
                }}
                data-testid="menu-accounts"
                aria-current={state.view === 'accounts' ? 'page' : undefined}
                className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-[13.5px] text-ink-2 transition-colors hover:bg-white/[0.05] hover:text-ink"
              >
                <UserCog className="h-4 w-4" />
                Konten
                {waiting > 0 && (
                  <span className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
                    {waiting} {waiting === 1 ? 'wartet' : 'warten'}
                  </span>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => void signOut()}
              // aria-disabled statt disabled: Der Fokus bleibt auf dem Knopf, auch wenn das Abmelden scheitert.
              aria-disabled={loggingOut}
              aria-busy={loggingOut}
              aria-describedby={logoutError ? 'logout-error' : undefined}
              className="flex w-full items-center gap-2.5 border-t border-line px-4 py-3 text-left text-[13.5px] text-ink-2 transition-colors hover:bg-white/[0.05] hover:text-ink aria-disabled:opacity-60"
            >
              <LogOut className="h-4 w-4" />
              {!user ? 'Abmelden / Gründer wechseln' : loggingOut ? 'Abmelden…' : 'Abmelden'}
            </button>
            {unsaved > 0 && (
              <div role="alert" className="px-4 pb-3 text-[12.5px] leading-snug text-ink" data-testid="logout-unsaved">
                <p className="flex items-baseline gap-2">
                  <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-warn" aria-hidden />
                  {unsaved === 1 ? '1 Entscheidung ist' : `${unsaved} Entscheidungen sind`} noch nicht gespeichert (offline).
                </p>
                <button type="button" onClick={() => void signOut(true)} className="mt-1.5 font-medium text-ink-2 hover:text-ink">
                  Trotzdem abmelden
                </button>
              </div>
            )}
            {logoutError && (
              <p
                id="logout-error"
                role="alert"
                data-testid="logout-error"
                className="flex items-baseline gap-2 px-4 pb-3 text-[12.5px] leading-snug text-ink"
              >
                <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
                {logoutError}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Initialen aus dem Anzeigenamen („Anna Berg“ → „AB“). */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? '?').slice(0, 1)).toUpperCase();
}
