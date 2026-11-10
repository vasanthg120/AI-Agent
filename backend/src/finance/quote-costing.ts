// Quote costing: what one customer quote earns once every vendor document
// linked to it (invoices, receipts, shipping bills…) is paid for.
//
//   profit  = quote amount − vendor cost
//   margin  = profit ÷ quote amount × 100
//   markup  = profit ÷ vendor cost × 100
//
// Amounts are compared as written on both documents, GST included: quotes in
// HaiVE store only a total (no tax split), so that is the only like-for-like
// basis. The vendor documents' own GST is summed separately, for reference.
//
// One source of truth for Finance AI's quote costing and Vendor
// Profitability's per-quote rows, so the two can never disagree.

import type { FinanceDocumentDocument } from './schemas/finance-document.schema';

export type CostingExclusion = 'processing' | 'extraction_failed' | 'cancelled' | 'currency_mismatch' | 'duplicate';

export interface CostingQuoteInput {
  quoteAmount: number;
  currency: string;
}

export interface CostingDocumentInput {
  id: string;
  vendorName?: string;
  invoiceNumber?: string;
  originalFilename: string;
  paymentAmount: number;
  taxAmount?: number;
  currency: string;
  extractionStatus: 'processing' | 'completed' | 'failed';
  paymentStatus: string;
  createdAt?: Date;
}

export interface CostingLine {
  documentId: string;
  included: boolean;
  excludedReason?: CostingExclusion;
  // Set with excludedReason 'duplicate': the earlier upload that is counted instead.
  duplicateOfDocumentId?: string;
}

export interface QuoteCostingTotals {
  quoteAmount: number;
  currency: string;
  vendorCost: number;
  vendorTax: number;
  profit: number;
  marginPct: number | null;
  markupPct: number | null;
  includedCount: number;
  excludedCount: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;
const norm = (s?: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The same bill uploaded twice must never be paid for twice. Same vendor +
// same invoice number is the same bill; without an invoice number, the same
// file name with the same amount is.
function duplicateKey(doc: CostingDocumentInput): string {
  const invoice = norm(doc.invoiceNumber);
  if (invoice) return `invoice:${norm(doc.vendorName)}:${invoice}`;
  return `file:${doc.originalFilename.trim().toLowerCase()}:${round2(doc.paymentAmount ?? 0)}`;
}

/**
 * Lines come back in the order the documents were given. The earliest upload
 * of a duplicate is the one counted, whatever that order.
 */
export function computeQuoteCosting(
  quote: CostingQuoteInput,
  documents: CostingDocumentInput[],
): { lines: CostingLine[]; totals: QuoteCostingTotals } {
  const byUploadTime = [...documents].sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
  const firstByKey = new Map<string, string>();
  const lineById = new Map<string, CostingLine>();

  let vendorCost = 0;
  let vendorTax = 0;
  for (const doc of byUploadTime) {
    let excludedReason: CostingExclusion | undefined;
    let duplicateOfDocumentId: string | undefined;

    if (doc.paymentStatus === 'cancelled') excludedReason = 'cancelled';
    else if (doc.extractionStatus === 'processing') excludedReason = 'processing';
    else if (doc.extractionStatus === 'failed') excludedReason = 'extraction_failed';
    else if (doc.currency !== quote.currency) excludedReason = 'currency_mismatch';
    else {
      const key = duplicateKey(doc);
      const first = firstByKey.get(key);
      if (first) {
        excludedReason = 'duplicate';
        duplicateOfDocumentId = first;
      } else {
        firstByKey.set(key, doc.id);
      }
    }

    if (!excludedReason) {
      vendorCost += doc.paymentAmount ?? 0;
      vendorTax += doc.taxAmount ?? 0;
    }
    lineById.set(doc.id, {
      documentId: doc.id,
      included: !excludedReason,
      ...(excludedReason ? { excludedReason } : {}),
      ...(duplicateOfDocumentId ? { duplicateOfDocumentId } : {}),
    });
  }

  vendorCost = round2(vendorCost);
  const quoteAmount = round2(quote.quoteAmount ?? 0);
  const profit = round2(quoteAmount - vendorCost);
  const lines = documents.map((d) => lineById.get(d.id)!);
  const includedCount = lines.filter((l) => l.included).length;

  return {
    lines,
    totals: {
      quoteAmount,
      currency: quote.currency,
      vendorCost,
      vendorTax: round2(vendorTax),
      profit,
      marginPct: quoteAmount > 0 ? round1((profit / quoteAmount) * 100) : null,
      markupPct: vendorCost > 0 ? round1((profit / vendorCost) * 100) : null,
      includedCount,
      excludedCount: lines.length - includedCount,
    },
  };
}

export function costingInputFrom(d: FinanceDocumentDocument): CostingDocumentInput {
  return {
    id: d._id.toString(),
    vendorName: d.vendorName,
    invoiceNumber: d.invoiceNumber,
    originalFilename: d.originalFilename,
    paymentAmount: d.paymentAmount ?? 0,
    taxAmount: d.taxAmount ?? 0,
    currency: d.currency,
    extractionStatus: d.extractionStatus,
    paymentStatus: d.paymentStatus,
    createdAt: (d as unknown as { createdAt?: Date }).createdAt,
  };
}
