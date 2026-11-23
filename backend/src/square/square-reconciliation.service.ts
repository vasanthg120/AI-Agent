import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { IntegrationsService } from '../integrations/integrations.service';
import { SquarePaymentLike, SquarePaymentMatchingService } from './square-payment-matching.service';
import { SquareInvoiceRef } from './square-payment-details';
import { SquareService } from './square.service';

// Background reconciliation — the webhook controller's own safety net, not
// an optional add-on (per the approved plan: "don't silently drop a
// payment" covers a missed/failed webhook delivery too, not just
// signature/dedup correctness). Re-lists each connected organization's
// recent payments and upserts them the same way a webhook would, via the
// SAME matching service — so a payment is never represented two different
// ways depending on how Haive learned about it.
//
// Deliberately a plain NestJS @Cron (mirrors subscription-renewal.service.
// ts's own shape), not python-agent's APScheduler-based CRM sync: this
// job's scope (one provider, one straightforward List Payments call per
// org) is far smaller than the multi-adapter CRM sync engine that pattern
// exists for.
@Injectable()
export class SquareReconciliationService {
  private readonly logger = new Logger(SquareReconciliationService.name);

  // Generous overlap (not just "since the last run") — confirmed-safe
  // because upsertFromPayment is fully idempotent on providerPaymentId: a
  // payment this already saw gets recomputed to the same values, never
  // double-counted. Wide enough to absorb a run that failed entirely
  // without losing anything in the gap.
  private readonly LOOKBACK_HOURS = 6;

  constructor(
    private integrations: IntegrationsService,
    private square: SquareService,
    private matching: SquarePaymentMatchingService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async reconcileAll(): Promise<void> {
    const organizationIds = await this.integrations.listConnectedOrganizationIds('square');
    for (const organizationId of organizationIds) {
      try {
        await this.reconcileOrganization(organizationId);
      } catch (err) {
        this.logger.error(`Square reconciliation failed for org ${organizationId}: ${(err as Error).message}`);
      }
    }
  }

  /** Pulls this org's FULL payment history (no beginTime — Square's own List
   * Payments default is "the last year", confirmed live against its API
   * reference, never assumed) — run once, right after a successful connect
   * (see square.controller.ts), so a newly-connected org's existing
   * customers show their payment history immediately rather than waiting
   * for reconcileAll's 6-hour lookback to happen to cover it. Safe to call
   * more than once: upsertFromPayment is fully idempotent. */
  async initialSync(organizationId: string) {
    return this.reconcileOrganization(organizationId, { fullHistory: true });
  }

  /** Progress of one run: how many payments were read, how many were re-linked to the Square Invoice that billed
   * them, how many have no invoice (they stay as they are — matched later only by an exact identifier, never an amount),
   * and how many failed (a failure on one payment never stops the rest). */
  async reconcileOrganization(
    organizationId: string,
    options: { fullHistory?: boolean } = {},
  ): Promise<{ count: number; invoiceLinked: number; withoutInvoice: number; failed: number }> {
    const auth = await this.integrations.resolveAuth(organizationId, 'square');
    if (!auth?.credentials.accessToken) return { count: 0, invoiceLinked: 0, withoutInvoice: 0, failed: 0 };
    const environment = (auth.oauthMeta?.environment as 'sandbox' | 'production') || 'sandbox';
    const beginTime = options.fullHistory ? undefined : new Date(Date.now() - this.LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

    // A full history is read against the org's invoices once; if that read fails the per-payment lookup still works.
    let invoicesByOrder: Map<string, SquareInvoiceRef> | undefined;
    if (options.fullHistory) {
      try {
        invoicesByOrder = await this.square.listInvoiceRefsByOrder(organizationId);
      } catch (err) {
        this.logger.warn(`Could not pre-read Square invoices for org ${organizationId}: ${(err as Error).message}`);
      }
    }

    let count = 0;
    let invoiceLinked = 0;
    let failed = 0;
    let cursor: string | undefined;
    do {
      const { payments, cursor: next } = await this.square.listPayments(organizationId, { beginTime, cursor });
      for (const payment of payments as unknown as SquarePaymentLike[]) {
        try {
          await this.matching.upsertFromPayment(organizationId, auth.credentials.accessToken!, environment, payment, undefined, invoicesByOrder);
          if (invoicesByOrder && payment.order_id && !payment.reference_id && invoicesByOrder.has(payment.order_id)) invoiceLinked += 1;
          count += 1;
        } catch (err) {
          failed += 1;
          this.logger.warn(`Square payment ${payment.id} could not be reconciled for org ${organizationId}: ${(err as Error).message}`);
        }
      }
      cursor = next;
    } while (cursor);

    return { count, invoiceLinked, withoutInvoice: count - invoiceLinked, failed };
  }
}
