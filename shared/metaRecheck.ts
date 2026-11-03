/**
 * Meta-Ads für alle Leads nachprüfen (Wunsch des Nutzers 15.10.): Leads, die vor dem Meta-Token gesucht wurden, haben
 * nur „Meta-Ads nicht geprüft“. Die Nachprüfung fragt die Meta-Werbebibliothek für jeden Lead im Cockpit ab – nach
 * dem Firmennamen (und der Website) und nach dem privaten Namen der Person – und speichert das Ergebnis am Lead
 * (`CockpitLead.metaAds`, Score und Lead-Typ neu gerechnet). Von Hand eingetragene Stände (`metaAds.manual`) und
 * verlorene Leads bleiben unberührt.
 *
 * Routen:
 *   GET  /api/settings/meta-recheck  → MetaRecheckStatus
 *   POST /api/settings/meta-recheck  → 202 MetaRecheckStatus · 409 running (läuft schon) · 400 config (kein Meta-Token)
 *                                      · 403 not_allowed (Mitarbeiter, wie alle Einstellungen)
 *
 * Startet auch von selbst, sobald unter Einstellungen ein Meta-Token eingetragen oder geändert wird. Meldet Meta ein
 * Limit, wartet die Nachprüfung (`waiting`, `resumeAt`) und macht danach weiter, wo sie war.
 */

export type MetaRecheckState = 'idle' | 'running' | 'waiting' | 'done' | 'failed';

export interface MetaRecheckStatus {
  state: MetaRecheckState;
  /** Leads, die geprüft werden (ohne von Hand eingetragene und verlorene). */
  total: number;
  /** Davon schon geprüft (auch ohne Ergebnis). */
  checked: number;
  /** Ergebnisse bisher: schalten gerade · früher geschaltet · keine Anzeigen · nicht prüfbar (z. B. ohne Firma, Fehler). */
  active: number;
  stopped: number;
  none: number;
  unchecked: number;
  /** Davon über den privaten Namen der Person gefunden. */
  byPerson: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Bei `waiting`: ab wann es weitergeht (Meta-Limit). */
  resumeAt: number | null;
  /** Ein Satz auf Deutsch, z. B. warum gestoppt wurde. */
  message: string | null;
}

export const META_RECHECK_IDLE: MetaRecheckStatus = {
  state: 'idle',
  total: 0,
  checked: 0,
  active: 0,
  stopped: 0,
  none: 0,
  unchecked: 0,
  byPerson: 0,
  startedAt: null,
  finishedAt: null,
  resumeAt: null,
  message: null,
};
