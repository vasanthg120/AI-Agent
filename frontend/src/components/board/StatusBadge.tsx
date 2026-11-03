import { Badge } from '@/components/ui';
// Same underlying CSS module Badge.tsx itself uses, so a custom-colored
// status badge shares its exact padding/radius/font — just with the color
// Badge's own fixed variant palette has no slot for.
import badgeStyles from '@/components/ui/Badge.module.css';

export interface StatusBadgeOption {
  key: string;
  label: string;
  color?: string;
}

// Renders a status whose label/color come from the org's own
// StatusDefinition customization (statusDefinitionsService) rather than a
// hard-coded variant — falls back to the raw key if the definition hasn't
// loaded yet, so a board never blanks out a cell while definitions fetch.
export function StatusBadge({ status, definitions }: { status?: string; definitions?: StatusBadgeOption[] }) {
  if (!status) return <Badge variant="neutral">—</Badge>;
  const def = definitions?.find((d) => d.key === status);
  if (!def?.color) return <Badge variant="neutral">{def?.label ?? status}</Badge>;
  return (
    <span
      className={badgeStyles.badge}
      style={{ background: `color-mix(in srgb, ${def.color} 16%, transparent)`, color: def.color }}
    >
      {def.label}
    </span>
  );
}
