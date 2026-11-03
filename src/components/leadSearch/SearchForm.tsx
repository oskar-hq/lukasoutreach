import { useAccess } from '../../state/auth';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  DEFAULT_SEARCH_PROFILE,
  MAX_RESULTS_LIMIT,
  SEARCH_PRESETS,
  clampMaxResults,
  runSearchHits,
  searchAudienceOf,
  type SearchAudience,
  type LinkedinAccountState,
  type SearchProfile,
} from '../../../shared/leadSearch';
import { cn } from '../../lib/cn';
import { ApiError } from '../../lib/leadSearchApi';
import { useHotkeys } from '../../lib/useHotkeys';
import { useDemo } from '../../state/demo';
import { Field, Stepper, TermField } from '../autoSearch/ProfileInputs';
import { Button } from '../ui/Button';
import { DisclosureToggle } from '../ui/Disclosure';
import { MetaLine } from '../ui/MetaLine';
import { PageHeader } from '../ui/PageHeader';
import { openSettingsTab } from '../settings/SettingsPage';
import { Spinner } from './Funnel';
import { SearchStartSheet } from './SearchStartSheet';
import { AudienceSelect } from './AudienceSelect';
import { useLeadSearch } from './LeadSearchProvider';

const ACCOUNT_TITLES: Record<Exclude<LinkedinAccountState, 'ok'>, string> = {
  missing: 'Noch kein LinkedIn-Account verbunden',
  connecting: 'LinkedIn-Account wird verbunden',
  reconnect: 'LinkedIn-Account neu verbinden',
  unreachable: 'Unipile nicht erreichbar',
};

/** So oft wird der Account-Status geprüft, solange die Live-Suche darauf wartet. */
const ACCOUNT_RECHECK_MS = 30_000;

/** Schritt 0: Suchprofil festlegen – eine Spalte, ein Button. */
export function SearchForm() {
  const { state } = useDemo();
  const { config, reloadConfig, refreshConfig, start } = useLeadSearch();
  const loaded = config.status === 'ready' ? config.config : null;
  const initial = state.leadSearch.lastProfile ?? loaded?.defaults ?? DEFAULT_SEARCH_PROFILE;
  const limit = loaded?.maxResultsLimit ?? MAX_RESULTS_LIMIT;

  const [keywords, setKeywords] = useState(initial.keywords);
  const [positions, setPositions] = useState(initial.positions);
  const [region, setRegion] = useState(initial.region);
  const [maxResults, setMaxResults] = useState(Math.min(limit, initial.maxResults));
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Einmal beim Einhängen: Region und Profile aufgeklappt, wenn die gespeicherte Region nicht taugt. Nie aus der
  // laufenden Eingabe ableiten – sonst verschwände das Feld unter dem Cursor.
  const [optionsOpen, setOptionsOpen] = useState(() => initial.region.trim().length <= 1);
  const regionId = useId();
  const audience = searchAudienceOf({ keywords, positions });
  const pickAudience = (next: SearchAudience) => {
    setKeywords([...SEARCH_PRESETS[next].keywords]);
    setPositions([...SEARCH_PRESETS[next].positions]);
  };

  const ready = !!loaded?.ready;
  const account = loaded?.account ?? null;
  const waitingForAccount = !!account && account.state !== 'ok' && loaded?.problems.length === 0;
  const [checking, setChecking] = useState(false);

  const checkAccount = async () => {
    setChecking(true);
    await refreshConfig();
    setChecking(false);
  };

  // Wartet die Live-Suche auf den LinkedIn-Account, regelmäßig nachsehen – sie schaltet sich dann von selbst frei.
  useEffect(() => {
    if (!waitingForAccount) return;
    const timer = window.setInterval(() => void refreshConfig(), ACCOUNT_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [waitingForAccount, refreshConfig]);
  const valid = keywords.length > 0 && positions.length > 0 && region.trim().length > 1;
  const canStart = ready && valid && !starting;

  // „Suche starten“ öffnet erst den Dialog mit den Einstellungen (Wunsch des Nutzers 12.10.), „Jetzt suchen“ startet.
  const [sheetOpen, setSheetOpen] = useState(false);
  const submit = async () => {
    if (!canStart) return;
    setError(null);
    setSheetOpen(true);
  };
  const launch = async () => {
    setStarting(true);
    const profile: SearchProfile = { keywords, positions, region: region.trim(), maxResults: clampMaxResults(maxResults) };
    try {
      await start(profile);
    } catch (caught) {
      setStarting(false);
      throw caught instanceof ApiError ? caught : new Error('Die Suche konnte nicht gestartet werden.');
    }
  };

  useHotkeys({ enter: submit }, canStart && !state.panelLeadId && !sheetOpen);

  // Profile ~8 s je Abruf; Suchseiten ~3 s, höchstens 200 Seiten (wie `maxSearchRequests` im Backend).
  // Leeres Feld beim Tippen (NaN) → Voreinstellung, wie beim Start.
  const perRun = clampMaxResults(maxResults);
  // Wie das Backend: Warteliste zuerst, neu gesucht wird nur der Rest.
  const hits = loaded?.searchHits ? Math.max(0, runSearchHits(loaded.searchHits, perRun) - (loaded.backlog ?? 0)) : 0;
  const searchPages = hits ? Math.min(200, Math.ceil(hits / 10) * 2) : 0;
  const estimate = `Über LinkedIn${account?.name ? ` (${account.name})` : ''} · bis ca. ${Math.max(1, Math.round((perRun * 8 + searchPages * 3) / 60))} Min.`;

  return (
    <div className="flex min-h-[var(--app-h)] flex-col items-center px-5 pb-16 pt-8 sm:pt-10">
      {/* Eingeblendet wird schon von LeadSearchView bzw. der Ansicht (App.tsx) – keine dritte Ebene. */}
      <div className="w-full max-w-[600px]">
        <PageHeader title="Neue Leads finden" />

        {/* Was das Starten gerade verhindert – oben, damit es ohne Scrollen sichtbar ist. */}
        {config.status === 'offline' ? (
          <Notice tone="bad" title="Server nicht erreichbar">
            <button
              type="button"
              onClick={reloadConfig}
              className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
            >
              <RefreshCw className="h-3 w-3" /> Erneut versuchen
            </button>
          </Notice>
        ) : waitingForAccount && account && account.state !== 'ok' ? (
          <Notice tone="warn" title={ACCOUNT_TITLES[account.state]} testId="account-notice">
            {account.message}
            <button
              type="button"
              onClick={checkAccount}
              disabled={checking}
              className="ml-2 inline-flex items-center gap-1.5 font-medium text-accent hover:underline disabled:opacity-60"
            >
              {checking ? <Spinner className="h-2.5 w-2.5" /> : <RefreshCw className="h-3 w-3" />} Jetzt prüfen
            </button>
            <SettingsLink />
          </Notice>
        ) : loaded && !loaded.ready ? (
          <Notice tone="warn" title="Lead-Suche noch nicht eingerichtet">
            {loaded.problems.join(' ')}
            <SettingsLink fallback="Ein Gründer oder Admin trägt das in den Einstellungen ein." />
          </Notice>
        ) : loaded && loaded.warnings.length > 0 ? (
          <Notice tone="warn" title="Hinweis" testId="warning-notice">
            {loaded.warnings.join(' ')}
            <SettingsLink />
          </Notice>
        ) : null}

        <div className="mt-6 space-y-5">
          <AudienceSelect audience={audience} onPick={pickAudience} />
          <TermField label="Stichwörter" values={keywords} onChange={setKeywords} testId="keywords" />
          <TermField label="Positionen" values={positions} onChange={setPositions} testId="positions" />
          {/* Eine Zeile statt Region, Anzahl und Hinweisen – „Anpassen“ klappt die Felder auf. */}
          <MetaLine
            testId="search-summary"
            className="text-[13px] leading-[1.6] text-ink-3"
            items={[
              region.trim().length > 1 ? region.trim() : <span className="text-ink">Region fehlt</span>,
              loaded?.searchHits && <span data-testid="search-hits">{loaded.searchHits.toLocaleString('de-DE')} Treffer</span>,
              `${perRun} Profile`,
              '2./3. Grad',
              loaded?.metaAds && <span data-testid="meta-ads-hint">aktive Meta-Ads werden markiert</span>,
              <DisclosureToggle
                look="inline"
                className="font-medium text-ink-2"
                testId="search-options-toggle"
                open={optionsOpen}
                onToggle={() => setOptionsOpen((value) => !value)}
                controls={optionsOpen ? 'search-options' : undefined}
              >
                Anpassen
              </DisclosureToggle>,
            ]}
          />
          {optionsOpen && (
            <div id="search-options" className="space-y-5">
              <div className="grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-2">
                <Field label="Region" htmlFor={regionId}>
                  <input
                    id={regionId}
                    value={region}
                    onChange={(event) => setRegion(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void submit();
                      }
                    }}
                    data-testid="region"
                    className="h-12 w-full rounded-2xl border border-transparent bg-surface-3 px-4 text-[15px] text-ink outline-none transition-colors placeholder:text-ink-4 focus:border-accent"
                  />
                </Field>
                <Field label="Profile pro Lauf">
                  <Stepper
                    label="Profile pro Lauf"
                    editable
                    showMax={false}
                    value={maxResults}
                    min={1}
                    max={limit}
                    onChange={setMaxResults}
                  />
                  <p className="mt-2 text-[12.5px] text-ink-3" data-testid="profiles-hint">
                    Jedes Profil ist ein Besuch über deinen LinkedIn-Account (3–8 s Pause dazwischen, Abbruch bei Limit).
                    {loaded?.searchHits
                      ? ` Durchgesehen werden bis zu ${loaded.searchHits.toLocaleString('de-DE')} Treffer; die KI prüft jede Headline vor, Profile werden nur für die vielversprechendsten gelesen.`
                      : ''}
                  </p>
                </Field>
              </div>
              {loaded && <TrackingRow />}
            </div>
          )}
        </div>

        <Button
          variant="primary"
          size="xl"
          shortcut="↵"
          onClick={submit}
          disabled={!canStart}
          data-testid="start-search"
          className="mt-7 w-full"
        >
          {starting ? 'Suche wird gestartet …' : 'Suche starten'}
          {!starting && <ArrowRight className="h-4 w-4" />}
        </Button>

        <SearchStartSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          maxResults={maxResults}
          maxResultsLimit={limit}
          onMaxResults={setMaxResults}
          onStart={launch}
          audience={audience}
          onAudience={pickAudience}
          searchHits={loaded?.searchHits}
          backlog={loaded?.backlog}
        />

        {error ? (
          <Notice tone="bad" title="Suche nicht gestartet">
            {error}
          </Notice>
        ) : (
          <p className="mt-3 text-center text-[13px] text-ink-3">
            {ready ? estimate : ' '}
            {ready && <AccountLink />}
          </p>
        )}
      </div>
    </div>
  );
}

const dateTime = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Outreach-Tracking-Liste: wer dort steht, wird im Dubletten-Filter aussortiert. */
function TrackingRow() {
  const { config, uploadTracking, removeTracking } = useLeadSearch();
  // Die Tracking-Liste gilt für alle – Mitarbeiter ersetzen oder löschen sie nicht (`shared/auth.ts`).
  const canEditTracking = useAccess().role !== 'assistant';
  const tracking = config.status === 'ready' ? config.config.tracking : null;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await uploadTracking(file);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Die Datei konnte nicht gelesen werden.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const link = 'font-medium text-ink-2 underline-offset-4 transition-colors hover:text-ink hover:underline disabled:opacity-50';
  const setters = tracking
    ? Object.entries(tracking.bySetter)
        .map(([name, count]) => `${name} ${count}`)
        .join(' · ')
    : '';

  return (
    <div className="text-[12.5px] leading-[1.5] text-ink-3" data-testid="tracking-row">
      <p className="min-w-0">
        {busy ? (
          <span className="inline-flex items-center gap-1.5">
            <Spinner className="h-2.5 w-2.5" /> Tracking-Liste wird eingelesen …
          </span>
        ) : tracking ? (
          <>
            Tracking-Liste: <span className="font-medium tabular-nums text-ink-2">{tracking.count} Profile</span>
            {setters && ` (${setters})`} werden als Dublette aussortiert · Stand {dateTime.format(tracking.updatedAt)}
            {canEditTracking && (
              <>
                {' '}·{' '}
                <button type="button" className={link} onClick={() => input.current?.click()}>
                  Aktualisieren
                </button>{' '}
                ·{' '}
                <button type="button" className={link} onClick={() => void removeTracking()}>
                  Entfernen
                </button>
              </>
            )}
          </>
        ) : !canEditTracking ? (
          <span data-testid="tracking-none">Keine Tracking-Liste hinterlegt – hochladen kann sie ein Gründer oder Admin.</span>
        ) : (
          <>
            Schon angeschriebene Leads aussortieren:{' '}
            <button type="button" className={link} onClick={() => input.current?.click()} data-testid="tracking-upload">
              Tracking-Liste hochladen
            </button>
          </>
        )}
        {error && <span className="mt-1 block text-bad">{error}</span>}
      </p>
      <input
        ref={input}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        data-testid="tracking-file"
        onChange={(event) => void upload(event.target.files?.[0])}
      />
    </div>
  );
}

/** Hinweise führen in die Oberfläche, nie auf die Shell. Wer Einstellungen nicht ändern darf, liest, wer es tut. */
/** „Account ändern“ → Einstellungen → LinkedIn (Unipile) → Such-Account (nur mit Recht auf Einstellungen). */
function AccountLink() {
  const { canEditSettings } = useAccess();
  const { dispatch } = useDemo();
  if (!canEditSettings) return null;
  return (
    <>
      {' · '}
      <button
        type="button"
        data-testid="change-search-account"
        className="font-medium text-ink-2 hover:text-ink"
        onClick={() => {
          openSettingsTab('unipile', 'unipile.searchAccount');
          dispatch({ type: 'SET_VIEW', view: 'settings' });
        }}
      >
        Account ändern
      </button>
    </>
  );
}

function SettingsLink({ fallback }: { fallback?: string }) {
  const { canEditSettings } = useAccess();
  const { dispatch } = useDemo();
  if (!canEditSettings) return fallback ? <> {fallback}</> : null;
  return (
    <button
      type="button"
      data-testid="open-settings"
      className="ml-2 inline-flex items-center gap-1 font-medium text-accent hover:underline"
      onClick={() => {
        openSettingsTab('overview');
        dispatch({ type: 'SET_VIEW', view: 'settings' });
      }}
    >
      Einstellungen öffnen
    </button>
  );
}

function Notice({ tone, title, children, testId }: { tone: 'warn' | 'bad'; title: string; children: ReactNode; testId?: string }) {
  return (
    <div className="mt-4 flex gap-3 rounded-2xl bg-surface-2 px-4 py-3 text-left" role="status" data-testid={testId}>
      <span className={cn('mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full', tone === 'bad' ? 'bg-bad' : 'bg-warn')} />
      <p className="text-[13.5px] leading-[1.55] text-ink-2">
        <span className="font-medium text-ink">{title}.</span> {children}
      </p>
    </div>
  );
}

