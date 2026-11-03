import type { AccountPrefsStore } from '../linkedin/accountPrefs.js';
import type { AccountUsage } from '../linkedin/accountUsage.js';
import type {
  EnrichedProfile,
  PrescreenVerdict,
  LeadSearchMode,
  LinkedinAccountStatus,
  MetaAdsCheck,
  NetworkDistance,
  RunErrorCode,
  SearchHit,
  SearchProfile,
} from '../../../shared/leadSearch.js';
import type { AuthFounderId } from '../../../shared/auth.js';
import type { SearchQueryMemory } from './searchMemory.js';

export interface RunContext {
  signal: AbortSignal;
  /** Für Logs: welcher Lauf gerade arbeitet. */
  runId: string;
  profile: SearchProfile;
  /**
   * Beispiele aus Rückmeldungen zur Lead-Qualität für den Prompt der KI (`shared/learning.ts`) – einmal je Lauf gelesen,
   * damit der Text über alle Leads des Laufs gleich bleibt (Prompt-Cache). null/fehlt = noch keine.
   */
  examples?: string | null;
}

export interface SearchOptions {
  /** So viele Treffer sollen es höchstens werden (Live: über mehrere Seiten). */
  maxHits: number;
  /**
   * Treffer erscheinen seitenweise – die Oberfläche kann sie schon zeigen, bevor die Suche fertig ist. `source` = Schlüssel
   * der Suchanfrage (Suchgedächtnis), damit der Runner ihr später den Ertrag gutschreiben kann.
   */
  onHits: (hits: SearchHit[], source?: string) => void;
  /** Suchgedächtnis (Cursor, Tiefe, Ertrag je Suchanfrage über alle Läufe) – ohne: jede Suche fängt vorne an. */
  memory?: SearchQueryMemory;
  /**
   * Provider-IDs, die schon geprüft sind (automatische Suche): Sie werden mitgeliefert (der Dubletten-Filter zeigt
   * sie), zählen aber nicht zu `maxHits` – die Suche blättert dafür weiter, höchstens bis zur Seitengrenze des Adapters.
   */
  skip?: ReadonlySet<string>;
}

export interface EnrichResult {
  profile: EnrichedProfile;
  /** Provider-ID laut Profil – bei Sales-Navigator-Treffern eine andere als die ID des Treffers. */
  providerId?: string | null;
  /** Öffentliche Kennung laut Profil – für einen zweiten Abgleich mit der Tracking-Liste. */
  publicIdentifier?: string | null;
  /** Was erst das Profil verrät: offene Anfrage oder bereits vernetzt. */
  pendingInvitation?: boolean;
  networkDistance?: NetworkDistance;
}

/**
 * Kontakte und gesendete, offene Vernetzungsanfragen eines weiteren Gründer-Accounts (nicht des Such-Accounts – dessen
 * Kontakte meldet schon Suche/Profil über `networkDistance`, dessen Anfragen `pendingInvitations`).
 * Kennungen klein geschrieben: Provider-IDs (ACoAA…) und öffentliche Kennungen.
 */
export interface FounderNetwork {
  founder: AuthFounderId;
  connected: ReadonlySet<string>;
  invited: ReadonlySet<string>;
  /** Gesetzt, wenn die Prüfung nicht möglich war (z. B. Account getrennt) – kurzer Grund auf Deutsch. */
  error: string | null;
}

export interface NetworkCheck {
  networks: FounderNetwork[];
  /** Hinweise zur Einrichtung (z. B. mehrere LinkedIn-Accounts, aber kein UNIPILE_ACCOUNT_ID) – für das Log. */
  warnings: string[];
}

/**
 * Gemeinsame Schnittstelle für Simulation und Live-Betrieb. Beide liefern dieselben Datenstrukturen;
 * die Reihenfolge der Schritte, der Dubletten-Filter und das Limit liegen im Runner – nicht im Adapter.
 */
export interface LeadSearchAdapter {
  readonly mode: LeadSearchMode;
  /** false = keine KI-Bewertung möglich (Live ohne ANTHROPIC_API_KEY) – Leads enden als „nicht bewertet“. */
  readonly canQualify: boolean;
  /** false = keine Prüfung der Meta-Werbebibliothek (Live ohne META_ACCESS_TOKEN) – Leads bekommen „nicht geprüft“. */
  readonly canCheckAds: boolean;
  /** Schritt 1: Suche nach dem Suchprofil (Region, Stichwörter, Positionen, nur 2./3. Grad). */
  search(profile: SearchProfile, options: SearchOptions, ctx: RunContext): Promise<SearchHit[]>;
  /** Für Schritt 2: Provider-IDs bzw. öffentliche Kennungen mit offener Vernetzungsanfrage. */
  pendingInvitations(ctx: RunContext): Promise<Set<string>>;
  /**
   * Für Schritt 2: Kontakte und offene Anfragen der übrigen Gründer-Accounts. Ein Lead ist nur neu, wenn er mit
   * keinem Gründer vernetzt ist und von keinem eine offene Anfrage hat. Wirft nur bei Abbruch.
   */
  founderNetworks?(ctx: RunContext): Promise<NetworkCheck>;
  /**
   * Schritt 2b: KI-Vorprüfung nur mit den Suchdaten (Name, Headline, Ort) – vor dem Profilabruf, kostet keine
   * LinkedIn-Aufrufe. Liefert je Provider-ID ein Urteil; fehlt eins, bleibt der Lead im Rennen. Fehler mit
   * `fatal: false` → der Runner überspringt die Vorprüfung für diese Treffer.
   */
  prescreen?(hits: SearchHit[], ctx: RunContext): Promise<Map<string, PrescreenVerdict>>;
  /** Pause vor jedem Profilabruf außer dem ersten (Live: zufällig 3–8 Sekunden). */
  pauseBeforeProfile(ctx: RunContext): Promise<void>;
  /** Schritt 3: Profil + Firma anreichern. */
  enrich(hit: SearchHit, ctx: RunContext): Promise<EnrichResult>;
  /**
   * Schritt 4: KI-Qualifizierung. Liefert die Rohausgabe (JSON-Objekt) – geprüft und streng ausgewertet
   * wird sie im Runner, für beide Modi gleich (`parseQualification`).
   */
  qualify(hit: SearchHit, profile: EnrichedProfile, ctx: RunContext): Promise<unknown>;
  /**
   * Schritt 4b: Schaltet die Firma gerade Meta-Ads? Nur für Leads, die die KI qualifiziert hat.
   * Fehler mit `fatal: false` betreffen nur den einen Lead – er bleibt qualifiziert, aber „nicht geprüft“.
   */
  checkMetaAds(hit: SearchHit, profile: EnrichedProfile, ctx: RunContext): Promise<MetaAdsCheck>;
  /** Kurze Pause im Dubletten-Filter, damit die Simulation sichtbar filtert (Live: 0). */
  dedupeDelay(ctx: RunContext): Promise<void>;
  /**
   * Nur Live: Ist bei Unipile ein LinkedIn-Account verbunden und startklar? Fragt nur die Account-Liste ab,
   * keine LinkedIn-Aktion. `refresh` umgeht den kurzen Zwischenspeicher.
   */
  accountStatus?(signal: AbortSignal, options?: { refresh?: boolean }): Promise<LinkedinAccountStatus>;
  /** Nur Live: Hinweise aus der letzten Account-Prüfung und dem letzten Lauf (für `/config` → `warnings`). */
  setupWarnings?(): string[];
  /**
   * Nur Live: So viele Profilabrufe gehen heute noch über alle Such-Accounts zusammen (feste Unipile-Limits,
   * `linkedin/accountUsage.ts`). Der Runner ruft höchstens so viele Profile ab; bei 0 startet der Lauf gar nicht erst.
   */
  profileCapacity?(ctx: RunContext): Promise<number>;
  /** Nur Live: dauerhafte Zähler je Account und Tag einsetzen (sonst zählt der Adapter nur im Speicher). */
  useAccountUsage?(usage: AccountUsage): void;
  /** Einstellungen je Account (Reihenfolge, eigene Grenzen) – nur Live. */
  useAccountPrefs?(prefs: AccountPrefsStore): void;
}

/**
 * Fehler eines Adapters. `fatal` = Lauf sofort abbrechen (Limit, Zugang, Konfiguration);
 * sonst betrifft der Fehler nur den einen Lead und der Lauf geht weiter.
 */
export class AdapterError extends Error {
  constructor(
    readonly code: RunErrorCode,
    readonly title: string,
    message: string,
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Lauf abgebrochen');
    this.name = 'CancelledError';
  }
}
