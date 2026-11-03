import type { MetaAdsCheck } from '../../shared/leadSearch';

export type FounderId = 'nick' | 'johannes';

/** Pipeline-Stufe eines Leads = Typ der Karte, die heute im Stapel liegt. */
export type CardType = 'reply' | 'followup' | 'first' | 'lead';

// Typen der Demo-Daten in `src/data/` (nur noch Quelle des Demo-Seeds im Backend).
export type FitCategory = 'kapitalanlage' | 'bautraeger' | 'makler' | 'hausverwaltung';

export type Signal =
  | { type: 'meta_ads'; detail: string }
  | { type: 'hiring'; role: string }
  | { type: 'search'; detail: string };

export type TemplateId = 'A' | 'B' | 'C';
export type FollowUpVariant = 'A' | 'B' | 'C' | 'custom';

export type ReplyTone = 'positive' | 'question' | 'negative';

export interface ReplyAssessment {
  label: string;
  tone: ReplyTone;
  reason: string;
}

export interface LeadReply {
  text: string;
  /** Wie viele Stunden vor Demo-Start die Antwort einging. */
  hoursAgo: number;
}

export interface Lead {
  id: string;
  firstName: string;
  lastName: string;
  position: string;
  company: string;
  industry: string;
  region: string;
  owner: FounderId;
  fit: FitCategory;
  fitReason: string;
  summary: string;
  signal: Signal;
  /** Stufe zu Demo-Beginn. */
  stage: CardType;
  /** Template der Erstnachricht (bereits gesendet bzw. vorgeschlagen). */
  template?: TemplateId;
  /** Bereits gesendete Follow-ups (Variante je Stufe). */
  followUps?: Exclude<FollowUpVariant, 'custom'>[];
  /** Tage seit der letzten eigenen Nachricht (Follow-up-Karten). */
  daysSilent?: number;
  replies?: LeadReply[];
  replyAssessment?: ReplyAssessment;
  /** KI-Zusammenfassung des Verlaufs für den Close-Export. */
  closeSummary?: string;
  nextStep?: string;
  /** Kommt erst per simuliertem Slack-Ping in den Stapel. */
  arrivesViaPing?: boolean;
  /** LinkedIn-/Provider-ID – Schlüssel für den Dubletten-Abgleich der Lead-Suche. */
  providerId?: string;
  /** Gesetzt, wenn der Lead über die Lead-Suche in den Stapel kam. */
  source?: LeadSource;
}

export interface LeadSource {
  kind: 'search';
  /** Stand in der Meta-Werbebibliothek zum Zeitpunkt der Suche. */
  metaAds: MetaAdsCheck | null;
  runId: string;
  mode: 'mock' | 'live';
  confidence: number;
  headline: string;
  profileUrl: string | null;
  website: string | null;
  importedAt: number;
}

export interface Message {
  id: string;
  from: 'founder' | 'lead';
  founder?: FounderId;
  text: string;
  at: number;
  label?: string;
}

export type TimelineKind =
  | 'scraped'
  | 'assessed'
  | 'connection_sent'
  | 'connection_accepted'
  | 'message_sent'
  | 'message_received'
  | 'rejected'
  | 'skipped'
  | 'exported'
  | 'discarded';

export interface TimelineEvent {
  id: string;
  kind: TimelineKind;
  at: number;
  title: string;
  detail?: string;
  by?: FounderId;
  /** Ereignis entstand in dieser Demo-Sitzung. */
  live?: boolean;
}

/** `reply_logged`: Antwort von LinkedIn eingetragen · `meeting`: Termin vereinbart. */
export type Decision = 'connect' | 'reject' | 'send' | 'skip' | 'export' | 'discard' | 'reply_logged' | 'meeting';

export interface CardState {
  id: string;
  leadId: string;
  type: CardType;
  owner: FounderId;
  status: 'pending' | 'done';
  /** false = noch nicht eingetroffen (Slack-Ping). */
  available: boolean;
  decision?: Decision;
  decidedAt?: number;
}

export type StackFilter = 'all' | CardType;
/** home = ruhige Übersicht, focus = eine Aufgabe pro Bildschirm, search = Lead-Suche, dashboard = Kennzahlen */
export type View = 'home' | 'focus' | 'search' | 'leads' | 'chats' | 'assistant' | 'dashboard' | 'settings' | 'accounts';
