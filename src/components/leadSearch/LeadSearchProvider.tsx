import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { LeadSearchConfig, SearchProfile, TrackingSummary } from '../../../shared/leadSearch';
import { ApiError, leadSearchApi, leadsApi, subscribeToRun } from '../../lib/leadSearchApi';
import { useCockpit } from '../../state/cockpit';
import { leadSearchContext, useDemo } from '../../state/demo';

export type ConfigState =
  | { status: 'loading'; config: null }
  | { status: 'ready'; config: LeadSearchConfig }
  | { status: 'offline'; config: null };

interface LeadSearchContextValue {
  config: ConfigState;
  reloadConfig: () => void;
  /** Konfiguration still neu laden (ohne Ladezustand) und den LinkedIn-Account frisch prüfen. */
  refreshConfig: () => Promise<void>;
  /** Startet einen Lauf. Wirft ApiError mit verständlicher Meldung. */
  start: (profile: SearchProfile) => Promise<void>;
  cancel: () => Promise<void>;
  /** Schritt 5: qualifizierte Leads in den Tagesstapel (gespeichert, sobald du weiterarbeitest). Gibt die Anzahl zurück. */
  handoff: () => Promise<number>;
  /**
   * Lead von Hand qualifizieren. Vor der Übergabe geht er dann mit; war der Lauf schon übergeben (z. B. automatische
   * Suche), wird er sofort angelegt (`placed`: liegt danach im Cockpit). Wirft ApiError mit deutscher Meldung.
   */
  qualify: (leadId: string) => Promise<{ placed: boolean }>;
  /** Tracking-Liste hochladen bzw. entfernen – aktualisiert die Konfiguration. */
  uploadTracking: (file: File) => Promise<TrackingSummary>;
  removeTracking: () => Promise<void>;
}

const LeadSearchContext = createContext<LeadSearchContextValue | null>(null);

export function useLeadSearch() {
  const context = useContext(LeadSearchContext);
  if (!context) throw new Error('useLeadSearch muss innerhalb von LeadSearchProvider verwendet werden');
  return context;
}

/** Verbindung zum Backend: Konfiguration laden und den laufenden Lauf live mitverfolgen – auch auf anderen Seiten. */
export function LeadSearchProvider({ children }: { children: ReactNode }) {
  const { state, dispatch } = useDemo();
  const { scheduleHandoff, commitHandoff, reload } = useCockpit();
  const [config, setConfig] = useState<ConfigState>({ status: 'loading', config: null });
  const run = state.leadSearch.run;
  const activeRunId = run?.status === 'running' ? run.id : null;

  const reloadConfig = useCallback(() => {
    setConfig({ status: 'loading', config: null });
    leadSearchApi
      .config()
      .then((loaded) => setConfig({ status: 'ready', config: loaded }))
      .catch(() => setConfig({ status: 'offline', config: null }));
  }, []);

  useEffect(reloadConfig, [reloadConfig]);

  const refreshConfig = useCallback(async () => {
    try {
      const loaded = await leadSearchApi.config(true);
      setConfig({ status: 'ready', config: loaded });
    } catch {
      setConfig({ status: 'offline', config: null });
    }
  }, []);

  useEffect(() => {
    if (!activeRunId) return;
    return subscribeToRun(activeRunId, {
      onEvent: (event) => {
        switch (event.type) {
          case 'run':
          case 'end':
            dispatch({ type: 'LS_RUN', run: event.run });
            break;
          case 'phase':
            dispatch({ type: 'LS_PHASE', runId: activeRunId, phase: event.phase });
            break;
          case 'leads':
            dispatch({ type: 'LS_LEADS', runId: activeRunId, leads: event.leads });
            break;
        }
      },
      onLost: () =>
        dispatch({
          type: 'LS_CONNECTION_LOST',
          runId: activeRunId,
          error: {
            code: 'network',
            title: 'Verbindung zum Backend verloren',
            message: 'Der Lauf ist auf dem Server nicht mehr verfügbar – vermutlich wurde das Backend neu gestartet. Starte die Suche einfach neu.',
          },
        }),
    });
  }, [activeRunId, dispatch]);

  // Der Server hat die Leads am Ende des Laufs schon gespeichert (`run.saved`, 25.10.): sofort als übergeben zeigen –
  // kein Klick „In den Tagesstapel“, kein Rückgängig-Fenster mehr, in dem ein Neuladen die Leads verlor.
  const savedRun = run && run.status !== 'running' && run.saved ? run : null;
  const lastHandoffRunId = state.leadSearch.lastHandoff?.runId ?? null;
  const founder = state.founder;
  useEffect(() => {
    if (!savedRun?.saved || lastHandoffRunId === savedRun.id) return;
    const { created, skipped } = savedRun.saved;
    dispatch({ type: 'LS_HANDOFF', runId: savedRun.id, count: created.length + skipped.length });
    dispatch({
      type: 'LS_HANDOFF_SAVED',
      runId: savedRun.id,
      created: created.filter((entry) => entry.owner === founder).map((entry) => entry.leadId),
      createdOthers: created.filter((entry) => entry.owner !== founder).map((entry) => ({ owner: entry.owner })),
      skipped: skipped.map((entry) => ({ owner: entry.owner })),
    });
    void reload();
  }, [savedRun, lastHandoffRunId, founder, dispatch, reload]);

  const start = useCallback(
    async (profile: SearchProfile) => {
      // Eine noch nicht gespeicherte Übergabe zuerst speichern – sonst wären ihre Leads im neuen Lauf keine Dubletten.
      const pending = state.leadSearch.lastHandoff;
      if (pending && pending.status !== 'saved' && pending.status !== 'failed') await commitHandoff(pending.runId);
      try {
        const started = await leadSearchApi.start({ profile, ...leadSearchContext(state) });
        dispatch({ type: 'LS_RUN', run: started });
      } catch (error) {
        // Läuft schon eine Suche (z. B. nach Neuladen der Seite oder „Demo zurücksetzen“), wird sie übernommen.
        if (error instanceof ApiError && error.code === 'busy' && error.runId) {
          dispatch({ type: 'LS_RUN', run: await leadSearchApi.get(error.runId) });
          return;
        }
        throw error;
      }
    },
    [state, dispatch, commitHandoff],
  );

  const cancel = useCallback(async () => {
    if (!run || run.status !== 'running') return;
    try {
      await leadSearchApi.cancel(run.id);
    } catch (error) {
      // Lauf existiert nicht mehr → lokal beenden, damit die Oberfläche nicht hängen bleibt.
      if (error instanceof ApiError && error.status === 404) {
        dispatch({ type: 'LS_RUN', run: { ...run, status: 'cancelled', finishedAt: Date.now() } });
      } else throw error;
    }
  }, [run, dispatch]);

  const handoff = useCallback(async () => {
    if (!run) return 0;
    const result = await leadSearchApi.handoff(run.id);
    // Gespeichert wird erst beim Weiterarbeiten (bis dahin geht „Rückgängig“) – siehe CockpitProvider.
    scheduleHandoff(run.id, result.leads);
    return result.leads.length;
  }, [run, scheduleHandoff]);

  const qualify = useCallback(
    async (leadId: string) => {
      if (!run) return { placed: false };
      const result = await leadSearchApi.qualify(run.id, leadId);
      dispatch({ type: 'LS_RUN', run: result.run });
      if (!result.run.handedOff) return { placed: false };
      await leadsApi.create({ cards: [result.card], owner: state.founder ?? undefined });
      await reload();
      return { placed: true };
    },
    [run, dispatch, state.founder, reload],
  );

  const setTracking = useCallback((tracking: TrackingSummary | null) => {
    setConfig((current) => (current.status === 'ready' ? { status: 'ready', config: { ...current.config, tracking } } : current));
  }, []);

  const uploadTracking = useCallback(
    async (file: File) => {
      const tracking = await leadSearchApi.uploadTracking(file);
      setTracking(tracking);
      return tracking;
    },
    [setTracking],
  );

  const removeTracking = useCallback(async () => {
    await leadSearchApi.removeTracking();
    setTracking(null);
  }, [setTracking]);

  return (
    <LeadSearchContext.Provider
      value={{ config, reloadConfig, refreshConfig, start, cancel, handoff, qualify, uploadTracking, removeTracking }}
    >
      {children}
    </LeadSearchContext.Provider>
  );
}
