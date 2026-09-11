import { FiFrown, FiMeh, FiSmile } from 'react-icons/fi';
import { Badge } from '@/components/ui';
import type { BadgeVariant } from '@/components/ui';

const SENTIMENT_CONFIG: Record<string, { variant: BadgeVariant; icon: typeof FiSmile; label: string }> = {
  positive: { variant: 'success', icon: FiSmile, label: 'Positive' },
  neutral: { variant: 'neutral', icon: FiMeh, label: 'Neutral' },
  negative: { variant: 'danger', icon: FiFrown, label: 'Negative' },
  mixed: { variant: 'warning', icon: FiMeh, label: 'Mixed' },
};

export function SentimentIndicator({ sentiment }: { sentiment: string | null }) {
  const config = sentiment ? SENTIMENT_CONFIG[sentiment] : undefined;
  if (!config) return <Badge variant="neutral">Sentiment: —</Badge>;
  const Icon = config.icon;
  return (
    <Badge variant={config.variant}>
      <Icon size={12} style={{ marginRight: 4 }} />
      {config.label}
    </Badge>
  );
}
