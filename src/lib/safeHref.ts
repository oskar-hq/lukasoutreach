/**
 * Adresse für `href` aus fremden Daten (Lead-Profil, Website, Werbebibliothek, CRM …): nur http(s). Alles andere –
 * `javascript:`, `data:`, `vbscript:` … – ergibt undefined, der Link wird dann nicht gesetzt (Sicherheitsprüfung
 * 08.10.; das Backend prüft beim Speichern zusätzlich). Ohne Schema („www.firma.de“) wird https:// ergänzt.
 */
export function safeHref(url: string | null | undefined): string | undefined {
  const text = url?.trim();
  if (!text) return undefined;
  // Mit Schema so lassen, ohne https:// davor. Danach entscheidet der URL-Parser des Browsers über das Schema.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : text.startsWith('//') ? null : `https://${text}`;
  if (!withScheme) return undefined;
  try {
    const parsed = new URL(withScheme);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? withScheme : undefined;
  } catch {
    return undefined;
  }
}
