import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { dataSourcesService, type MetricAvailability } from '@/services/dataSourcesService';
import { useAuthStore } from '@/stores/authStore';
import { useDataSourceStore, type DataSourceSelection } from '@/stores/dataSourceStore';

// The current data-source picture, for anything that shows CRM or email
// figures: which source is selected, where each metric comes from, and which
// ones the selected CRM can't provide (so they're labelled instead of zero).
export function useDataSources() {
  const queryClient = useQueryClient();
  const userId = useAuthStore((state) => state.user?.id);
  const selection = useDataSourceStore((state) => state.getSelection(userId));
  const setStoredSelection = useDataSourceStore((state) => state.setSelection);

  const query = useQuery({
    queryKey: ['data-sources', 'overview', selection],
    queryFn: dataSourcesService.getOverview,
    staleTime: 60_000,
    enabled: !!userId,
  });

  const metricsById = useMemo(() => new Map((query.data?.metrics ?? []).map((m) => [m.id, m])), [query.data]);
  const hidden = useMemo(() => new Set(query.data?.hiddenMetrics ?? []), [query.data]);

  const metric = useCallback((id: string): MetricAvailability | undefined => metricsById.get(id), [metricsById]);

  const selectedSources = useMemo(
    () => (query.data?.sources ?? []).filter((s) => query.data?.selection.sourceIds.includes(s.id)),
    [query.data],
  );

  /** Switches the whole app to another source. Every cached result is dropped
   * first, so nothing from the previous source can show for even a moment. */
  const setSelection = useCallback(
    (next: DataSourceSelection) => {
      if (!userId) return;
      queryClient.clear();
      setStoredSelection(userId, next);
    },
    [queryClient, setStoredSelection, userId],
  );

  return {
    ...query,
    selection,
    setSelection,
    metric,
    isHidden: (id: string) => hidden.has(id),
    selectedSources,
    // "Customized Haive CRM", "HubSpot + Zoho CRM (unified)", …
    selectionLabel:
      query.data?.selection.mode === 'unified'
        ? 'Unified view'
        : (selectedSources[0]?.label ?? (query.isLoading ? '' : 'No CRM')),
  };
}
