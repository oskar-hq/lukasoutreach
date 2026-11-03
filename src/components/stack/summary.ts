import type { CardState, CardType, Decision } from '../../state/types';

export const TYPE_LABELS: Record<CardType, { one: string; many: string }> = {
  reply: { one: 'Antwort', many: 'Antworten' },
  followup: { one: 'Follow-up', many: 'Follow-ups' },
  first: { one: 'Erstnachricht', many: 'Erstnachrichten' },
  lead: { one: 'neuer Lead', many: 'neue Leads' },
};

export const TYPE_ORDER: CardType[] = ['reply', 'followup', 'first', 'lead'];

export function typeLabel(type: CardType, count: number): string {
  return count === 1 ? TYPE_LABELS[type].one : TYPE_LABELS[type].many;
}

/** Tageszusammenfassung aus den erledigten Karten eines Gründers. */
export function daySummary(cards: CardState[]) {
  const done = cards.filter((card) => card.status === 'done');
  const count = (decision: Decision, type?: CardType) =>
    done.filter((card) => card.decision === decision && (!type || card.type === type)).length;
  const times = done.map((card) => card.decidedAt ?? 0).filter(Boolean);
  const duration = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
  return {
    done: done.length,
    duration,
    /** Alle gesendeten Nachrichten: Erstnachrichten, Follow-ups und Antworten. */
    messages: count('send'),
    stats: [
      { label: 'Vernetzungsanfragen', value: count('connect') },
      { label: 'Erstnachrichten', value: count('send', 'first') },
      { label: 'Follow-ups', value: count('send', 'followup') },
      { label: 'Übergaben an Close', value: count('export') },
      { label: 'Aussortiert', value: count('reject') },
      { label: 'Kein Interesse', value: count('discard') },
      { label: 'Übersprungen', value: count('skip') },
    ],
  };
}
