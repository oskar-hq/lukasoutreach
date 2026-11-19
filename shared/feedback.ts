/**
 * Feedback vom Kunden (Wunsch des Nutzers 09.11.: „so angenehm und schnell wie möglich – und Claude weiß danach genau,
 * was zu tun ist“). Ein Knopf oben (neben der Glocke), ein Textfeld, fertig. Was Claude zum Nachvollziehen braucht,
 * kommt von selbst mit: Bildschirmfoto der Seite, Ansicht, offener Lead, die letzten Klicks, Fehler und gescheiterten
 * Anfragen, Gerät und Version. Ändert sich der Stand (in Arbeit, erledigt …), steht es in der Glocke des Melders.
 *
 *   POST  /api/feedback                     FeedbackCreateRequest → 201 FeedbackItem (alle angemeldeten Konten)
 *   GET   /api/feedback?status=&mine=1      → 200 FeedbackListResponse (Mitarbeiter sehen nur ihre eigenen)
 *   GET   /api/feedback/:id                 → 200 FeedbackItem
 *   GET   /api/feedback/:id/images/:n       → Bild (jpeg/png)
 *   PATCH /api/feedback/:id                 FeedbackUpdateRequest → 200 FeedbackItem (Gründer und Admin)
 *
 * In der Claude-App: `submit_feedback`, `list_feedback`, `feedback_detail` (mit Bildern), `update_feedback`.
 */

export const FEEDBACK_KINDS = ['bug', 'wish', 'question'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = {
  bug: 'Etwas geht nicht',
  wish: 'Idee / Wunsch',
  question: 'Frage',
};

export const FEEDBACK_STATUSES = ['new', 'planned', 'in_progress', 'done', 'declined'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  new: 'Eingegangen',
  planned: 'Eingeplant',
  in_progress: 'In Arbeit',
  done: 'Erledigt',
  declined: 'Nicht umgesetzt',
};

export const FEEDBACK_TEXT_MAX = 4000;
export const FEEDBACK_ANSWER_MAX = 2000;
/** Höchstens so viele Bilder (automatisches Bildschirmfoto + eigene). */
export const FEEDBACK_IMAGES_MAX = 4;
/** Je Bild höchstens (Bytes, nach dem Verkleinern im Browser). */
export const FEEDBACK_IMAGE_MAX_BYTES = 3_000_000;

/** Was die Oberfläche von selbst mitschickt – ohne Zutun des Kunden. */
export interface FeedbackContext {
  /** Ansicht (`home`, `focus`, `leads` …). */
  view: string | null;
  /** Gerade offener Lead (ID), sonst null. */
  leadId?: string | null;
  /** Adresse ohne Host. */
  path?: string | null;
  /** Letzte Schritte, älteste zuerst, z. B. „12:01:03 click start-lead (home)“. Höchstens 40. */
  trail?: string[];
  /** Fehler und gescheiterte Anfragen der letzten Minuten. */
  errors?: string[];
  /** Version der Oberfläche (Commit), falls bekannt. */
  version?: string | null;
  device?: { width: number; height: number; standalone: boolean; touch: boolean; userAgent: string } | null;
}

export interface FeedbackCreateRequest {
  /** Fehlt: das Backend nimmt `bug`, wenn Fehler im Kontext stehen, sonst `wish`. */
  kind?: FeedbackKind | null;
  text: string;
  context?: FeedbackContext;
  /** Bilder als data-URL (`data:image/jpeg;base64,…`), das erste ist meist das automatische Bildschirmfoto. */
  images?: string[];
}

export interface FeedbackItem {
  id: string;
  /** Laufende Nummer für Menschen („#12“). */
  number: number;
  createdAt: number;
  updatedAt: number;
  /** Anzeigename des Melders. */
  by: string;
  username: string;
  kind: FeedbackKind;
  text: string;
  status: FeedbackStatus;
  /** Antwort an den Melder (z. B. „Ist behoben, ab dem nächsten Update da“). */
  answer: string | null;
  imageCount: number;
  context: FeedbackContext | null;
}

export interface FeedbackListResponse {
  items: FeedbackItem[];
}

export interface FeedbackUpdateRequest {
  status?: FeedbackStatus;
  answer?: string | null;
}
