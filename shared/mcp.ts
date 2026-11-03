/**
 * Vertrag für den MCP-Server (Wunsch des Nutzers 22.10.): Die Claude-App (claude.ai, Desktop, Handy) bindet das Cockpit
 * als eigenen Connector ein und kann damit alles lesen (wie der KI-Assistent, `assistant.ts`) und das Cockpit bedienen:
 * Aufgaben von heute abarbeiten, Anfragen und Nachrichten senden, Antworten eintragen, Termine, Wiedervorlagen, Verloren.
 * Jede Aktion läuft über dieselben Routen wie die Oberfläche – mit den Rechten des verbundenen Kontos, allen Tageslimits,
 * Arbeitszeiten und Pausen. Wird von Frontend (Vite) und Backend (Node) importiert.
 *
 * Verbinden: In der Claude-App unter Einstellungen → Connectors einen eigenen Connector mit `<Cockpit-Adresse>/mcp`
 * anlegen. Claude meldet sich per OAuth 2.1 an (dynamische Client-Registrierung, PKCE S256):
 *   GET  /.well-known/oauth-protected-resource(/mcp)  Metadaten der Ressource (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server      Metadaten des Anmeldeservers (RFC 8414)
 *   POST /api/oauth/register                          Client registrieren (RFC 7591) → 201
 *   GET  /api/oauth/authorize                         → 302 auf `/?mcp_consent=<id>` (Freigabe im Cockpit, mit Anmeldung)
 *   POST /api/oauth/token                             authorization_code (mit PKCE) bzw. refresh_token → Tokens
 *   POST /mcp                                         MCP (Streamable HTTP), `Authorization: Bearer <token>` · 401 mit
 *                                                     `WWW-Authenticate: Bearer resource_metadata="…"`
 *
 * Freigabe und Verbindungen (mit Sitzung):
 *   GET    /api/oauth/consent/:id      → 200 McpConsentInfo · 404 not_found (abgelaufen)
 *   POST   /api/oauth/consent/:id      McpConsentDecision → 200 { redirect } – dorthin weiterleiten (zurück zu Claude)
 *   GET    /api/mcp/connections        → 200 McpConnectionsResponse (eigene Verbindungen, Adresse zum Eintragen)
 *   DELETE /api/mcp/connections/:id    → 200 { ok: true } – Verbindung trennen (Token sofort ungültig)
 *
 * Lead-Links in Antworten des MCP-Servers: `<Cockpit-Adresse>/?lead=<id>` öffnet den Lead im Cockpit (`MCP_LEAD_PARAM`).
 */

export interface McpConsentInfo {
  /** Name, unter dem sich der Client registriert hat (z. B. „Claude“). */
  clientName: string;
  /** Wohin nach der Freigabe zurückgeleitet wird (nur der Host, zur Anzeige). */
  redirectHost: string;
}

export interface McpConsentDecision {
  approve: boolean;
}

export interface McpConsentResult {
  /** Zurück zum Client – mit Code bzw. `error=access_denied`. */
  redirect: string;
}

export interface McpConnection {
  id: string;
  clientName: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface McpConnectionsResponse {
  /** Adresse für den Connector in der Claude-App. */
  url: string;
  connections: McpConnection[];
}

/** Query-Parameter der Freigabeseite bzw. der Lead-Links. */
export const MCP_CONSENT_PARAM = 'mcp_consent';
export const MCP_LEAD_PARAM = 'lead';
