import { Global, Injectable, Module } from '@nestjs/common';

export type PaymentChangeReason = 'gateway-payment' | 'refund' | 'quote-payment' | 'crm-sync' | 'manual';

type Listener = (organizationId: string, reason: PaymentChangeReason) => void;

/** One in-process signal: "something that changes what a quote has been paid just changed for this organization".
 * Square (webhook / reconciliation, refunds included), Haive's own quote payments and a CRM sync publish it; the payment
 * reconciliation subscribes. It carries no payment data — the reconciliation always re-reads the sources — so a
 * subscriber missing a signal can never corrupt anything, and the periodic reconciliation is the safety net. */
@Injectable()
export class PaymentEvents {
  private listeners: Listener[] = [];

  subscribe(listener: Listener): void {
    this.listeners.push(listener);
  }

  notify(organizationId: string | undefined, reason: PaymentChangeReason): void {
    if (!organizationId) return;
    for (const listener of this.listeners) {
      try {
        listener(organizationId, reason);
      } catch {
        // A subscriber failing must never fail the webhook / payment write that published the signal.
      }
    }
  }
}

@Global()
@Module({ providers: [PaymentEvents], exports: [PaymentEvents] })
export class PaymentEventsModule {}
