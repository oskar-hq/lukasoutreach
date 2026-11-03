const integer = new Intl.NumberFormat('de-DE');
const oneDecimal = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const shortDate = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });
const weekdayDate = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });

export const formatInt = (value: number) => integer.format(value);
export const formatPercent = (ratio: number) => `${oneDecimal.format(ratio * 100)} %`;
export const formatShortDate = (ts: number) => shortDate.format(ts);
export const formatWeekdayDate = (ts: number) => weekdayDate.format(ts);

/** Kalenderwoche nach ISO 8601. */
export function isoWeek(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const firstThursday = new Date(date.getFullYear(), 0, 4);
  return 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
}
