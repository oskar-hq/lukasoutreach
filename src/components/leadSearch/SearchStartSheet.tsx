import { ArrowRight, ChevronDown } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { SEARCH_HITS_MAX, SEARCH_HITS_MIN, runSearchHits, type SearchAudience } from '../../../shared/leadSearch';
import type { SettingKey, SettingValue, SettingsResponse } from '../../../shared/settings';
import { settingsApi } from '../../lib/leadSearchApi';
import { useLinkedIn } from '../../state/linkedin';
import { Stepper } from '../autoSearch/ProfileInputs';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Segmented } from '../ui/Segmented';
import { cn } from '../../lib/cn';
import { Spinner } from './Funnel';
import { AudienceSelect } from './AudienceSelect';

/** Einstellungen der Lead-Suche, die vor dem Start im Dialog stehen (Wunsch des Nutzers 12.10.). */
const KEYS = ['SEARCH_HITS_PER_RUN', 'QUALIFY_MIN_CONFIDENCE', 'AUTO_QUALIFY_TERMS', 'LEAD_DISTRIBUTION'] as const;
type SheetKey = (typeof KEYS)[number];
type Values = Partial<Record<SheetKey, SettingValue | null>>;

/**
 * „Suche starten“ öffnet diesen Dialog: oben in einem Satz, was der Lauf macht, dann „Jetzt suchen“ (Wunsch des Nutzers
 * 25.10., weniger Entscheidungen vor dem Start). Profile pro Lauf (nur dieser Lauf) und die Einstellungen der Lead-Suche
 * (gelten auch für spätere Suchen, wie unter Einstellungen → Lead-Suche) liegen hinter „Anpassen“. „Jetzt suchen“
 * speichert Geändertes und startet. Darf das Konto keine Einstellungen ändern (Mitarbeiter), steht dort nur „Profile pro Lauf“.
 */
export function SearchStartSheet({
  open,
  onClose,
  maxResults,
  maxResultsLimit,
  onMaxResults,
  onStart,
  audience,
  onAudience,
  searchHits,
  backlog = 0,
}: {
  open: boolean;
  onClose: () => void;
  maxResults: number;
  maxResultsLimit: number;
  onMaxResults: (value: number) => void;
  /** Startet die Suche; wirft mit deutscher Meldung, wenn es nicht klappt. */
  onStart: () => Promise<void>;
  /** Zielgruppe der Suche (27.10.) – als Dropdown direkt unter dem Satz, null = eigene Auswahl. */
  audience?: SearchAudience | null;
  onAudience?: (audience: SearchAudience) => void;
  /** Suchtreffer pro Lauf laut Backend (`/config`) – falls die Einstellungen nicht lesbar sind. */
  searchHits?: number;
  /** Treffer auf der Warteliste (`/config`), kommen zuerst dran. */
  backlog?: number;
}) {
  const titleId = useId();
  const [settings, setSettings] = useState<SettingsResponse | null | 'denied'>(null);
  const [draft, setDraft] = useState<Values>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adjust, setAdjust] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDraft({});
    setAdjust(false);
    setError(null);
    setBusy(false);
    setSettings(null);
    settingsApi
      .get()
      .then((response) => !cancelled && setSettings(response))
      .catch(() => !cancelled && setSettings('denied'));
    return () => {
      cancelled = true;
    };
  }, [open]);

  const loaded = settings && settings !== 'denied' ? settings : null;
  const saved = (key: SheetKey): SettingValue | null => loaded?.settings.find((state) => state.key === key)?.value ?? null;
  const value = (key: SheetKey) => (key in draft ? (draft[key] ?? null) : saved(key));
  const set = (key: SheetKey, next: SettingValue | null) => setDraft((current) => ({ ...current, [key]: next }));

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const changes: Partial<Record<SettingKey, SettingValue | null>> = {};
      for (const key of KEYS) if (key in draft && draft[key] !== saved(key)) changes[key] = draft[key] ?? null;
      if (loaded && Object.keys(changes).length) await settingsApi.update({ changes, version: loaded.version });
      await onStart();
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : 'Die Suche konnte nicht gestartet werden.');
      setBusy(false);
    }
  };

  // ↵ im Dialog = „Jetzt suchen“ (außer im Textfeld für Stichwörter, dort ebenfalls – ein Feld, eine Aktion).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      void submit();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const hits = Number(value('SEARCH_HITS_PER_RUN') ?? searchHits ?? 400);
  const confidence = Number(value('QUALIFY_MIN_CONFIDENCE') ?? 0.6);
  const terms = String(value('AUTO_QUALIFY_TERMS') ?? '');
  const distribution = String(value('LEAD_DISTRIBUTION') ?? 'owner') as 'owner' | 'balanced';
  // Verteilt wird nur, wenn beide Gründer einen LinkedIn-Account haben (Server: `leadDistributionPool`) – sonst ehrlich sagen.
  const { status: linkedin } = useLinkedIn();
  const bothAccounts = (linkedin?.accounts.filter((account) => account.connected).length ?? 0) >= 2;

  return (
    <Modal open={open} onClose={() => !busy && onClose()} labelledBy={titleId} className="sm:max-w-lg">
      {/* Auf dem Handy höher als der Bildschirm: Inhalt scrollt im Sheet (nicht die Seite dahinter), „Jetzt suchen“ bleibt
          unten immer sichtbar (Wunsch des Nutzers 13.10.). */}
      <div className="flex max-h-[var(--sheet-inner-max-h)] flex-col" data-testid="search-start-sheet">
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 pb-2 sm:p-6 sm:pb-2" data-testid="sheet-scroll">
          <h2 id={titleId} className="text-[19px] font-semibold tracking-[-0.01em]">
            Suche starten
          </h2>
          {settings === null ? (
            <div className="flex justify-center py-6" aria-label="Einstellungen werden geladen">
              <Spinner className="h-4 w-4" />
            </div>
          ) : (
            // Verteilt wird erst mit zwei verbundenen Accounts – bis dahin landen alle bei dir, so steht es auch im Satz.
            <RunPlan hits={hits} maxResults={maxResults} backlog={backlog} distribution={settings === 'denied' ? null : distribution === 'balanced' && bothAccounts ? 'balanced' : 'owner'} />
          )}

          {onAudience && (
            <div className="mt-4">
              <AudienceSelect audience={audience ?? null} onPick={onAudience} testId="sheet-audience" hint={false} />
            </div>
          )}

          <button
            type="button"
            onClick={() => setAdjust((current) => !current)}
            aria-expanded={adjust}
            className="mt-3 inline-flex min-h-11 items-center gap-1 text-[13.5px] font-medium text-ink-2 transition-colors hover:text-ink"
            data-testid="sheet-adjust"
          >
            Anpassen
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', adjust && 'rotate-180')} />
          </button>

          {adjust && (
            <div className="transition-[opacity,translate] duration-200 ease-out starting:-translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0" data-testid="sheet-settings">
              <Row label="Profile pro Lauf" hint="Nur für diese Suche – jedes Profil ist ein Besuch über LinkedIn.">
                <Stepper label="Profile pro Lauf" testId="sheet-max-results" editable showMax={false} value={maxResults} min={1} max={maxResultsLimit} onChange={onMaxResults} />
              </Row>
              {settings === 'denied' ? (
                <p className="py-4 text-[13px] text-ink-3" data-testid="sheet-settings-denied">
                  Die übrigen Einstellungen der Lead-Suche ändert ein Gründer oder Admin.
                </p>
              ) : (
                settings !== null && (
                  <>
                    <Row label="Suchtreffer pro Lauf" hint="So viele Treffer sieht die KI vor dem Profilabruf durch – die Warteliste zählt mit.">
                      <Stepper
                        label="Suchtreffer pro Lauf"
                        testId="sheet-search-hits"
                        editable
                        showMax={false}
                        value={hits}
                        min={SEARCH_HITS_MIN}
                        max={SEARCH_HITS_MAX}
                        onChange={(next) => set('SEARCH_HITS_PER_RUN', next)}
                      />
                    </Row>
                    <Row label="Mindestsicherheit der KI" hint="In Prozent. 50 = „eher ja“ reicht für qualifiziert.">
                      <Stepper
                        label="Mindestsicherheit der KI in Prozent"
                        testId="sheet-confidence"
                        editable
                        showMax={false}
                        value={Math.round(confidence * 100)}
                        min={0}
                        max={100}
                        onChange={(next) => set('QUALIFY_MIN_CONFIDENCE', Math.round(next) / 100)}
                      />
                    </Row>
                    <Row label="Ohne KI qualifizieren bei" hint="Stichwörter mit Komma – Entscheider mit diesem Wort gelten ohne KI-Aufruf als qualifiziert. „off“ = aus.">
                      <input
                        value={terms}
                        onChange={(event) => set('AUTO_QUALIFY_TERMS', event.target.value)}
                        aria-label="Ohne KI qualifizieren bei"
                        data-testid="sheet-auto-qualify"
                        className="h-11 w-full rounded-xl border border-transparent bg-surface-3 px-3 text-[16px] text-ink outline-none transition-colors focus:border-accent sm:text-[14px]"
                      />
                    </Row>
                    <Row
                      label="Neue Leads verteilen"
                      hint={distribution === 'balanced' && !bothAccounts ? 'Wirkt erst, wenn beide Gründer einen verbundenen LinkedIn-Account haben – bis dahin bekommst du alle.' : undefined}
                    >
                      <Segmented
                        ariaLabel="Neue Leads verteilen"
                        size="sm"
                        value={distribution}
                        onChange={(next) => set('LEAD_DISTRIBUTION', next)}
                        options={[
                          { value: 'owner', label: 'An mich' },
                          { value: 'balanced', label: 'Auf beide' },
                        ]}
                      />
                    </Row>
                  </>
                )
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="mt-4 text-[13.5px] text-ink" data-testid="sheet-error">
              {error}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-line px-5 py-3.5 sm:px-6" data-testid="sheet-actions">
          <Button variant="ghost" onClick={onClose} disabled={busy} data-testid="sheet-cancel">
            Abbrechen
          </Button>
          <Button variant="primary" size="lg" shortcut="↵" onClick={() => void submit()} disabled={busy || settings === null} data-testid="start-search-confirm">
            {busy ? 'Startet …' : 'Jetzt suchen'}
            {!busy && <ArrowRight className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <p className="text-[14px] font-medium text-ink">{label}</p>
        {hint && <p className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{hint}</p>}
      </div>
      <div className="shrink-0 sm:w-[220px]">{children}</div>
    </div>
  );
}

/**
 * Was der Lauf macht, in einem Absatz (Wunsch des Nutzers 12.10.: „man versteht nicht, wieso auf einmal so viel
 * kommt“; 25.10.: statt Einstellungen zuerst). Gleiche Rechnung wie im Backend (`runSearchHits`, Warteliste zuerst).
 */
function RunPlan({
  hits: setting,
  maxResults,
  backlog,
  distribution,
}: {
  hits: number;
  maxResults: number;
  backlog: number;
  /** Verteilung neuer Leads – `null`, wenn das Konto sie nicht lesen darf. */
  distribution: 'owner' | 'balanced' | null;
}) {
  const profiles = Number.isFinite(maxResults) && maxResults > 0 ? maxResults : 1;
  const hits = runSearchHits(Number.isFinite(setting) ? setting : SEARCH_HITS_MIN, profiles);
  const fromBacklog = Math.min(backlog, hits);
  const fresh = hits - fromBacklog;
  const n = (value: number) => <strong className="font-semibold text-ink tabular-nums">{value.toLocaleString('de-DE')}</strong>;
  return (
    <div className="mt-3 text-[15px] leading-[1.55] text-ink-2" data-testid="sheet-run-plan">
      <p data-testid="sheet-run-plan-hits">
        {fromBacklog > 0 ? (
          <>
            {n(fromBacklog)} aus der Warteliste
            {fresh > 0 ? <> + bis zu {n(fresh)} neue von LinkedIn</> : <>, diesmal keine neue Suche</>} = {n(hits)} Treffer.
          </>
        ) : (
          <>Bis zu {n(hits)} neue Treffer von LinkedIn.</>
        )}
      </p>
      <p className="mt-1">
        Die KI liest davon höchstens {n(profiles)} {profiles === 1 ? 'Profil' : 'Profile'}
        {distribution === 'balanced' ? <>, neue Leads gehen <strong className="font-semibold text-ink">an beide</strong>.</> : distribution === 'owner' ? <>, neue Leads kommen in <strong className="font-semibold text-ink">deinen</strong> Stapel.</> : '.'}
      </p>
      {setting < profiles && (
        <p className="mt-1 text-[13px] text-ink-3" data-testid="sheet-run-plan-raised">
          Suchtreffer auf {profiles.toLocaleString('de-DE')} angehoben – mindestens so viele wie Profile.
        </p>
      )}
      {backlog > hits && (
        <p className="mt-1 text-[13px] text-ink-3">Weitere {(backlog - hits).toLocaleString('de-DE')} Treffer warten auf spätere Suchen.</p>
      )}
    </div>
  );
}
