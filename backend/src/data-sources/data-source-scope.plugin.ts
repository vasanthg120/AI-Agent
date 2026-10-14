import type { PipelineStage, Query, Schema } from 'mongoose';
import { currentDataSourceScope } from './data-source-context';

// Mongoose plugin for the CRM record schemas (deals, quotes, contacts,
// accounts). While a request has a data-source scope (see
// DataSourceScopeInterceptor), every read of these collections for that
// request's organization is limited to the selected source(s) — so a
// dashboard, report or list built on them shows one CRM's data, never a silent
// mix of two. It covers every reader at once, including ones written later.
//
// Deliberately left alone:
//  - lookups by _id (opening a specific record the user already has a link to),
//  - queries for a different organization (platform-admin tooling),
//  - queries that already say which data source they want,
//  - writes — records get their source from whoever creates them.

const READ_OPS = ['find', 'findOne', 'countDocuments', 'distinct'] as const;

type Filter = Record<string, unknown>;

/** The extra condition for `filter` under the current scope, or null. */
export function sourceCondition(filter: Filter): Filter | null {
  const scope = currentDataSourceScope();
  if (!scope) return null;
  if (filter.organizationId !== scope.organizationId) return null;
  if ('_id' in filter || 'dataSourceId' in filter) return null;
  const inSelected = { dataSourceId: { $in: scope.sourceIds } };
  // A record with no source tag was created in HaiVE outside a user request
  // (a background job); it belongs to the HaiVE workspace source.
  return scope.sourceIds.includes(scope.nativeSourceId) ? { $or: [inSelected, { dataSourceId: { $exists: false } }] } : inSelected;
}

// Appended with $and, never merged in, so a query's own $or/$and survive intact.
function withCondition(filter: Filter, condition: Filter): Filter {
  const existing = Array.isArray(filter.$and) ? (filter.$and as Filter[]) : [];
  return { ...filter, $and: [...existing, condition] };
}

export function dataSourceScopePlugin(schema: Schema): void {
  for (const op of READ_OPS) {
    schema.pre(op, function (this: Query<unknown, unknown>) {
      const filter = this.getFilter() as Filter;
      const condition = sourceCondition(filter);
      if (condition) this.setQuery(withCondition(filter, condition));
    });
  }

  schema.pre('aggregate', function () {
    const pipeline = this.pipeline() as PipelineStage[];
    const first = pipeline[0] as PipelineStage.Match | undefined;
    if (!first || !('$match' in first)) return;
    const condition = sourceCondition(first.$match as Filter);
    if (condition) first.$match = withCondition(first.$match as Filter, condition);
  });

  // Records created during a user's request (a deal added in HaiVE, a quote
  // built in the quote builder) belong to the HaiVE workspace source.
  schema.pre('save', function (this: { isNew: boolean; get(k: string): unknown; set(k: string, v: unknown): void }) {
    if (!this.isNew || this.get('dataSourceId')) return;
    const scope = currentDataSourceScope();
    if (scope && this.get('organizationId') === scope.organizationId) this.set('dataSourceId', scope.nativeSourceId);
  });
}
