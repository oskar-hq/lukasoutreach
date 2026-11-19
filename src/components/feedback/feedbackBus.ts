/**
 * Feedback-Fenster von überall öffnen (Knopf oben, Glocke, Anzeigefehler) – ohne Context-Kette. `FeedbackHost`
 * hört zu. `prefill`: Text vorbelegen (z. B. die Meldung eines Anzeigefehlers).
 */
type Listener = (options: { prefill?: string }) => void;
const listeners = new Set<Listener>();

export function openFeedback(options: { prefill?: string } = {}): void {
  for (const listener of listeners) listener(options);
}

export function onOpenFeedback(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
