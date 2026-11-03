/**
 * Getippte Antworten je Lead (Antwort-Karte). Schreibt der Lead ein zweites Mal, bekommt die Aufgabe eine neue ID –
 * die neue Karte übernimmt dann den angefangenen Text. Nur im Speicher dieses Tabs (nicht im Reducer, damit nicht
 * jeder Tastendruck das ganze Cockpit neu zeichnet); beim Gründer- oder Kontowechsel geleert.
 */
const drafts = new Map<string, string>();

export const replyDrafts = {
  get: (leadId: string): string | undefined => drafts.get(leadId),
  set: (leadId: string, text: string) => {
    if (text.trim()) drafts.set(leadId, text);
    else drafts.delete(leadId);
  },
  delete: (leadId: string) => drafts.delete(leadId),
  clear: () => drafts.clear(),
};
