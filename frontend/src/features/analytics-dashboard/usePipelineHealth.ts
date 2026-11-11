import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { analyticsDashboardService } from '@/services/analyticsDashboardService';

// Pipeline Health for the period (GET /analytics-dashboard/pipeline-health):
// one aggregate the Pipeline & Quotes card and the Overview's Pipeline box
// share — the same query key, so it is fetched once. "Past due" is measured
// against the viewer's own date.
export function usePipelineHealth(dateFrom: string, dateTo: string, storeId?: string) {
  const today = dayjs().format('YYYY-MM-DD');
  return useQuery({
    queryKey: ['analytics-pipeline-health', dateFrom, dateTo, storeId, today],
    queryFn: () => analyticsDashboardService.getPipelineHealth(dateFrom, dateTo, today, storeId),
    staleTime: 30_000,
  });
}
