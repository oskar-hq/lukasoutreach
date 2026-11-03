const timeFormat = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
const longDateFormat = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function formatTime(ts: number): string {
  return timeFormat.format(ts);
}

export function formatLongDate(ts: number): string {
  return longDateFormat.format(ts);
}

/** „Heute, 09:14“ · „Gestern, 17:02“ · „Mo., 28. Sept., 10:30“ */
export function formatDateTime(ts: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (days === 0) return `Heute, ${formatTime(ts)}`;
  if (days === 1) return `Gestern, ${formatTime(ts)}`;
  return `${dateFormat.format(ts)}, ${formatTime(ts)}`;
}

/** „gerade eben“ · „vor 5 Min.“ · „vor 3 Std.“ · „vor 1 Tag“ · „vor 4 Tagen“ */
export function formatRelative(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'gerade eben';
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'vor 1 Tag' : `vor ${days} Tagen`;
}

export function greetingForTime(ts = Date.now()): string {
  const hour = new Date(ts).getHours();
  if (hour < 11) return 'Guten Morgen';
  if (hour < 18) return 'Guten Tag';
  return 'Guten Abend';
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} Sek.`;
  return `${minutes}:${String(seconds).padStart(2, '0')} Min.`;
}
