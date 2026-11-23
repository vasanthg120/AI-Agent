import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { PaymentEvents } from '../common/payments/payment-events';
import { IntegrationsService } from '../integrations/integrations.service';
import { ChatGateway } from '../chat/chat.gateway';
import { SquareReconciliationService } from '../square/square-reconciliation.service';
import { SquareService } from '../square/square.service';
import { CustomerDirectoryService } from './customer-directory.service';
import { QuotePaymentSummary } from './quote-payment-status';

/** What is stored on a quote (crm_quotes.paymentReconciliation) and read by the SalesBoard. A compact, display-ready
 * copy of the ONE calculation (quote-payment-status.ts) — never a second one. */
export interface StoredQuotePayment {
  status: QuotePaymentSummary['status'];
  quoteTotal: number;
  paidAmount: number;
  outstandingAmount: number;
  currency: string;
  basis: QuotePaymentSummary['basis'];
  verifiedPaid: number;
  reportedPaid: number;
  refundedAmount: number;
  sources: QuotePaymentSummary['sources'];
  gateway?: string;
  paymentMethod?: string;
  lastPaymentAt?: Date;
  transactionReference?: string;
  transactionIds: string[];
  crmReportedState?: string;
  crmReportedRaw?: string[];
  crmOutdated: boolean;
  crmUnverified: boolean;
  reconciledAt: Date;
  /** Hash of everything above except reconciledAt — a re-run that changes nothing writes nothing (idempotent). */
  signature: string;
}

export interface ReconciliationReport {
  organizationId: string;
  dryRun: boolean;
  paymentsScanned: number;
  paymentsLinkedToInvoice: number;
  paymentsLinkedToQuote: number;
  paymentsNotTiedToAQuote: number;
  paymentsNotMatchedToCustomer: number;
  quotesScanned: number;
  quotesUpdated: number;
  quotesWithPayments: number;
  paidQuotes: number;
  partiallyPaidQuotes: number;
  overpaidQuotes: number;
  unpaidQuotes: number;
  /** Quotes whose CRM said less than the verified payments (e.g. Hoops "Not Paid" but Square paid). */
  crmOutdatedQuotes: number;
  customersAffected: number;
  failures: { stage: string; error: string }[];
  /** Square's own historical pass (only for a historical run on an organization with Square connected). */
  square?: { count: number; invoiceLinked: number; withoutInvoice: number; failed: number };
}

function toStored(summary: QuotePaymentSummary, at: Date): StoredQuotePayment {
  const base = {
    status: summary.status,
    quoteTotal: summary.quoteTotal,
    paidAmount: summary.paidAmount,
    outstandingAmount: summary.outstandingAmount,
    currency: summary.currency,
    basis: summary.basis,
    verifiedPaid: summary.verifiedPaid,
    reportedPaid: summary.reportedPaid,
    refundedAmount: summary.refundedAmount,
    sources: summary.sources,
    ...(summary.gateway ? { gateway: summary.gateway } : {}),
    ...(summary.paymentMethod ? { paymentMethod: summary.paymentMethod } : {}),
    ...(summary.paymentDate ? { lastPaymentAt: summary.paymentDate } : {}),
    ...(summary.transactionReference ? { transactionReference: summary.transactionReference } : {}),
    transactionIds: summary.transactionIds,
    ...(summary.crmReported ? { crmReportedState: summary.crmReported.state, crmReportedRaw: summary.crmReported.raw } : {}),
    crmOutdated: summary.crmOutdated,
    crmUnverified: summary.crmUnverified,
  };
  return { ...base, reconciledAt: at, signature: JSON.stringify(base) };
}

/**
 * The single backend owner of "what has each quote really been paid". It does not calculate anything itself: the
 * Customers directory already derives every quote's payment from ALL registered payment sources through the one pure
 * calculation (quote-payment-status.ts); this service takes those very summaries, stores them on the quote (additive
 * field, SalesBoard reads it) and reports. So the Customers page and the SalesBoard can never disagree.
 *
 * Runs: on every change signal (gateway webhook/reconciliation, refund, recorded/voided payment, CRM sync — debounced
 * per organization), every 30 minutes for all organizations (catches the CRM syncs that write straight to the database),
 * and on demand / historically for one organization. Writes only `paymentReconciliation` on that organization's own
 * quotes — never a source CRM record, never paidAmount, the quote's status, owner, targets or revenue.
 */
@Injectable()
export class PaymentReconciliationService implements OnModuleInit {
  private readonly logger = new Logger(PaymentReconciliationService.name);
  private readonly running = new Map<string, Promise<ReconciliationReport>>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private static readonly DEBOUNCE_MS = 3_000;

  constructor(
    @InjectConnection() private connection: Connection,
    private directory: CustomerDirectoryService,
    private square: SquareReconciliationService,
    private integrations: IntegrationsService,
    @Optional() private events?: PaymentEvents,
    @Optional() private squareApi?: SquareService,
    @Optional() private chat?: ChatGateway,
  ) {}

  onModuleInit(): void {
    this.events?.subscribe((organizationId) => this.schedule(organizationId));
  }

  /** Coalesces a burst of signals (a webhook storm, a historical run) into one reconciliation per organization. */
  private schedule(organizationId: string): void {
    // Whatever the Customers page has cached is now stale: the next read must rebuild, even before the run below finishes.
    this.directory.invalidate(organizationId);
    if (this.pending.has(organizationId)) return;
    const timer = setTimeout(() => {
      this.pending.delete(organizationId);
      this.reconcileOrganization(organizationId).catch((err) => this.logger.error(`Payment reconciliation failed for org ${organizationId}: ${(err as Error).message}`));
    }, PaymentReconciliationService.DEBOUNCE_MS);
    timer.unref?.();
    this.pending.set(organizationId, timer);
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async reconcileAll(): Promise<void> {
    let organizationIds: string[] = [];
    try {
      organizationIds = (await this.connection.collection('crm_quotes').distinct('organizationId')).filter((id): id is string => typeof id === 'string' && !!id);
    } catch (err) {
      this.logger.error(`Could not list organizations for payment reconciliation: ${(err as Error).message}`);
      return;
    }
    for (const organizationId of organizationIds) {
      try {
        await this.reconcileOrganization(organizationId);
      } catch (err) {
        this.logger.error(`Payment reconciliation failed for org ${organizationId}: ${(err as Error).message}`);
      }
    }
  }

  /** Reconciles one organization. One run at a time per organization; a second caller shares the running one. */
  reconcileOrganization(organizationId: string, options: { dryRun?: boolean } = {}): Promise<ReconciliationReport> {
    const key = `${organizationId}:${options.dryRun ? 'dry' : 'live'}`;
    const active = this.running.get(key);
    if (active) return active;
    const run = this.run(organizationId, !!options.dryRun).finally(() => this.running.delete(key));
    this.running.set(key, run);
    return run;
  }

  /** The historical pass: re-reads the organization's FULL Square history (idempotent on provider payment id, writes
   * only Square's own transaction rows), then reconciles every quote. Only when Square is connected for THIS
   * organization; nothing for any other organization is read or changed. Failures are returned, never swallowed. */
  async reconcileHistory(organizationId: string): Promise<ReconciliationReport> {
    const failures: ReconciliationReport['failures'] = [];
    let squareResult: ReconciliationReport['square'];
    const connected = await this.integrations.listConnectedOrganizationIds('square').then((ids) => ids.includes(organizationId)).catch(() => false);
    if (connected) {
      try {
        squareResult = await this.square.initialSync(organizationId);
      } catch (err) {
        failures.push({ stage: 'square-history', error: (err as Error).message });
      }
    }
    const report = await this.reconcileOrganization(organizationId);
    return { ...report, failures: [...failures, ...report.failures], ...(squareResult ? { square: squareResult } : {}) };
  }

  /** Square Invoices payments carry no reference — the only exact link to a quote is the invoice that billed the payment's
   * order (its number/title, e.g. "4550 - Name"). Rows stored before that was resolved lack it, so the quote link could
   * never be made while the customer-level Gateway Payment total still counted them. This reads the organization's Square
   * invoices once (read-only on Square) and fills the invoice reference on its own stored rows, matched on order id —
   * an exact id, never an amount. Rows with no invoice are marked checked so they are not re-read every run. */
  private async backfillInvoiceLinks(organizationId: string, failures: ReconciliationReport['failures']): Promise<number> {
    if (!this.squareApi) return 0;
    const rows = this.connection.collection('square_payment_transactions');
    const recheckBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const lacking = { organizationId, orderReference: { $type: 'string' }, 'details.squareInvoiceNumber': { $exists: false }, $or: [{ invoiceCheckedAt: { $exists: false } }, { invoiceCheckedAt: { $lt: recheckBefore } }] };
    if ((await rows.countDocuments(lacking, { limit: 1 })) === 0) return 0;
    const connected = await this.integrations.listConnectedOrganizationIds('square').then((ids) => ids.includes(organizationId)).catch(() => false);
    if (!connected) return 0;
    try {
      const byOrder = await this.squareApi.listInvoiceRefsByOrder(organizationId);
      const docs = await rows.find(lacking, { projection: { orderReference: 1 } }).toArray();
      const ops = docs.map((d) => {
        const invoice = byOrder.get(String(d.orderReference));
        return {
          updateOne: {
            filter: { _id: d._id, organizationId },
            update: {
              $set: {
                invoiceCheckedAt: new Date(),
                ...(invoice?.number || invoice?.title ? { 'details.squareInvoiceId': invoice.id, 'details.squareInvoiceNumber': invoice.number, 'details.squareInvoiceTitle': invoice.title } : {}),
              },
            },
          },
        };
      });
      for (let i = 0; i < ops.length; i += 500) await rows.bulkWrite(ops.slice(i, i + 500) as never, { ordered: false });
      return ops.length;
    } catch (err) {
      failures.push({ stage: 'invoice-backfill', error: (err as Error).message });
      return 0;
    }
  }

  private async run(organizationId: string, dryRun: boolean): Promise<ReconciliationReport> {
    const failures: ReconciliationReport['failures'] = [];
    if (!dryRun) await this.backfillInvoiceLinks(organizationId, failures);
    const view = await this.directory.paymentReconciliationView(organizationId, true);
    const now = new Date();
    const report: ReconciliationReport = {
      organizationId,
      dryRun,
      paymentsScanned: view.paymentsScanned,
      paymentsLinkedToInvoice: view.paymentsWithInvoice,
      paymentsLinkedToQuote: view.paymentsLinkedToQuote,
      paymentsNotTiedToAQuote: Math.max(view.paymentsScanned - view.paymentsLinkedToQuote, 0),
      paymentsNotMatchedToCustomer: view.paymentsNotMatchedToCustomer,
      quotesScanned: view.quotes.length,
      quotesUpdated: 0,
      quotesWithPayments: 0,
      paidQuotes: 0,
      partiallyPaidQuotes: 0,
      overpaidQuotes: 0,
      unpaidQuotes: 0,
      crmOutdatedQuotes: 0,
      customersAffected: 0,
      failures,
    };
    const affected = new Set<string>();
    for (const { summary, customerId } of view.quotes) {
      if (summary.status === 'paid') report.paidQuotes += 1;
      else if (summary.status === 'partially_paid') report.partiallyPaidQuotes += 1;
      else if (summary.status === 'overpaid') report.overpaidQuotes += 1;
      else report.unpaidQuotes += 1;
      if (summary.verifiedPaid > 0) {
        report.quotesWithPayments += 1;
        affected.add(customerId);
      }
      if (summary.crmOutdated) report.crmOutdatedQuotes += 1;
    }
    report.customersAffected = affected.size;
    if (dryRun || view.quotes.length === 0) return report;

    // Only quotes whose reconciliation actually changed are written (compare signatures).
    const collection = this.connection.collection('crm_quotes');
    const ids = view.quotes.filter((q) => Types.ObjectId.isValid(q.quoteId)).map((q) => new Types.ObjectId(q.quoteId));
    const existing = await collection.find({ organizationId, _id: { $in: ids } }, { projection: { 'paymentReconciliation.signature': 1 } }).toArray();
    const known = new Map(existing.map((d) => [String(d._id), (d.paymentReconciliation as { signature?: string } | undefined)?.signature]));
    const writes: { updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }[] = [];
    for (const { quoteId, summary } of view.quotes) {
      if (!known.has(quoteId)) continue; // not this organization's quote (or removed) — never written
      const stored = toStored(summary, now);
      if (known.get(quoteId) === stored.signature) continue;
      writes.push({ updateOne: { filter: { _id: new Types.ObjectId(quoteId), organizationId }, update: { $set: { paymentReconciliation: stored } } } });
    }
    // In batches, so one bad batch is reported (not silently dropped) and never stops the others.
    for (let i = 0; i < writes.length; i += 500) {
      const batch = writes.slice(i, i + 500);
      try {
        await collection.bulkWrite(batch as never, { ordered: false });
        report.quotesUpdated += batch.length;
      } catch (err) {
        failures.push({ stage: `persist-batch-${i / 500}`, error: (err as Error).message });
      }
    }
    // Tell open Customers pages to refetch — only now that the rebuilt data is what they will read.
    if (report.quotesUpdated > 0) try {
      this.chat?.emitToOrg(organizationId, 'gateway-payment-updated', { provider: 'reconciliation' });
    } catch {
      // a socket problem never fails the reconciliation
    }
    return report;
  }
}
