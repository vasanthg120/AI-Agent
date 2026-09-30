import { AsyncLocalStorage } from 'async_hooks';

// Which data source(s) the current request is reading. Set once per request by
// DataSourceScopeInterceptor and read by dataSourceScopePlugin on every CRM
// query, so isolation doesn't depend on each of the many dashboard/report
// services remembering to filter by source.

export type SelectionMode = 'default' | 'source' | 'unified';

export interface DataSourceScope {
  organizationId: string;
  mode: SelectionMode;
  // The sources this request may read. Unified = every active CRM source.
  sourceIds: string[];
  // Where records created during this request belong (the HaiVE workspace source).
  nativeSourceId: string;
}

const storage = new AsyncLocalStorage<DataSourceScope>();

export function runWithDataSourceScope<T>(scope: DataSourceScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentDataSourceScope(): DataSourceScope | undefined {
  return storage.getStore();
}

/** Runs `fn` with source scoping switched off — for the few internal reads
 * that must see every source (the data-source listing's own record counts,
 * backfills). */
export function withoutDataSourceScope<T>(fn: () => T): T {
  return storage.exit(fn);
}
