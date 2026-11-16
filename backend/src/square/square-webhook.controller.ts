import { BadRequestException, Controller, Headers, Logger, Param, Post, RawBodyRequest, Req } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHmac, timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { Model } from 'mongoose';
import { PermissionExempt } from '../common/permissions/permission.decorator';
import { IntegrationsService } from '../integrations/integrations.service';
import { SquareWebhookEvent, SquareWebhookEventDocument } from './schemas/square-webhook-event.schema';
import { SquarePaymentMatchingService, SquarePaymentLike } from './square-payment-matching.service';

// Square calls this directly — no JWT, same as billing's Razorpay/Stripe/
// Cashfree webhook routes (billing-webhook.controller.ts). req.rawBody is
// already populated app-wide (main.ts's NestFactory.create({rawBody: true})
// — set up for those existing webhooks, reused here unchanged).
//
// The organization id is IN THE PATH (/square/webhooks/:organizationId) —
// confirmed necessary, not a stylistic choice: webhook subscriptions are
// per-Square-app (see square.service.ts's class comment), so each
// organization's own app has its OWN signing secret, and there's no way to
// know WHICH organization's secret to verify against before the body is
// even parsed. Each organization registers this exact URL (with its own id)
// in its own Square Developer Console.
@Controller('square/webhooks')
export class SquareWebhookController {
  private readonly logger = new Logger(SquareWebhookController.name);

  constructor(
    @InjectModel(SquareWebhookEvent.name) private webhookEventModel: Model<SquareWebhookEventDocument>,
    private integrations: IntegrationsService,
    private matching: SquarePaymentMatchingService,
  ) {}

  @Post(':organizationId')
  @PermissionExempt('public')
  async handle(@Param('organizationId') organizationId: string, @Req() req: RawBodyRequest<Request>, @Headers('x-square-hmacsha256-signature') signature?: string) {
    const rawBody = req.rawBody;
    if (!rawBody) throw new BadRequestException('Missing request body');
    if (!signature) throw new BadRequestException('Missing signature header');

    const secret = await this.integrations.resolveWebhookSigningSecret(organizationId, 'square');
    if (!secret) {
      this.logger.warn(`Square webhook received for org ${organizationId} but no webhook signing secret is configured — rejecting.`);
      throw new BadRequestException('Square webhooks are not configured for this organization.');
    }

    const notificationUrl = await this.notificationUrl(organizationId);
    if (!this.verifySignature(rawBody, notificationUrl, secret, signature)) {
      throw new BadRequestException('Invalid webhook signature');
    }

    const payload = JSON.parse(rawBody.toString('utf8')) as { event_id?: string; type?: string; data?: { object?: { payment?: SquarePaymentLike } } };
    if (!payload.event_id) throw new BadRequestException('Event carried no event_id.');

    try {
      await this.webhookEventModel.create({ eventId: payload.event_id, organizationId, eventType: payload.type ?? 'unknown', payload });
    } catch (err) {
      const mongoErr = err as { code?: number };
      if (mongoErr.code === 11000) {
        this.logger.log(`Duplicate Square webhook delivery for event ${payload.event_id} — already stored, skipping.`);
        return { ok: true, duplicate: true };
      }
      throw err;
    }

    // payment.created/payment.updated both carry the full, current payment
    // object — handled identically either way, since the matching service
    // always recomputes the transaction row fresh from whatever's given,
    // never incrementally. A refund (full or partial) updates the SAME
    // payment's own refunded_money field (confirmed live against Square's
    // refund guide — refund status lives on a separate PaymentRefund
    // object, but the Payment itself still changes), which ALSO fires a
    // payment.updated event — so this one handler already captures refunds
    // correctly without a separate refund.created/refund.updated handler.
    // That pair is deliberately NOT subscribed to/parsed here: their exact
    // payload shape wasn't confirmed live (unlike Payment's, which was), so
    // handling them would mean guessing a shape rather than verifying one
    // — left as a flagged gap for a later phase, not silently assumed.
    const payment = payload.data?.object?.payment;
    if (payment) {
      try {
        const auth = await this.integrations.resolveAuth(organizationId, 'square');
        if (auth?.credentials.accessToken) {
          const environment = (auth.oauthMeta?.environment as 'sandbox' | 'production') || 'sandbox';
          await this.matching.upsertFromPayment(organizationId, auth.credentials.accessToken, environment, payment, payload.event_id);
          await this.webhookEventModel.updateOne({ eventId: payload.event_id }, { $set: { processed: true } });
        }
      } catch (err) {
        this.logger.error(`Failed to process Square webhook event ${payload.event_id} for org ${organizationId}: ${(err as Error).message}`);
        await this.webhookEventModel.updateOne({ eventId: payload.event_id }, { $set: { processingError: (err as Error).message } });
        // Never re-throw: the event is durably stored either way, and the
        // periodic reconciliation pass (not built on this exact row) will
        // catch what this failed to process — Square must still get a 2xx
        // so it doesn't retry a delivery that's already safely recorded.
      }
    }

    return { ok: true };
  }

  // Must be the EXACT URL this organization registered in its own Square
  // Developer Console — confirmed live: even a trailing-slash mismatch
  // fails every verification. Read from that organization's saved app
  // config, never reconstructed from the incoming request.
  private async notificationUrl(organizationId: string): Promise<string> {
    const saved = await this.integrations.resolveOAuthAppCredentials(organizationId, 'square');
    return saved?.meta?.webhookNotificationUrl ?? '';
  }

  // Confirmed live against Square's own docs + community-verified behavior
  // (Square's own page doesn't spell out the exact concatenation): HMAC-
  // SHA256 over (notificationUrl + rawBody, no separator), base64-encoded,
  // compared in constant time.
  private verifySignature(rawBody: Buffer, notificationUrl: string, secret: string, signatureHeader: string): boolean {
    if (!notificationUrl) return false;
    const expected = createHmac('sha256', secret).update(notificationUrl).update(rawBody).digest('base64');
    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(signatureHeader);
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  }
}
