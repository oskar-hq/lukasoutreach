import {
  Archive,
  ArrowDownToLine,
  Building2,
  ChevronLeft,
  Clock,
  FileText,
  Gauge,
  Handshake,
  History,
  ListChecks,
  Megaphone,
  Search,
  Send,
  Server,
  Sparkles,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { useHotkeys } from '../../lib/useHotkeys';
import { useAccess } from '../../state/auth';
import { AutoSearchSection } from '../autoSearch/AutoSearchSection';
import { SecretKeyCard, SystemSection, UpdateButton, UpdatePage, useSoftwareUpdate, type SoftwareUpdate } from '../system/SystemSection';
import { MenuList, MenuRow, type RowBadge } from './MenuRow';
import {
  categoryOf,
  isValueSection,
  matchesSearch,
  NAV_ITEMS,
  navItem,
  OVERVIEW_ITEM,
  QUICK_TOGGLES,
  searchSubpages,
  sectionOfPage,
  SETTINGS_NAV,
  SETTINGS_SECTIONS,
  subpage,
  type SettingsSection,
} from './settingsNav';
import { SettingsView } from './SettingsView';
import { TemplatesSection } from './TemplatesSection';

/** Früher Reiter, heute Bereiche: `values` (alte Aufrufe) öffnet „Auf einen Blick“. */
export type SettingsTab = SettingsSection | 'values';

const TAB_KEY = 'cockpit.settings.tab';
const PAGE_KEY = 'cockpit.settings.page';

/**
 * Welcher Bereich beim nächsten Öffnen der Einstellungen gezeigt wird (z. B. aus dem Dashboard „Vorlagen bearbeiten“),
 * optional gleich eine Unterseite (`unipile.searchAccount`).
 */
export function openSettingsTab(tab: SettingsTab, page?: string) {
  try {
    sessionStorage.setItem(TAB_KEY, tab === 'values' ? 'overview' : tab);
    if (page) sessionStorage.setItem(PAGE_KEY, page);
    else sessionStorage.removeItem(PAGE_KEY);
  } catch {
    // nur Komfort
  }
}

/** Kennzeichen in den Listen – nur was abweicht (DESIGN.md §1). */
export type NavBadge = RowBadge;

/** Wo man steht: erste Ebene (beides null) → Bereich → Unterseite. */
interface Path {
  section: SettingsSection | null;
  page: string | null;
}

const ROOT: Path = { section: null, page: null };

function pathTo(section: SettingsSection, page: string | null = null): Path {
  const target = page ? subpage(page) : undefined;
  // Unterseiten, die auf einer eigenen Seite stehen (automatische Updates → Software-Update), öffnen diese Seite.
  if (target && sectionOfPage(target) !== target.group) return { section: sectionOfPage(target), page: null };
  // Die wichtigen Werte stehen direkt auf der Seite des Bereichs.
  if (target?.inline) return { section: target.group, page: null };
  return { section, page: target?.group === section ? target.id : null };
}

/**
 * Ziel eines Sprungs von anderswo („Vorlagen bearbeiten“, Glocke) – einmalig, danach wieder gelöscht. Sonst beginnen
 * die Einstellungen auf der ersten Ebene, wie eine App.
 */
function readPath(): Path {
  try {
    const stored = sessionStorage.getItem(TAB_KEY);
    const storedPage = sessionStorage.getItem(PAGE_KEY);
    if (!SETTINGS_SECTIONS.includes(stored as SettingsSection)) return ROOT;
    return pathTo(stored as SettingsSection, storedPage);
  } catch {
    return ROOT;
  }
}

function parentOf(path: Path): Path {
  return path.page ? { ...path, page: null } : ROOT;
}

function titleOf(path: Path): string {
  if (path.page) return subpage(path.page)?.label ?? '';
  if (path.section) return navItem(path.section).label;
  return 'Einstellungen';
}

const ICON = 'h-[17px] w-[17px]';

/** Symbol je Bereich – gefüllter schwarzer Kreis mit weißem Zeichen (Listenzeile laut DESIGN-Vorlage). */
const SECTION_ICON: Record<SettingsSection, ReactNode> = {
  overview: <Gauge className={ICON} strokeWidth={2.25} />,
  leadSearch: <Search className={ICON} strokeWidth={2.25} />,
  auto: <Clock className={ICON} strokeWidth={2.25} />,
  linkedin: <Send className={ICON} strokeWidth={2.25} />,
  tasks: <ListChecks className={ICON} strokeWidth={2.25} />,
  templates: <FileText className={ICON} strokeWidth={2.25} />,
  unipile: <Users className={ICON} strokeWidth={2.25} />,
  anthropic: <Sparkles className={ICON} strokeWidth={2.25} />,
  meta: <Megaphone className={ICON} strokeWidth={2.25} />,
  clay: <Building2 className={ICON} strokeWidth={2.25} />,
  crm: <Handshake className={ICON} strokeWidth={2.25} />,
  update: <ArrowDownToLine className={ICON} strokeWidth={2.25} />,
  backup: <Archive className={ICON} strokeWidth={2.25} />,
  server: <Server className={ICON} strokeWidth={2.25} />,
  history: <History className={ICON} strokeWidth={2.25} />,
};

/**
 * Einstellungen wie eine Einstellungs-App (Wunsch des Nutzers 23.10.): Die erste Ebene zeigt alle Bereiche auf einmal,
 * gibt es ein neues Update, steht der Knopf gleich oben. Ein Klick → Bereich → Unterseite mit wenigen Werten; zurück
 * geht es oben links oder mit Esc. Alle Bereiche bleiben geladen, damit beim Wechseln keine ungespeicherten Änderungen
 * verloren gehen.
 */
export function SettingsPage() {
  const { canEditSettings } = useAccess();
  if (!canEditSettings) {
    return (
      <div className="mx-auto max-w-[760px] px-4 py-16 text-center sm:px-6" data-testid="settings-not-allowed">
        <p className="display text-[26px] font-semibold">Einstellungen sind für dein Konto gesperrt.</p>
        <p className="mt-2 text-[15px] text-ink-2">Schlüssel, Grenzen und Vorlagen ändern Gründer oder Admins.</p>
      </div>
    );
  }
  return <SettingsContent />;
}

function SettingsContent() {
  const [path, setPath] = useState<Path>(readPath);
  const [query, setQuery] = useState('');
  const [badges, setBadges] = useState<Partial<Record<SettingsSection, NavBadge>>>({});
  const { section, page } = path;
  // Sprungziel nur einmal verwenden (nicht im Initialisierer löschen – React ruft ihn im StrictMode doppelt auf).
  useEffect(() => {
    try {
      sessionStorage.removeItem(TAB_KEY);
      sessionStorage.removeItem(PAGE_KEY);
    } catch {
      // nur Komfort
    }
  }, []);

  const navigate = useCallback((next: Path) => {
    setPath(next);
    window.scrollTo({ top: 0 });
  }, []);
  /** In einen Bereich (und optional eine Unterseite) springen – aus Suche, Übersicht, Fehlern oder „Sicherungen“. */
  const open = useCallback((next: SettingsSection, nextPage: string | null = null) => navigate(pathTo(next, nextPage)), [navigate]);
  const back = () => navigate(parentOf(path));
  const atRoot = !path.section;
  const update = useSoftwareUpdate();
  const shownBadges: Partial<Record<SettingsSection, NavBadge>> = update.hasUpdate ? { ...badges, update: { text: 'Neu', tone: 'accent' } } : badges;

  // Esc = eine Ebene zurück (Textfelder und offene Dialoge behalten Esc für sich).
  useHotkeys({ escape: back }, !atRoot);

  // „Gespeichert“ neben dem Titel – kurz einblenden, dann wieder weg (Design v2).
  const [savedAt, setSavedAt] = useState(0);
  useEffect(() => {
    if (!savedAt) return;
    const timer = window.setTimeout(() => setSavedAt(0), 1800);
    return () => window.clearTimeout(timer);
  }, [savedAt]);
  const onSaved = useCallback(() => setSavedAt(Date.now()), []);

  const listView = !section;

  return (
    <div className="mx-auto max-w-[640px] px-4 pb-10 pt-6 sm:px-6 sm:pt-12">
      {!atRoot && (
        <button
          type="button"
          onClick={back}
          className="-ml-2 mb-4 inline-flex min-h-[44px] items-center gap-0.5 rounded-lg px-2 text-[15px] font-medium text-ink-2 transition-colors hover:text-ink"
          data-testid="settings-back"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden /> {titleOf(parentOf(path))}
        </button>
      )}
      <header className="flex items-baseline justify-between gap-4">
        <h1
          className="display min-w-0 hyphens-auto break-words text-[30px] font-bold leading-[1.1] tracking-[-0.025em] sm:text-[34px]"
          data-testid={listView ? 'settings-title' : 'settings-section-title'}
        >
          {titleOf(path)}
        </h1>
        <span
          aria-hidden
          className={cn('shrink-0 text-[12px] font-semibold text-good transition-opacity duration-300 ease-out', savedAt ? 'opacity-100' : 'opacity-0')}
          data-testid="settings-saved"
        >
          Gespeichert
        </span>
      </header>

      {atRoot && <RootMenu query={query} onQuery={setQuery} badges={shownBadges} update={update} onOpen={open} />}

      {/* Bereiche bleiben geladen (Entwürfe, Zustand der Formulare) – sichtbar ist nur der offene. */}
      {/* Einfache Seiten (Wunsch des Nutzers 23.10.): großer Knopf, darunter nur Schalter, die sofort gelten. */}
      {section === 'update' && <UpdatePage update={update} />}
      <div hidden={section !== 'backup' || page !== null}>
        <SystemSection active={section === 'backup' && page === null} />
      </div>
      {/* Warnungen (Notfallmodus, Probe) zeigt sie auch auf den Menüs – sie sind nie eingeklappt. */}
      <SettingsView
        section={section === 'update' ? 'backup' : section && isValueSection(section) ? section : null}
        page={section === 'update' ? null : page}
        quick={section && page === null ? QUICK_TOGGLES[section] : undefined}
        notices={!section}
        onNavigate={open}
        onBadges={setBadges}
        onSaved={onSaved}
      />
      {section === 'backup' && page === null && <SecretKeyCard />}
      <div hidden={section !== 'templates'} className="pt-10">
        <TemplatesSection active={section === 'templates'} />
      </div>
      <div hidden={section !== 'auto'}>
        <AutoSearchSection active={section === 'auto'} />
      </div>
    </div>
  );
}

/** Erste Ebene: Suche, ggf. das neue Update, „Auf einen Blick“ und alle Bereiche unter drei Überschriften – oder die Treffer. */
function RootMenu({
  query,
  onQuery,
  badges,
  update,
  onOpen,
}: {
  query: string;
  onQuery: (query: string) => void;
  badges: Partial<Record<SettingsSection, NavBadge>>;
  update: SoftwareUpdate;
  onOpen: (section: SettingsSection, page?: string | null) => void;
}) {
  const searching = query.trim() !== '';
  const sections = searching ? NAV_ITEMS.filter((item) => matchesSearch(item.id, query)) : [];
  const pages = searching ? searchSubpages(query) : [];

  return (
    <nav aria-label="Einstellungen" data-testid="settings-nav">
      <label className="mt-6 flex h-[44px] items-center gap-2.5 rounded-[12px] bg-surface-3 px-3.5">
        <span className="sr-only">Einstellungen durchsuchen</span>
        <Search className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Einstellung suchen"
          className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-4 sm:text-[15px]"
          data-testid="settings-search"
        />
      </label>

      {searching ? (
        sections.length + pages.length === 0 ? (
          <p className="mt-6 text-[14px] text-ink-3">Nichts gefunden für „{query.trim()}“.</p>
        ) : (
          <MenuList className="mt-6" label="Treffer">
            {sections.map((item) => (
              <MenuRow
                key={item.id}
                title={item.label}
                subtitle={categoryOf(item.id)?.title ?? 'Einstellungen'}
                icon={SECTION_ICON[item.id]}
                badge={badges[item.id]}
                onClick={() => onOpen(item.id)}
                testId={`settings-nav-${item.id}`}
              />
            ))}
            {pages.map((entry) => (
              <MenuRow
                key={entry.id}
                title={entry.label}
                subtitle={navItem(sectionOfPage(entry)).label}
                onClick={() => onOpen(sectionOfPage(entry), entry.id)}
                testId={`settings-result-${entry.id}`}
              />
            ))}
          </MenuList>
        )
      ) : (
        <>
          {/* Neues Update: ein Knopf, gleich hier – kein Suchen, kein Passwort. */}
          {update.hasUpdate && (
            <div className="mt-8 flex min-h-[64px] items-center gap-4" data-testid="settings-update-banner">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-canvas" aria-hidden>
                {SECTION_ICON.update}
              </span>
              <button type="button" onClick={() => onOpen('update')} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[16px] font-semibold tracking-[-0.01em] text-ink">Neue Version da</span>
                <span className="mt-0.5 block truncate text-[13.5px] text-ink-3">{update.running ? 'Wird eingespielt …' : 'Ein Klick, dann geht es los'}</span>
              </button>
              <UpdateButton update={update} size="sm" testId="settings-update-start" />
            </div>
          )}
          <MenuList className="mt-6">
            <MenuRow
              title={OVERVIEW_ITEM.label}
              subtitle={OVERVIEW_ITEM.lead}
              icon={SECTION_ICON.overview}
              onClick={() => onOpen('overview')}
              testId="settings-nav-overview"
            />
          </MenuList>
          {SETTINGS_NAV.map((group) => (
            <section key={group.id} className="mt-8" aria-labelledby={`settings-group-${group.id}`}>
              <h2 id={`settings-group-${group.id}`} className="mb-1 text-[13px] font-semibold text-ink-3" data-testid={`settings-cat-${group.id}`}>
                {group.title}
              </h2>
              <MenuList>
                {group.items.map((item) => (
                  <MenuRow
                    key={item.id}
                    title={item.label}
                    subtitle={item.lead}
                    icon={SECTION_ICON[item.id]}
                    badge={badges[item.id]}
                    badgeTestId={`settings-nav-badge-${item.id}`}
                    onClick={() => onOpen(item.id)}
                    testId={`settings-nav-${item.id}`}
                  />
                ))}
              </MenuList>
            </section>
          ))}
        </>
      )}
    </nav>
  );
}
