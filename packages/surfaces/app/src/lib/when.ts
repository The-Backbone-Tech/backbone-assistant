// When something was last active, said the short way a list row has room for: "just now", "5 minutes
// ago", "yesterday", then the date. The app speaks English, so the words are English.
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function lastActive(at: string, now = Date.now()): string {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return relative.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return relative.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  if (days < 7) return relative.format(-days, 'day');
  const date = new Date(then);
  return date.toLocaleDateString('en', { day: 'numeric', month: 'short', ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) });
}
