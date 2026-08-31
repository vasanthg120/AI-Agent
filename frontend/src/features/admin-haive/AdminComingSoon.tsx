import { SectionCard } from '@/components/ui';

// Placeholder for a route that's wired (guarded, navigable, in the sidebar)
// but whose real page hasn't landed yet in this delivery phase.
export function AdminComingSoon({ title }: { title: string }) {
  return (
    <SectionCard title={title}>
      <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>This section is being built out next.</p>
    </SectionCard>
  );
}
