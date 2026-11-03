/**
 * Vertrag für den Tagesstapel (Roadmap Phase 5) – wird von Frontend (Vite) und Backend (Node) importiert.
 * Nur Typen, Konstanten und `import type` aus anderen Vertragsdateien.
 *
 * Das Backend berechnet aus den Leads in der Datenbank (`shared/leads.ts`), was heute ansteht – in Simulation und
 * Live gleich (Simulation: aus den 30 Demo-Leads). Erledigt wird eine Aufgabe, indem das Frontend die passende
 * Aktion an `POST /api/leads/:id/events` meldet; beim nächsten Abruf ist sie weg oder hat sich verändert.
 *
 * Route (mit Sitzung):
 *   GET /api/tasks?owner=nick   → 200 TasksResponse
 *     owner: ohne Angabe der angemeldete Gründer; ohne Anmeldung (nur Übergang/Tests) alle.
 *
 * Regeln (Werte über Umgebungsvariablen änderbar, Standard in Klammern):
 *   - reply    – Lead hat geantwortet (Stufe `replied`), älteste Antwort zuerst. Nicht mehr fällig, sobald nach der
 *                letzten Antwort eine eigene Nachricht gesendet ist (direkt aus der Antwort-Karte) – bis zur nächsten.
 *   - followup – angeschrieben (`contacted`), seit `FOLLOWUP_AFTER_DAYS` (2) Tagen keine Antwort und noch nicht
 *                `MAX_FOLLOW_UPS` (3) Follow-ups gesendet. `followUpNumber` = welches Follow-up jetzt dran ist.
 *                Aktives Gespräch (25.10., `active`): hat der Lead je geantwortet und kam die letzte Nachricht von uns
 *                vor `FOLLOWUP_AFTER_DAYS` Tagen, steht er wieder hier – alle `FOLLOWUP_AFTER_DAYS` Tage, ohne
 *                Höchstzahl, bis er antwortet oder verloren ist (Termin ausgenommen).
 *   - first    – vernetzt (`connected`), Erstnachricht fehlt. Älteste Vernetzung zuerst.
 *   - lead     – neu (`new`), noch nicht angefragt. Höchstens `NEW_LEADS_PER_DAY` (20) je Gründer – das passt zum
 *                LinkedIn-Tageslimit; **heute schon gesendete Anfragen zählen mit** (nach jeder Anfrage rückt kein
 *                weiterer Lead nach). Heute aus der Lead-Suche übergebene Leads sind immer dabei, auch über dem
 *                Limit. Auswahl sonst nach Score, dabei rund 15 % bewusst aus der mittleren Stufe („Exploration“,
 *                damit das Scoring nicht nur sich selbst bestätigt); die Auswahl ist je Tag stabil.
 *                Der Anteil Kapitalanlage/Finanzdienstleister (Regler, Standard 50 %; bis 27.10. 70/30 mit Bauträgern) steckt in den automatischen Suchläufen
 *                (`shared/autoSearch.ts` → `AutoSearchFocus`), nicht in dieser Auswahl.
 *   - „Heute“ = Kalendertag in Ortszeit (`LINKEDIN_TIMEZONE`, Standard Europe/Berlin).
 *   - Übersprungene Leads (`snoozedUntil` in der Zukunft, `POST /api/leads/:id/snooze`) fehlen in allen Typen.
 *   - Wiedervorlage (22.10., `CockpitLead.followUpPlan`/`followUpDueAt`): Mit Plan in der Zukunft fehlt der Lead überall
 *     (auch unter „Braucht Aufmerksamkeit“) – der Workflow pausiert. Ist er fällig, steht er wieder da: angeschrieben,
 *     geantwortet (und schon beantwortet) oder Termin → `followup` (auch über `MAX_FOLLOW_UPS` hinaus, ohne Wartezeit),
 *     vernetzt → `first`, neu → `lead` (über dem Tageslimit). `reason` beginnt dann mit „Wiedervorlage“.
 *   - Reihenfolge der Typen: reply → followup → first → lead (wie `TYPE_ORDER` im Frontend).
 *
 * „Braucht Aufmerksamkeit“ (keine Aufgabe im Stapel, aber eine Liste für Board/Übersicht):
 *   - invite_stale    – Vernetzungsanfrage seit `INVITE_STALE_DAYS` (14) Tagen nicht angenommen;
 *   - followups_done  – alle Follow-ups gesendet, seit `FOLLOWUP_AFTER_DAYS` Tagen keine Antwort → verloren markieren
 *                       oder Wiedervorlage planen („in 2 Wochen noch einmal“)?
 *   - meeting_open    – Termin vereinbart, aber noch nicht an das CRM übergeben.
 *   - conversation_quiet – (bis 24.10.) Lead hat geantwortet, du hast zurückgeschrieben, seit `FOLLOWUP_AFTER_DAYS`
 *                       Tagen Ruhe. Seit 25.10. ist das ein `followup` mit `active` – der Wert bleibt im Typ.
 *
 * Pausiert (17.10.): Ist der LinkedIn-Account eines Gründers nicht verbunden, bekommt er keine Aufgaben
 * (`accountPaused`); seine neuen Leads übernimmt der andere Gründer im Rahmen seines Tageslimits (`adoptedFrom`).
 *
 * Aufgaben-IDs: `<leadId>:reply:<lastReplyAt>` (je Antwort eine neue Aufgabe, auch zweimal am selben Tag) ·
 * `<leadId>:followup:<n>` (Wiedervorlage: `<leadId>:followup:<n>:<followUpDueAt>`) · `<leadId>:first` · `<leadId>:lead`.
 */
import type { AuthFounderId } from './auth.js';
import type { CockpitLead } from './leads.js';

/** Typen im Tagesstapel – gleiche Werte wie `CardType` im Frontend. */
export const TASK_TYPES = ['reply', 'followup', 'first', 'lead'] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  reply: 'Antwort',
  followup: 'Follow-up',
  first: 'Erstnachricht',
  lead: 'Neuer Lead',
};

export interface DailyTask {
  /** Stabil je Lead, Typ und Stand, z. B. „<leadId>:followup:2“ (Format siehe Dateikopf). */
  id: string;
  type: TaskType;
  lead: CockpitLead;
  /** Seit wann fällig (ms) – Sortierung innerhalb eines Typs: älteste zuerst (bei `lead`: Score). */
  dueSince: number;
  /** Ein Satz für die Karte, z. B. „Keine Antwort seit 3 Tagen – Follow-up 2 von 3“. */
  reason: string;
  /** Nur bei `followup`: das wievielte Follow-up jetzt dran ist (1 … MAX_FOLLOW_UPS, bei Wiedervorlage auch mehr). */
  followUpNumber?: number;
  /** Nur bei `followup` (22.10.): fällige Wiedervorlage (`CockpitLead.followUpDueAt`) statt der normalen Follow-up-Regel. */
  resumed?: boolean;
  /**
   * Nur bei `followup` (25.10., Wunsch des Kunden): aktives Gespräch – der Lead hat mindestens einmal geantwortet, die
   * letzte Nachricht kam von uns und ist `followUpAfterDays` alt. Kommt alle `followUpAfterDays` Tage wieder, ohne
   * Höchstzahl, bis der Lead antwortet oder als verloren markiert ist. Keine Follow-up-Vorlage, eigener Text.
   */
  active?: boolean;
  /** Nur bei `lead`: true = über die Exploration ausgewählt (mittlerer Score). */
  exploration?: boolean;
  /**
   * Nur bei `lead` (17.10.): Lead eines Gründers, dessen LinkedIn-Account gerade nicht verbunden ist – übernommen in den
   * Stapel dieses Gründers, solange er heute noch Anfragen frei hat. `lead.owner` ist hier schon der übernehmende
   * Gründer (Account, Limit, Grußformel); in der Datenbank wird er es mit der Anfrage.
   */
  adoptedFrom?: AuthFounderId;
}

/** Text, solange der LinkedIn-Account eines Gründers nicht verbunden ist (`TasksResponse.accountPaused`). */
export const ACCOUNT_PAUSED_MESSAGE = 'Der LinkedIn-Account ist gerade nicht verbunden. Verbinde ihn bitte erneut, um weiterzuarbeiten.';

export type AttentionReason = 'invite_stale' | 'followups_done' | 'meeting_open' | 'conversation_quiet';

export const ATTENTION_LABELS: Record<AttentionReason, string> = {
  invite_stale: 'Anfrage nicht angenommen',
  followups_done: 'Alle Follow-ups ohne Antwort',
  meeting_open: 'Termin noch nicht übergeben',
  conversation_quiet: 'Gespräch eingeschlafen',
};

export interface AttentionItem {
  lead: CockpitLead;
  reason: AttentionReason;
  /** Ein Satz, z. B. „Anfrage seit 16 Tagen offen“. */
  detail: string;
  /** Tage seit dem auslösenden Ereignis. */
  days: number;
}

export interface TasksResponse {
  tasks: DailyTask[];
  /** Anzahl je Typ (für „3 Antworten · 5 neue Leads …“ auf der Startseite). */
  counts: Record<TaskType, number>;
  attention: AttentionItem[];
  /** Für wen berechnet (null = alle). */
  owner: AuthFounderId | null;
  generatedAt: number;
  /** Die verwendeten Regeln, damit die Oberfläche z. B. „Follow-up 2 von 3“ richtig anzeigt. */
  rules: {
    followUpAfterDays: number;
    maxFollowUps: number;
    newLeadsPerDay: number;
    inviteStaleDays: number;
    /** false = Notiz zur Vernetzungsanfrage ausgeschaltet (`INVITE_NOTE=off`), Anfragen gehen ohne Notiz. Fehlt = an. */
    inviteNote?: boolean;
    /**
     * Sperre (Wunsch des Nutzers 11.10.): höchstens so viele Vernetzungsanfragen je Gründer und Tag
     * (`LINKEDIN_INVITES_PER_DAY`, Standard 20) – auch von Hand eingetragene. Danach lehnt der Server weitere mit
     * 429 `invite_limit` ab. Fehlt bei älteren Backends.
     */
    invitesPerDay?: number;
    /**
     * Auf wie viele LinkedIn-Accounts sich die Anfragen verteilen (12.10., `LINKEDIN_ACCOUNT_FALLBACK`): 2 = Sperre gilt
     * je Account, zusammen also `invitesPerDay` × 2. Fehlt = 1.
     */
    inviteAccounts?: number;
  };
  /** Heute (Ortszeit) gesendete Vernetzungsanfragen je Gründer – zählen gegen `newLeadsPerDay`. */
  invitesToday?: Partial<Record<AuthFounderId, number>>;
  /**
   * Seit 12.10. (Wunsch des Nutzers, `LINKEDIN_ACCOUNT_FALLBACK`): Anfragen zählen je **LinkedIn-Account**, über den sie
   * gingen (`lead.linkedin.sentBy`, sonst der Besitzer). Ist der eigene Account voll, geht die nächste Anfrage über den
   * des anderen Gründers; `newLeadsPerDay` ist dann die Summe beider Accounts (z. B. 40).
   * `invitesByAccount`: heute je Account gesendet · `inviteVia`: über wessen Account die nächste Anfrage geht (null =
   * beide voll, gesperrt). Nur mit `owner`. Fehlen bei älteren Backends.
   */
  invitesByAccount?: Partial<Record<AuthFounderId, number>>;
  inviteVia?: AuthFounderId | null;
  /**
   * Seit 25.10. (Kundengespräch „27 von 20“), auch unter „Alle“: je **Lead-Besitzer**, über wessen Account seine nächste
   * Anfrage geht (null = gesperrt – Limit voll oder Account nicht verbunden). Die Karte „Neuer Lead“ fragt damit nach
   * `lead.owner` statt nach dem angemeldeten Gründer. `invitesByAccount` ist dann ebenfalls gesetzt.
   */
  inviteViaByOwner?: Partial<Record<AuthFounderId, AuthFounderId | null>>;
  /** Seit 25.10.: Tageslimit für Anfragen je Account (eigene Grenze am Account, sonst `rules.invitesPerDay`). */
  invitesPerDayByAccount?: Partial<Record<AuthFounderId, number>>;
  /**
   * Gründer, deren LinkedIn-Account gerade nicht verbunden ist (17.10., Wunsch des Nutzers): kein Account zugeordnet,
   * obwohl ein anderer Gründer einen hat, oder Unipile meldet ihn getrennt/gestört. Ihre Aufgaben (Anfragen, Chats)
   * sind pausiert – mit `owner` = dieser Gründer kommt ein leerer Stapel, die Oberfläche zeigt `ACCOUNT_PAUSED_MESSAGE`.
   * Ihre neuen Leads stehen als `adoptedFrom` im Stapel des anderen Gründers, solange dessen Tageslimit reicht.
   * Erstnachrichten, Follow-ups und Antworten warten. Fehlt oder leer = alle verbunden.
   */
  accountPaused?: AuthFounderId[];
}
