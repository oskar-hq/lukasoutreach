/**
 * Vertrag für die Übergabe heißer Leads an das CRM (Roadmap Phase 6) – Close (close.com). Wird von Frontend (Vite)
 * und Backend (Node) importiert. Nur Typen und Konstanten.
 *
 * Ablauf: Hat ein Lead geantwortet bzw. einen Termin (Stufe `replied` oder `meeting`), übergibt ihn der Gründer mit
 * einem Klick. Das Backend legt in Close einen Lead an (Firma, Website, Ansprechpartner mit Position und LinkedIn-Link,
 * Kurzbeschreibung) und hängt eine Notiz mit Einschätzung, Score und dem Nachrichtenverlauf an. Danach steht der Lead
 * im Cockpit auf „Übergeben“ (Ereignis `handed_over`, Titel „An Close übergeben“), `lead.crm` enthält die Close-ID.
 * Schlägt nur die Notiz fehl, ist der Lead trotzdem übergeben (Titel „… – Notiz fehlt“).
 *
 * Modus: Simulation (`LEAD_SEARCH_MODE=mock`) → `mock` (kein Netz, Close-ID „mock-close-…“). Live mit `CLOSE_API_KEY`
 * → `live`. Live ohne Schlüssel → `off` (Knopf ausblenden bzw. wie bisher nur „Übergeben“ eintragen).
 *
 * Routen (mit Sitzung):
 *   GET  /api/crm/status                 → 200 CrmStatusResponse
 *   POST /api/leads/:id/handover         HandoverRequest → 200 LeadDetailResponse (Stufe handed_over, `lead.crm`)
 *        409 crm_off · 409 invalid_transition (Stufe passt nicht) · 502 crm_auth (Schlüssel ungültig) ·
 *        429 crm_rate_limited (Header Retry-After) · 503 crm_unavailable (Close nicht erreichbar) · 404 not_found.
 *        Mit `clientId` wie bei `/events`: Wiederholung → 200 mit `duplicate: true`, nichts doppelt in Close.
 */

export type CrmProvider = 'close';
export type CrmMode = 'mock' | 'live' | 'off';

export interface CrmStatusResponse {
  provider: CrmProvider;
  mode: CrmMode;
  /**
   * Übergabe an Close überhaupt anbieten (Einstellung `CRM_HANDOVER`, Wunsch des Nutzers 22.10.: wir arbeiten mit dem
   * CRM im Cockpit). false = Knöpfe „An Close übergeben“/„Übergabe eintragen“ ausblenden, `POST …/handover` → 409
   * crm_off. Standard: aus im echten Betrieb, an in der Simulation. Fehlt bei älteren Backends (dann wie true).
   */
  handover?: boolean;
}

/** Am Lead (`CockpitLead.crm`), sobald übergeben. */
export interface LeadCrmState {
  provider: CrmProvider;
  /** ID des Leads in Close (z. B. „lead_…“). */
  externalId: string;
  /** Link zum Lead in Close, falls Close einen liefert; sonst null. */
  url: string | null;
  handedOverAt: number;
}

export interface HandoverRequest {
  /** Zusätzliche Notiz des Gründers für Close (z. B. „Termin Do. 10 Uhr“), höchstens 2000 Zeichen. */
  note?: string;
  /** Kennung gegen doppelte Übergabe (1–64 Zeichen). */
  clientId?: string;
}

export type CrmErrorCode = 'crm_off' | 'crm_auth' | 'crm_rate_limited' | 'crm_unavailable';

export const HANDOVER_NOTE_MAX_LENGTH = 2000;
