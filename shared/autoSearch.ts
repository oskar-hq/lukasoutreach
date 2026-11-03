/**
 * Vertrag „Automatische Lead-Suche“ (Wunsch des Nutzers 06.10.): Je Gründer ein Zeitplan, nach dem der Server die
 * Lead-Suche selbst startet. Gefundene, qualifizierte Leads landen ohne Klick im Tagesstapel dieses Gründers.
 * Ohne Imports außer Typen aus anderen Vertragsdateien (siehe `shared/CLAUDE.md`).
 *
 * Routen (Sitzung nötig; Rechte siehe unten):
 *   GET  /api/auto-search                  → 200 AutoSearchListResponse
 *   PUT  /api/auto-search/:founder         AutoSearchUpdate → 200 AutoSearchSchedule
 *                                          400 invalid_request (mit `field`: `AutoSearchField`) · 403 not_allowed ·
 *                                          404 not_found
 *   POST /api/auto-search/:founder/run     → 202 { runId } – „Jetzt einmal ausführen“ (gleicher Ablauf wie geplant)
 *                                          403 not_allowed · 409 busy (es läuft schon ein Lauf, `runId` im Fehler)
 *                                          400 config (Live-Modus nicht startklar, Satz wie bei `POST /api/lead-search/runs`)
 *
 * Rechte (`shared/auth.ts` → Rollen und Rechte): Gründer sehen und ändern nur ihren eigenen Zeitplan, Admins beide,
 * Mitarbeiter keinen (alle Routen → 403 not_allowed, wie Einstellungen). Lesen für fremde Gründer → 403.
 *
 * Ablauf eines geplanten Laufs (Backend):
 *   - Zeitzone fest `AUTO_SEARCH_TIME_ZONE`. Fällig ist ein Lauf am Wochentag aus `days` zur Uhrzeit `time` und – falls
 *     gesetzt – zusätzlich zur Uhrzeit `secondTime` (Minutengenau, Prüfung mindestens jede Minute). Läuft der Server zu der Zeit nicht, wird der Lauf nicht
 *     nachgeholt (`lastRun` bleibt, `nextRunAt` springt weiter).
 *   - Immer nur ein Lauf gleichzeitig (wie von Hand). Ist die Suche belegt, wartet der Lauf und versucht es jede Minute
 *     erneut, höchstens `AUTO_SEARCH_WAIT_MINUTES`; danach `skipped` mit Satz. Sind beide Gründer zur selben Zeit
 *     dran, laufen sie nacheinander.
 *   - Suchprofil = `profile` (dieselben Grenzen wie von Hand: `maxResults` 1–`MAX_RESULTS_LIMIT`, Pausen, Abbruch bei Limit-/Zugangs-
 *     fehlern). Dubletten wie von Hand (Datenbank, Tracking-Liste, offene Anfragen) und zusätzlich alle Profile, die
 *     eine frühere automatische Suche schon geprüft hat (Server merkt sie sich `AUTO_SEARCH_CHECKED_DAYS` Tage) –
 *     so kostet die tägliche Suche nicht jedes Mal dieselben Abrufe.
 *   - Nach dem Lauf: Übergabe wie `POST /api/lead-search/runs/:id/handoff` und Anlegen wie `POST /api/leads` mit
 *     `owner` = Gründer des Zeitplans. Ereignis „created“ mit `actor` = `AUTO_SEARCH_ACTOR`. Danach gelten die Regeln
 *     des Tagesstapels (`shared/tasks.ts`): heute übergebene Leads sind immer dabei.
 *   - **Anteil der Läufe** (Kundengespräch 27.10., vorher 70/30 Kapitalanlage/Bauträger): Jeder Lauf sucht gezielt EINE
 *     Zielgruppe (`AutoSearchFocus`). Die Läufe eines Gründers verteilen sich nach `kapitalanlagePercent` (Regler,
 *     Standard 50 = im Wechsel) auf Kapitalanlage-Vertriebe und Finanzdienstleister (`nextAutoSearchFocus`),
 *     Bauträger-Läufe gibt es nicht mehr. Die Stichwörter des Profils
 *     werden dafür aufgeteilt (`focusKeywords`): Finanz-Begriffe (Finanzdienstleister, Finanzvertrieb, Allfinanz …)
 *     für Finanzdienstleister-Läufe, die übrigen ohne Bauträger-Begriffe für Kapitalanlage-Läufe; fehlt eine Seite,
 *     gelten `AUTO_SEARCH_FOCUS_KEYWORDS`. Positionen, Region, Anzahl bleiben. Die Zählung begann am 27.10. neu.
 *   - **Tagesziel** (Wunsch des Nutzers 08.10., Onboarding): Mit `dailyTarget` = x sucht der Server an einem geplanten
 *     Tag so lange weiter, bis x qualifizierte Leads in den Tagesstapel übergeben sind – höchstens `maxRounds` = y Läufe
 *     an diesem Tag. Ablauf: Termin → Lauf 1; ist er `done` und am Tag des Termins (Zeitzone) sind weniger als x
 *     Leads übergeben und weniger als y Läufe gelaufen, startet nach `AUTO_SEARCH_FOLLOW_UP_PAUSE_MINUTES` Minuten
 *     Pause der nächste Lauf (wie ein Termin: wartet, wenn belegt, der Anteil gilt je Lauf). Kein Folgelauf, wenn der
 *     letzte Lauf kein ungeprüftes Profil mehr gefunden hat (Suche ausgeschöpft), nach 3 Läufen am Stück ohne neuen
 *     Lead (seit 11.10., vorher schon nach einem), wenn er mit Fehler oder Abbruch endete (z. B. LinkedIn-Limit), wenn
 *     alle LinkedIn-Accounts ihre Tagesgrenze erreicht haben (Lauf endet mit Fehler) oder der Tag des Termins vorbei ist.
 *     Gezählt wird immer für den Tag des Termins (auch wenn ein Lauf über Mitternacht geht). „Jetzt einmal
 *     ausführen“ zählt mit (Leads und Läufe) und sucht seit 22.10. (Wunsch des Nutzers) genauso bis zum Tagesziel
 *     weiter – auch bei ausgeschaltetem Zeitplan, Leads und Läufe gezählt ab dem Klick; `lastRun.manual` bleibt dabei
 *     true. Ohne `dailyTarget` (null) wie bisher genau ein Lauf je Termin bzw. Klick.
 *   - **Profilabrufe am Tag** bremsen nur die Grenzen je LinkedIn-Account (Einstellungen → LinkedIn-Accounts; gesucht
 *     wird reihum in der eingestellten Reihenfolge). Die gemeinsame Tagesgrenze `AUTO_SEARCH_PROFILES_PER_DAY` aus der
 *     Zeit mit einem Such-Account ist seit 31.10. raus (Wunsch des Nutzers) – sie bremste trotz freier Accounts.
 *   - Suche überspringt schon geprüfte Profile: Sie zählen nicht zur Trefferzahl, die Suche blättert dafür weiter
 *     (Obergrenze an Seiten bzw. Suchanfragen wie bisher).
 *   - Live-Modus nicht startklar → `failed` mit dem Satz aus der Konfigurationsprüfung, nichts wird gesucht.
 *   - Live ohne Anthropic-API-Schlüssel (auch in den Einstellungen nicht gesetzt) → geplante Läufe starten nicht
 *     (`skipped` mit Satz + Neuigkeit), sonst würden dieselben Profile jeden Tag unbewertet erneut abgerufen.
 *   - Bleiben die Leads eines Laufs überwiegend ohne KI-Bewertung (`failed`/`unrated`) und kommt kein Lead dazu →
 *     `failed` mit Satz „KI-Bewertung fehlgeschlagen …“ (Neuigkeit), keine Folgeläufe.
 *   - Neustart, während ein fälliger Termin noch wartet → beim Start `skipped` mit Satz (wird nicht nachgeholt).
 *   - Im Mock-Modus läuft alles genauso mit der Simulation (Trichter wie von Hand).
 *   - Der Lauf erscheint wie ein normaler Lauf (`GET /api/lead-search/runs/:id`, Events) – die Seite Lead-Suche zeigt
 *     ihn, wenn sie gerade offen ist, als laufende Suche.
 */
import type { AuthFounderId } from './auth.js';
import type { SearchProfile } from './leadSearch.js';

export const AUTO_SEARCH_TIME_ZONE = 'Europe/Berlin';
/** So lange wartet ein fälliger Lauf höchstens, wenn gerade eine andere Suche läuft. */
export const AUTO_SEARCH_WAIT_MINUTES = 30;
/** So lange merkt sich der Server Profile, die eine automatische Suche schon geprüft hat. */
export const AUTO_SEARCH_CHECKED_DAYS = 90;
/** Pause zwischen zwei Läufen für das Tagesziel (Folgeläufe). */
export const AUTO_SEARCH_FOLLOW_UP_PAUSE_MINUTES = 5;
/** `LeadEvent.actor` beim Anlegen durch die automatische Suche. */
export const AUTO_SEARCH_ACTOR = 'Automatische Suche';

/** Wochentage 1 = Montag … 7 = Sonntag (wie `workHours.days` in `shared/linkedin.ts`). */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Uhrzeit „HH:MM“, 24 Stunden, in `AUTO_SEARCH_TIME_ZONE`. */
export const AUTO_SEARCH_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export type AutoSearchRunStatus = 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';

/**
 * Zielgruppe eines automatischen Laufs. Seit 27.10. nur noch Kapitalanlage und Finanzdienstleister im Wechsel;
 * `bautraeger_projektentwickler` steht nur noch an älteren Läufen.
 */
export type AutoSearchFocus = 'kapitalanlage_vertrieb' | 'finanzdienstleister' | 'bautraeger_projektentwickler';

export const AUTO_SEARCH_FOCUS_LABELS: Record<AutoSearchFocus, string> = {
  kapitalanlage_vertrieb: 'Kapitalanlage-Vertriebe',
  finanzdienstleister: 'Finanzdienstleister',
  bautraeger_projektentwickler: 'Bauträger',
};

/**
 * Anteil der Kapitalanlage-Läufe in Prozent, der Rest Finanzdienstleister (Wunsch des Nutzers 27.10.: Regler unter
 * Einstellungen → Automatische Suche, je Gründer, `AutoSearchSchedule.kapitalanlagePercent`). Standard 50, in
 * 10er-Schritten. Bis 27.10. fest 70 % zu Bauträgern.
 */
export const AUTO_SEARCH_KAPITALANLAGE_PERCENT_DEFAULT = 50;
export const AUTO_SEARCH_KAPITALANLAGE_PERCENT_STEP = 10;

/** Stichwörter je Zielgruppe, wenn das Profil für eine Seite keine enthält. */
export const AUTO_SEARCH_FOCUS_KEYWORDS: Record<AutoSearchFocus, readonly string[]> = {
  kapitalanlage_vertrieb: ['Kapitalanlage', 'Kapitalanlageimmobilien', 'Immobilienvertrieb', 'Anlageimmobilien'],
  finanzdienstleister: ['Finanzdienstleister', 'Finanzdienstleistungen', 'Finanzvertrieb', 'Allfinanz'],
  bautraeger_projektentwickler: ['Bauträger', 'Projektentwicklung', 'Projektentwickler'],
};

/**
 * Bauträger-Begriffe: Bauträger, Bauunternehmen, Neubau, Bauprojekt, Projektentwicklung, Projektgesellschaft,
 * Real-Estate-/Property-Development, Immobilienentwicklung (nicht z. B. Vertriebsentwicklung, „Business Development“
 * oder „Projektvertrieb“ – das ist Vertrieb, also Kapitalanlage).
 * Nicht jedes „bau“: „Baufinanzierung“ oder „Aufbau Vertrieb“ gehören nicht zu den Bauträgern.
 */
const BAUTRAEGER_TERM =
  /bau(?:träger|traeger|unternehm|gesellschaft|herr|projekt)|neubau|wohnungsbau|hochbau|projektentwick|projektgesellschaft|immobilien.?develop|real.?estate.?develop|property.?develop|projekt.?develop|immobilienentwickl/i;
/** Enthält ein Begriff „Kapitalanlage“, gehört er immer zu Kapitalanlage – auch mit „bau“ (z. B. „Kapitalanlage Neubau“). */
const KAPITALANLAGE_TERM = /kapitalanlage/i;
/** Finanzdienstleister-Begriffe (27.10.): Finanzdienstleister, Finanzvertrieb, Finanzberatung, Allfinanz, Vermögensberatung, FDL. */
const FINANZ_TERM = /finanz(?:dienst|vertrieb|berat|plan|makler|service)|allfinanz|vermögensberat|vermoegensberat|versicherungsmakler|\bfdl\b|financial.?(?:services|advis|planning)/i;

/** Zielgruppe eines Stichworts; Kapitalanlage geht vor („Kapitalanlage Neubau“, „Kapitalanlage Finanzvertrieb“). */
export function focusOfTerm(term: string): AutoSearchFocus {
  if (KAPITALANLAGE_TERM.test(term)) return 'kapitalanlage_vertrieb';
  if (FINANZ_TERM.test(term)) return 'finanzdienstleister';
  if (BAUTRAEGER_TERM.test(term)) return 'bautraeger_projektentwickler';
  return 'kapitalanlage_vertrieb';
}

/**
 * Zielgruppe des nächsten Laufs: Kapitalanlage, solange deren Anteil an allen Läufen (einschließlich des nächsten)
 * unter `percent` aufgerundet liegt, sonst Finanzdienstleister – bei 50 % also im Wechsel, beginnend mit Kapitalanlage;
 * 100 % = nur Kapitalanlage, 0 % = nur Finanzdienstleister. Frühere Bauträger-Läufe zählen nicht. Ganzzahlig gerechnet.
 */
export function nextAutoSearchFocus(
  counts: Partial<Record<AutoSearchFocus, number>>,
  percent: number = AUTO_SEARCH_KAPITALANLAGE_PERCENT_DEFAULT,
): AutoSearchFocus {
  const share = Math.min(100, Math.max(0, Math.round(percent)));
  const kapitalanlage = counts.kapitalanlage_vertrieb ?? 0;
  const total = kapitalanlage + (counts.finanzdienstleister ?? 0) + 1;
  const wanted = Math.ceil((total * share) / 100);
  return kapitalanlage < wanted ? 'kapitalanlage_vertrieb' : 'finanzdienstleister';
}

/** Stichwörter des Profils für eine Zielgruppe (siehe Dateikopf). */
export function focusKeywords(keywords: readonly string[], focus: AutoSearchFocus): string[] {
  const own = keywords.filter((term) => focusOfTerm(term) === focus);
  return own.length ? own : [...AUTO_SEARCH_FOCUS_KEYWORDS[focus]];
}

export interface AutoSearchLastRun {
  /** Lauf-ID (bei `skipped` null – es wurde nichts gestartet). */
  runId: string | null;
  /** Geplanter Zeitpunkt bzw. Klick auf „Jetzt ausführen“ (ms). */
  startedAt: number;
  finishedAt: number | null;
  status: AutoSearchRunStatus;
  /** true = über „Jetzt einmal ausführen“ gestartet. */
  manual: boolean;
  /** Neu in den Tagesstapel übergebene Leads. */
  created: number;
  /** Fertiger deutscher Satz bei failed/skipped/cancelled, sonst null. */
  message: string | null;
  /** Zielgruppe dieses Laufs (fehlt bei älteren Läufen und bei `skipped`). */
  focus?: AutoSearchFocus;
  /** KI-Kosten dieses Laufs in Euro. Fehlt bei älteren Backends und bei `skipped`. */
  costEur?: number;
}

/** Grenzen und Standard des Tagesziels (siehe Dateikopf). */
export const AUTO_SEARCH_DAILY_TARGET_MAX = 100;
/** Bis 11.10. 10 – auf Wunsch des Nutzers praktisch unbegrenzt (mit 5 Minuten Pause passen kaum mehr Läufe in einen Tag). */
export const AUTO_SEARCH_MAX_ROUNDS_LIMIT = 100;
export const AUTO_SEARCH_DEFAULT_MAX_ROUNDS = 4;
/**
 * Tagesbudget für die KI in Euro (Wunsch des Nutzers 11.10.: „nicht nach so vielen Läufen abbrechen, sondern nach so
 * viel Geld“). Mit Budget sucht der Server an einem geplanten Tag weiter, bis das Tagesziel erreicht oder das Budget
 * aufgebraucht ist – `maxRounds` gilt dann nicht, nur die Obergrenze `AUTO_SEARCH_MAX_ROUNDS_LIMIT`. Ein laufender
 * Lauf liest keine weiteren Profile mehr, sobald das Budget erreicht ist (Rest: „beim nächsten Lauf dran“). Gezählt
 * werden die KI-Kosten der automatischen Läufe dieses Gründers (wie `DashboardResponse.aiCost`, Listenpreise).
 */
export const AUTO_SEARCH_DAILY_BUDGET_MIN = 0.5;
export const AUTO_SEARCH_DAILY_BUDGET_MAX = 1000;
export const AUTO_SEARCH_DEFAULT_DAILY_BUDGET_EUR = 10;

/** Stand des Tagesziels heute (Zeitzone `AUTO_SEARCH_TIME_ZONE`). */
export interface AutoSearchToday {
  /** Tag „YYYY-MM-DD“. */
  day: string;
  /** Heute übergebene Leads aus automatischen Läufen (auch „Jetzt ausführen“). */
  created: number;
  /** Heute gestartete automatische Läufe. */
  rounds: number;
  /** Heute verbrauchte KI-Kosten der automatischen Läufe in Euro. Fehlt bei älteren Backends. */
  costEur?: number;
  /**
   * Warum heute kein weiterer Lauf fürs Tagesziel kommt – ein Satz auf Deutsch („Tageslimit von 100 Profilabrufen
   * erreicht …“). null/fehlt = nicht gestoppt (Ziel offen und es geht weiter, oder kein Tagesziel). Wunsch des Nutzers
   * 13.10.: „er hat nicht genug Leads gefunden“ – ohne Grund war nicht zu sehen, was gebremst hat.
   */
  stopReason?: string | null;
  /** Heute verbrauchte Profilabrufe aller Läufe (beide Gründer, auch von Hand) – nur zur Info, keine Grenze. */
  profileFetches?: number;
  /** Veraltet (31.10.): gemeinsame Tagesgrenze gibt es nicht mehr – das Backend schickt das Feld nicht mehr. */
  profilesPerDay?: number;
}

export interface AutoSearchSchedule {
  founder: AuthFounderId;
  enabled: boolean;
  /** Mindestens ein Tag, wenn `enabled`. Sortiert, ohne Doppelte. */
  days: Weekday[];
  time: string;
  /**
   * Zweiter Termin am selben Tag „HH:MM“ (Wunsch des Kunden 11.10.: 2× am Tag automatisch) – null/fehlt = nur `time`.
   * Gilt an denselben Tagen; jeder Termin startet einen eigenen Lauf (Tagesziel und Folgeläufe zählen für den Tag).
   */
  secondTime?: string | null;
  profile: SearchProfile;
  /** Nächster geplanter Lauf (ms) – null, wenn aus. */
  nextRunAt: number | null;
  /**
   * Weiterer Lauf fürs Tagesziel ist eingereiht (Pause zwischen zwei Läufen, auch nach „Jetzt einmal ausführen“):
   * frühester Start in ms – liegt er schon in der Vergangenheit, wartet er auf eine andere Suche. null/fehlt = keiner
   * (Wunsch des Nutzers 22.10.: in der Pause war nicht zu sehen, dass die Suche noch weitermacht).
   */
  followUpAt?: number | null;
  /** true = der eingereihte Lauf gehört zu „Jetzt einmal ausführen“ (läuft auch bei ausgeschaltetem Zeitplan). */
  followUpManual?: boolean;
  lastRun: AutoSearchLastRun | null;
  /** Zielgruppe des nächsten Laufs (Anteil `kapitalanlagePercent`). */
  nextFocus?: AutoSearchFocus;
  /** Anteil der Kapitalanlage-Läufe in Prozent (Rest Finanzdienstleister), Standard 50. Fehlt bei älteren Backends. */
  kapitalanlagePercent?: number;
  /** Bisherige Läufe je Zielgruppe. */
  focusCounts?: Record<AutoSearchFocus, number>;
  /** Zuletzt geändert (ms) und von wem (Anzeigename) – null, solange nie gespeichert (Standardwerte). */
  updatedAt: number | null;
  updatedBy: string | null;
  /** Qualifizierte Leads pro geplantem Tag (null = ein Lauf je Termin). Fehlt bei älteren Backends. */
  dailyTarget?: number | null;
  /** Höchstens so viele Läufe pro Tag für das Tagesziel. Fehlt bei älteren Backends. */
  maxRounds?: number;
  /** Tagesbudget für die KI in Euro (null = ohne Budget, dann gilt `maxRounds`). Fehlt bei älteren Backends. */
  dailyBudgetEur?: number | null;
  /** Stand heute – null, solange heute nichts lief. */
  today?: AutoSearchToday | null;
}

export interface AutoSearchListResponse {
  /** Nur die Gründer, die das Konto sehen darf (Gründer: eigener, Admin: beide). Immer ein Eintrag je Gründer – ohne
   * gespeicherten Plan mit den Standardwerten (`AUTO_SEARCH_DEFAULTS`, aus). */
  schedules: AutoSearchSchedule[];
  timeZone: typeof AUTO_SEARCH_TIME_ZONE;
}

/**
 * Komplett ersetzen (kein Teil-Update) – außer `dailyTarget` und `maxRounds`: fehlen sie, bleiben die gespeicherten
 * Werte (ältere Oberflächen schicken sie nicht mit). `dailyTarget: null` schaltet das Tagesziel aus.
 */
export interface AutoSearchUpdate {
  enabled: boolean;
  days: Weekday[];
  time: string;
  /** Zweiter Termin „HH:MM“ oder null (aus). Fehlt er, bleibt der gespeicherte Wert (ältere Oberflächen). */
  secondTime?: string | null;
  profile: SearchProfile;
  /** 1–`AUTO_SEARCH_DAILY_TARGET_MAX` oder null. */
  dailyTarget?: number | null;
  /** 1–`AUTO_SEARCH_MAX_ROUNDS_LIMIT`, Standard `AUTO_SEARCH_DEFAULT_MAX_ROUNDS`. */
  maxRounds?: number;
  /**
   * `AUTO_SEARCH_DAILY_BUDGET_MIN`–`AUTO_SEARCH_DAILY_BUDGET_MAX` Euro (Cent genau) oder null (ohne Budget). Fehlt es,
   * bleibt der gespeicherte Wert.
   */
  dailyBudgetEur?: number | null;
  /**
   * Anteil der Kapitalanlage-Läufe 0–100 in Schritten von `AUTO_SEARCH_KAPITALANLAGE_PERCENT_STEP` (Rest
   * Finanzdienstleister). Fehlt er, bleibt der gespeicherte Wert (Standard 50).
   */
  kapitalanlagePercent?: number;
}

/** Standard für Gründer ohne gespeicherten Plan: werktags 7:00, aus. Profil = `DEFAULT_SEARCH_PROFILE`. */
export const AUTO_SEARCH_DEFAULTS: Omit<AutoSearchUpdate, 'profile'> = {
  enabled: false,
  days: [1, 2, 3, 4, 5],
  time: '07:00',
};

/** Feld, an dem ein Prüffehler hängt – auch `field` in 400-Antworten von `PUT /api/auto-search/:founder`. */
export type AutoSearchField =
  | 'enabled'
  | 'days'
  | 'time'
  | 'secondTime'
  | 'profile.keywords'
  | 'profile.positions'
  | 'profile.region'
  | 'profile.maxResults'
  | 'dailyTarget'
  | 'maxRounds'
  | 'dailyBudgetEur'
  | 'kapitalanlagePercent';

/** Grenzen des Suchprofils – dieselben wie beim Start von Hand (`POST /api/lead-search/runs`). */
export const AUTO_SEARCH_PROFILE_LIMITS = { terms: 20, termLength: 60, regionMin: 2, regionMax: 80, maxResults: 1000 } as const;

/** Prüfung wie im Backend – null oder `{ field, message }` (deutscher Satz). */
export function autoSearchProblem(update: AutoSearchUpdate): { field: AutoSearchField; message: string } | null {
  const limits = AUTO_SEARCH_PROFILE_LIMITS;
  if (!AUTO_SEARCH_TIME_PATTERN.test(update.time)) return { field: 'time', message: 'Bitte eine Uhrzeit wie 07:00 angeben.' };
  if (update.secondTime !== undefined && update.secondTime !== null) {
    if (!AUTO_SEARCH_TIME_PATTERN.test(update.secondTime)) return { field: 'secondTime', message: 'Bitte eine Uhrzeit wie 14:00 angeben.' };
    if (update.secondTime === update.time) return { field: 'secondTime', message: 'Der zweite Termin braucht eine andere Uhrzeit.' };
  }
  if (update.days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    return { field: 'days', message: 'Wochentage nur von Montag bis Sonntag.' };
  }
  if (update.enabled && update.days.length === 0) return { field: 'days', message: 'Wähle mindestens einen Tag.' };
  const target = update.dailyTarget;
  if (target !== undefined && target !== null && (!Number.isInteger(target) || target < 1 || target > AUTO_SEARCH_DAILY_TARGET_MAX)) {
    return { field: 'dailyTarget', message: `Pro Tag 1 bis ${AUTO_SEARCH_DAILY_TARGET_MAX} qualifizierte Leads.` };
  }
  const rounds = update.maxRounds;
  if (rounds !== undefined && (!Number.isInteger(rounds) || rounds < 1 || rounds > AUTO_SEARCH_MAX_ROUNDS_LIMIT)) {
    return { field: 'maxRounds', message: `Höchstens 1 bis ${AUTO_SEARCH_MAX_ROUNDS_LIMIT} Suchläufe pro Tag.` };
  }
  const budget = update.dailyBudgetEur;
  if (
    budget !== undefined &&
    budget !== null &&
    (!Number.isFinite(budget) || budget < AUTO_SEARCH_DAILY_BUDGET_MIN || budget > AUTO_SEARCH_DAILY_BUDGET_MAX || Math.abs(Math.round(budget * 100) - budget * 100) > 1e-6)
  ) {
    return { field: 'dailyBudgetEur', message: `Tagesbudget von ${AUTO_SEARCH_DAILY_BUDGET_MIN.toLocaleString('de-DE')} bis ${AUTO_SEARCH_DAILY_BUDGET_MAX} € (auf den Cent).` };
  }
  const percent = update.kapitalanlagePercent;
  if (percent !== undefined && (!Number.isInteger(percent) || percent < 0 || percent > 100 || percent % AUTO_SEARCH_KAPITALANLAGE_PERCENT_STEP !== 0)) {
    return { field: 'kapitalanlagePercent', message: `Anteil Kapitalanlage von 0 bis 100 % in ${AUTO_SEARCH_KAPITALANLAGE_PERCENT_STEP}er-Schritten.` };
  }
  const { keywords, positions, region, maxResults } = update.profile;
  const lists = [
    ['profile.keywords', keywords, 'Mindestens ein Stichwort.', 'Stichwörter'],
    ['profile.positions', positions, 'Mindestens eine Position.', 'Positionen'],
  ] as const;
  for (const [field, list, empty, name] of lists) {
    const terms = list.map((word) => word.trim()).filter(Boolean);
    if (terms.length === 0) return { field, message: empty };
    if (terms.length > limits.terms || terms.some((word) => word.length > limits.termLength)) {
      return { field, message: `Höchstens ${limits.terms} ${name} mit je höchstens ${limits.termLength} Zeichen.` };
    }
  }
  const place = region.trim();
  if (place.length < limits.regionMin || place.length > limits.regionMax) {
    return { field: 'profile.region', message: `Bitte eine Region angeben (${limits.regionMin} bis ${limits.regionMax} Zeichen).` };
  }
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > limits.maxResults) {
    return { field: 'profile.maxResults', message: `Pro Lauf 1 bis ${limits.maxResults} Profile.` };
  }
  return null;
}
