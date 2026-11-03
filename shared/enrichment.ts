/**
 * Vertrag für die Anreicherung mit Firmendaten (`server/docs/SCORING.md` Abschnitt 7) – wird von Frontend (Vite) und
 * Backend (Node) importiert. Nur Typen, Konstanten und `import type` aus anderen Vertragsdateien.
 *
 * Quelle (`provider`, Entscheidung 05.10.2026): **Treg** (Standard) – Abruf je Firma über treg.to bei CompanyEnrich,
 * Ergebnis sofort (`done`/`failed` direkt in der Antwort, kein `pending`). Alternativ **Clay** (Webhook hin,
 * Rückkanal zurück, dazwischen `pending`). Der Ablauf unten beschreibt Clay; für die Oberfläche ist beides gleich.
 *
 * Clay ergänzt Firmendaten, die LinkedIn nicht liefert. Freigegebene Felder (Nutzer, 03.10.2026):
 * Mitarbeiterzahl, Umsatzschätzung, Tech-Stack der Website (u. a. Meta-Pixel, Google Tag Manager), Social-Links.
 * Kontaktdaten (E-Mail/Telefon) bewusst nicht – teuer und rechtlich erst zu prüfen.
 *
 * Ablauf: Das Backend schickt einen Lead an Clay (`pending`). Clay füllt die Felder und schickt sie an den Rückkanal
 * des Backends; dann `done`, der Score wird neu berechnet (Firmengröße, Online-Präsenz, Meta-Pixel) und im Verlauf
 * steht ein Ereignis `enriched`. Das dauert live Sekunden bis Minuten – die Oberfläche fragt den Lead neu ab.
 * Simulation: feste Beispielwerte je Firma, fertig nach ca. 1,5 s (MOCK_SPEED); Demo-Leads ab „Anfrage gesendet“
 * sind schon angereichert, Leads in „Neu“ nicht (zum Ausprobieren).
 *
 * Kosten: Jede Anfrage kostet Clay-Credits. Deshalb nur auf Knopfdruck oder automatisch für neue Leads mit Score
 * „Hoch“/„Mittel“ (`autoEnrich`), und höchstens `dailyLimit` Anfragen am Tag (UTC).
 *
 * Routen:
 *   GET  /api/enrichment/status         (mit Sitzung) → 200 EnrichmentStatusResponse
 *   POST /api/leads/:id/enrich          (mit Sitzung) → 202 LeadDetailResponse (`lead.enrichment.status` = pending,
 *                                       in der Simulation mit MOCK_SPEED=0 sofort done) · 404 not_found ·
 *                                       409 enrichment_off (Clay nicht eingerichtet) · 429 enrichment_limit
 *                                       (Tageslimit erreicht). Läuft schon eine Anfrage (pending, < 1 h), kommt
 *                                       der Lead unverändert zurück – keine zweite Anfrage, keine doppelten Credits.
 *   POST /api/enrichment/clay           Rückkanal für Clay, ohne Sitzung (`AUTH_OPEN_ROUTES`), mit geheimem Header –
 *                                       nicht für das Frontend.
 */

/** off = Clay nicht eingerichtet (live ohne Zugang) – der Knopf „Mit Clay anreichern“ wird nicht angeboten. */
export type EnrichmentMode = 'mock' | 'live' | 'off';

/** pending = an Clay geschickt, Ergebnis steht aus · done = Daten da · failed = Clay hat nichts geliefert/Fehler. */
export type EnrichmentState = 'pending' | 'done' | 'failed';

export const ENRICHMENT_STATE_LABELS: Record<EnrichmentState, string> = {
  pending: 'Wird angereichert …',
  done: 'Angereichert',
  failed: 'Anreicherung fehlgeschlagen',
};

/** Social-Profile der Firma (volle URL oder null). */
export interface CompanySocials {
  instagram: string | null;
  facebook: string | null;
  linkedin: string | null;
  youtube: string | null;
  tiktok: string | null;
  x: string | null;
}

export const SOCIAL_LABELS: Record<keyof CompanySocials, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  x: 'X',
};

/** Woher die Firmendaten kommen. */
export type EnrichmentProvider = 'treg' | 'clay';

export interface CompanyEnrichment {
  source: 'clay' | 'mock' | 'treg';
  status: EnrichmentState;
  requestedAt: number;
  /** Wann das Ergebnis kam (null solange pending). */
  receivedAt: number | null;
  /** Mitarbeiterzahl (bei einer Spanne die Mitte, gerundet) – fließt in die Firmengröße im Score. */
  employees: number | null;
  /** Wie von Clay geliefert, z. B. „11–50“ – zum Anzeigen. */
  employeesRange: string | null;
  /** Umsatzschätzung als Text, z. B. „1–5 Mio. €“ (oft ungenau, nur Anzeige). */
  revenue: string | null;
  /** Erkannte Werkzeuge auf der Website, z. B. „WordPress“, „Meta Pixel“. */
  techStack: string[];
  /** Meta-Pixel auf der Website: true/false; null = unbekannt. Fließt in die Meta-Ads-Einschätzung. */
  metaPixel: boolean | null;
  /** Google Tag Manager auf der Website; null = unbekannt. */
  googleTagManager: boolean | null;
  socials: CompanySocials;
  /** Nur bei failed: ein Satz, was schiefging. */
  error: string | null;
}

export interface EnrichmentStatusResponse {
  mode: EnrichmentMode;
  /** Eingestellte Quelle (live); in der Simulation die Quelle, die live gälte. */
  provider?: EnrichmentProvider;
  /** true: neue Leads mit Score „Hoch“/„Mittel“ gehen bei der Übergabe automatisch an Clay. */
  autoEnrich: boolean;
  /** Höchstens so viele Anfragen am Tag (UTC). */
  dailyLimit: number;
  usedToday: number;
}

/**
 * Fehlercodes der Anreicherung (`ApiErrorBody.error.code`), zusätzlich zu `not_found`/`invalid_request`:
 * - `enrichment_off` (409) – Clay ist nicht eingerichtet;
 * - `enrichment_limit` (429) – Tageslimit erreicht, Header `Retry-After` in Sekunden bis Mitternacht UTC.
 */
export type EnrichmentErrorCode = 'enrichment_off' | 'enrichment_limit';
