import { FilterQuery } from 'mongoose';
import { FinanceDocument } from './schemas/finance-document.schema';
import { FinanceFilterQueryDto } from './dto/finance-filter-query.dto';

// Single place the Mongo match stage gets built from a FinanceFilterQueryDto
// — reused by finance-documents.service.ts's list/export and
// finance-dashboard.service.ts's aggregations, so filter semantics can
// never drift between the list/export/dashboard paths (same convention as
// crm/deal-filter.util.ts).
//
// `includeDateRange: false` is for trend widgets that generate their own
// date-bucketed axis (e.g. monthlyExpenseTrend) — those apply their own
// period window on top of this match rather than the user's dateFrom/dateTo.
export function buildFinanceMatchStage(
  organizationId: string,
  filters: FinanceFilterQueryDto,
  options?: { includeDateRange?: boolean },
): FilterQuery<FinanceDocument> {
  const includeDateRange = options?.includeDateRange ?? true;
  const match: FilterQuery<FinanceDocument> = { organizationId };

  if (filters.vendorName?.length) match.vendorName = { $in: filters.vendorName };
  if (filters.department?.length) match.department = { $in: filters.department };
  if (filters.costCenter?.length) match.costCenter = { $in: filters.costCenter };
  if (filters.paymentStatus?.length) match.paymentStatus = { $in: filters.paymentStatus };
  if (filters.paymentMethod?.length) match.paymentMethod = { $in: filters.paymentMethod };
  if (filters.expenseCategory?.length) match.expenseCategory = { $in: filters.expenseCategory };
  if (filters.reviewStatus) match.reviewStatus = filters.reviewStatus;
  if (filters.quoteLink === 'linked') match.quoteId = { $exists: true, $nin: [null, ''] };
  // { $in: [null] } also matches documents that have no quoteId at all.
  if (filters.quoteLink === 'unlinked') match.quoteId = { $in: [null, ''] };

  if (includeDateRange && (filters.dateFrom || filters.dateTo)) {
    match.invoiceDate = {
      ...(filters.dateFrom ? { $gte: filters.dateFrom } : {}),
      ...(filters.dateTo ? { $lte: filters.dateTo } : {}),
    };
  }

  if (filters.amountMin !== undefined || filters.amountMax !== undefined) {
    match.paymentAmount = {
      ...(filters.amountMin !== undefined ? { $gte: filters.amountMin } : {}),
      ...(filters.amountMax !== undefined ? { $lte: filters.amountMax } : {}),
    };
  }

  return match;
}
