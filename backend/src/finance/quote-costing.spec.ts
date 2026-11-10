import { computeQuoteCosting, type CostingDocumentInput } from './quote-costing';

const at = (day: number) => new Date(Date.UTC(2026, 10, day));

const doc = (id: string, overrides: Partial<CostingDocumentInput> = {}): CostingDocumentInput => ({
  id,
  vendorName: `Vendor ${id}`,
  invoiceNumber: `INV-${id}`,
  originalFilename: `${id}.pdf`,
  paymentAmount: 1000,
  taxAmount: 0,
  currency: 'INR',
  extractionStatus: 'completed',
  paymentStatus: 'pending',
  createdAt: at(1),
  ...overrides,
});

describe('computeQuoteCosting', () => {
  it('adds up every vendor document and works out profit, margin and markup (quote 118)', () => {
    const { lines, totals } = computeQuoteCosting({ quoteAmount: 237707, currency: 'INR' }, [
      doc('hashtag', { vendorName: 'Hashtag Brands', paymentAmount: 45006, taxAmount: 5635.8 }),
      doc('brandwagon', { vendorName: 'BRANDWAGON', paymentAmount: 34751, taxAmount: 5301 }),
    ]);
    expect(lines.every((l) => l.included)).toBe(true);
    expect(totals).toEqual({
      quoteAmount: 237707,
      currency: 'INR',
      vendorCost: 79757,
      vendorTax: 10936.8,
      profit: 157950,
      marginPct: 66.4,
      markupPct: 198,
      includedCount: 2,
      excludedCount: 0,
    });
  });

  it('leaves out documents that cannot be counted, each with its reason', () => {
    const { lines, totals } = computeQuoteCosting({ quoteAmount: 10000, currency: 'INR' }, [
      doc('ok', { paymentAmount: 4000 }),
      doc('reading', { extractionStatus: 'processing', paymentAmount: 0 }),
      doc('unreadable', { extractionStatus: 'failed', paymentAmount: 0 }),
      doc('cancelled', { paymentStatus: 'cancelled', paymentAmount: 999 }),
      doc('dollars', { currency: 'USD', paymentAmount: 50 }),
    ]);
    expect(lines.map((l) => [l.documentId, l.included, l.excludedReason])).toEqual([
      ['ok', true, undefined],
      ['reading', false, 'processing'],
      ['unreadable', false, 'extraction_failed'],
      ['cancelled', false, 'cancelled'],
      ['dollars', false, 'currency_mismatch'],
    ]);
    expect(totals.vendorCost).toBe(4000);
    expect(totals.profit).toBe(6000);
    expect(totals.includedCount).toBe(1);
    expect(totals.excludedCount).toBe(4);
  });

  it('counts a bill uploaded twice once, keeping the earliest upload whatever the order given', () => {
    const { lines, totals } = computeQuoteCosting({ quoteAmount: 10000, currency: 'INR' }, [
      doc('second', { vendorName: 'Brandwagon', invoiceNumber: 'PIBW-2627305', paymentAmount: 3000, createdAt: at(5) }),
      doc('first', { vendorName: 'BRANDWAGON', invoiceNumber: 'PIBW2627305', paymentAmount: 3000, createdAt: at(2) }),
    ]);
    expect(lines).toEqual([
      { documentId: 'second', included: false, excludedReason: 'duplicate', duplicateOfDocumentId: 'first' },
      { documentId: 'first', included: true },
    ]);
    expect(totals.vendorCost).toBe(3000);
  });

  it('treats the same invoice number from two different vendors as two bills', () => {
    const { totals } = computeQuoteCosting({ quoteAmount: 10000, currency: 'INR' }, [
      doc('a', { vendorName: 'Printer', invoiceNumber: '101', paymentAmount: 2000 }),
      doc('b', { vendorName: 'Courier', invoiceNumber: '101', paymentAmount: 500 }),
    ]);
    expect(totals.vendorCost).toBe(2500);
    expect(totals.includedCount).toBe(2);
  });

  it('without an invoice number, the same file name and amount is the same bill', () => {
    const { lines } = computeQuoteCosting({ quoteAmount: 10000, currency: 'INR' }, [
      doc('a', { invoiceNumber: undefined, originalFilename: 'Receipt.JPG', paymentAmount: 750, createdAt: at(1) }),
      doc('b', { invoiceNumber: undefined, originalFilename: 'receipt.jpg', paymentAmount: 750, createdAt: at(2) }),
      doc('c', { invoiceNumber: undefined, originalFilename: 'receipt.jpg', paymentAmount: 900, createdAt: at(3) }),
    ]);
    expect(lines.map((l) => l.excludedReason)).toEqual([undefined, 'duplicate', undefined]);
  });

  it('a quote with no vendor costs yet: all profit, no markup', () => {
    const { totals } = computeQuoteCosting({ quoteAmount: 5000, currency: 'AUD' }, []);
    expect(totals).toMatchObject({ vendorCost: 0, profit: 5000, marginPct: 100, markupPct: null, includedCount: 0, currency: 'AUD' });
  });

  it('shows a loss as negative profit and margin, and no margin on a zero quote', () => {
    expect(computeQuoteCosting({ quoteAmount: 1000, currency: 'INR' }, [doc('x', { paymentAmount: 1500 })]).totals).toMatchObject({
      profit: -500,
      marginPct: -50,
      markupPct: -33.3,
    });
    expect(computeQuoteCosting({ quoteAmount: 0, currency: 'INR' }, [doc('x', { paymentAmount: 100 })]).totals.marginPct).toBeNull();
  });

  it('keeps sums to the paisa/cent, without floating-point noise', () => {
    const { totals } = computeQuoteCosting({ quoteAmount: 1000.3, currency: 'INR' }, [
      doc('a', { paymentAmount: 0.1 }),
      doc('b', { paymentAmount: 0.2 }),
    ]);
    expect(totals.vendorCost).toBe(0.3);
    expect(totals.profit).toBe(1000);
  });
});
