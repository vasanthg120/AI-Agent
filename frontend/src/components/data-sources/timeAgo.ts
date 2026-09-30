/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function timeAgo(iso: string | undefined): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  const days = Math.round(seconds / 86_400);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
