import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { dailyReportEmail, notificationEmail, passwordResetOtp, twoFactorEnabledEmail, verifyEmailOtp, welcomeEmail, invitationEmail } from './templates';
import type { DailyReportEmailTask, EmailContent } from './templates';

/** Whether an email left HaiVE: accepted by the mail server, or why not, in
 * words an administrator can act on (shown where the email was asked for). */
export type MailDelivery = { sent: true } | { sent: false; problem: string };

// A send someone is waiting on (an invitation) must not hang on a mail server
// that doesn't answer: give up and say so instead.
const SMTP_TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 30_000 };

// Fire-and-forget by design, same fail-open shape as RedisCacheService
// (see common/redis/redis-cache.service.ts): an unreachable/misconfigured
// SMTP server must never block or fail a request that merely triggers an
// email as a side effect (register, forgot-password, etc). Callers should
// not await these for anything response-critical.
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter | null;
  private readonly from: string;
  // Where the buttons in the emails lead (see config's mail.appUrl).
  private readonly appUrl: string;

  constructor(private config: ConfigService) {
    const host = this.config.get<string>('mail.host');
    this.from = this.config.get<string>('mail.from') ?? '';
    this.appUrl = this.config.get<string>('mail.appUrl') ?? '';

    if (!host) {
      this.logger.warn('SMTP_HOST not set — outgoing email is disabled (calls will be logged and skipped).');
      this.transporter = null;
      return;
    }

    const port = this.config.get<number>('mail.port') ?? 587;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: {
        user: this.config.get<string>('mail.user'),
        pass: this.config.get<string>('mail.password'),
      },
      ...SMTP_TIMEOUTS,
    });
  }

  // Every email goes out with its plain-text version alongside the HTML.
  // Fire-and-forget callers: the outcome is only logged.
  private async send(to: string, content: EmailContent): Promise<void> {
    await this.deliver(to, content);
  }

  /** Sends one email and says what happened — never throws. Logged either way:
   * "accepted by SMTP server" means it left HaiVE (spam folders are then the
   * receiving side's business); anything else says why it didn't. */
  private async deliver(to: string, { subject, html, text }: EmailContent): Promise<MailDelivery> {
    if (!this.transporter) {
      this.logger.warn(`Email suppressed (SMTP not configured): "${subject}" -> ${to}`);
      return { sent: false, problem: 'Email isn’t set up on this server (no SMTP_HOST), so nothing was sent.' };
    }
    try {
      const info = await this.transporter.sendMail({ from: this.from, to, subject, html, text });
      this.logger.log(`Email "${subject}" -> ${to} accepted by SMTP server (${info.response})`);
      return { sent: true };
    } catch (err) {
      this.logger.error(`Failed to send email "${subject}" to ${to}: ${(err as Error).message}`);
      return { sent: false, problem: describeSmtpFailure(err, to) };
    }
  }

  sendWelcomeEmail(to: string, name: string): Promise<void> {
    return this.send(to, welcomeEmail(name, this.appUrl));
  }

  /** Where an invitation's link leads. Uses the app address as configured, even
   * localhost: unlike a convenience link in a welcome email, an invitation can't be
   * completed without it, and in development localhost is the right address. */
  invitationLink(token: string): string | undefined {
    const base = this.appUrl.trim().replace(/\/+$/, '');
    return base ? `${base}/activate?token=${encodeURIComponent(token)}` : undefined;
  }

  /** Awaited by whoever invites (they are told whether it went — see invitations.service.ts). */
  sendInvitationEmail(to: string, name: string, businessName: string, token: string): Promise<MailDelivery> {
    return this.deliver(to, invitationEmail(name, businessName, this.invitationLink(token)));
  }

  sendVerificationOtp(to: string, code: string): Promise<void> {
    return this.send(to, verifyEmailOtp(code));
  }

  sendPasswordResetOtp(to: string, code: string): Promise<void> {
    return this.send(to, passwordResetOtp(code));
  }

  // Real delivery for the "Email" notification channel — see
  // NotificationsService.dispatchExternalChannels, the single place this is
  // called from (checked against the target user's own preference and their
  // org's notificationPolicy ceiling first).
  sendNotificationEmail(to: string, title: string, description: string): Promise<void> {
    return this.send(to, notificationEmail(title, description, this.appUrl));
  }

  sendTwoFactorEnabledEmail(to: string): Promise<void> {
    return this.send(to, twoFactorEnabledEmail(this.appUrl));
  }

  // Unlike every sendXxx above (fire-and-forget, Promise<void>), the caller
  // here (store-settings.service.ts) needs to know whether the send actually
  // succeeded so it can set DailyReport.emailStatus correctly — hence a
  // separate boolean-returning method rather than changing the shared,
  // already-fire-and-forget send()'s contract for its 5 existing callers.
  async sendDailyReportEmail(
    to: string,
    storeName: string,
    reportType: 'morning' | 'eod',
    date: string,
    tasks: DailyReportEmailTask[],
    summary: string,
  ): Promise<boolean> {
    const { subject, html, text } = dailyReportEmail(storeName, reportType, date, tasks, summary, this.appUrl);
    if (!this.transporter) {
      this.logger.warn(`Email suppressed (SMTP not configured): "${subject}" -> ${to}`);
      return false;
    }
    try {
      const info = await this.transporter.sendMail({ from: this.from, to, subject, html, text });
      this.logger.log(`Email "${subject}" -> ${to} accepted by SMTP server (${info.response})`);
      return true;
    } catch (err) {
      this.logger.error(`Failed to send email "${subject}" to ${to}: ${(err as Error).message}`);
      return false;
    }
  }

  // SalesBoard's "Send" record action (quotes.service.ts's sendQuote, via
  // quote-documents.service.ts) — the one caller that needs a real file
  // attached, so it's its own method rather than extending the shared,
  // attachment-less send() above. Same boolean-returning contract as
  // sendDailyReportEmail just above, for the same reason: the caller needs
  // to know whether this specific send actually went out before it updates
  // quoteStatus.
  async sendDocumentEmail(
    to: string,
    { subject, html, text, attachment }: { subject: string; html: string; text: string; attachment: { filename: string; content: Buffer } },
  ): Promise<boolean> {
    if (!this.transporter) {
      this.logger.warn(`Email suppressed (SMTP not configured): "${subject}" -> ${to}`);
      return false;
    }
    try {
      const info = await this.transporter.sendMail({ from: this.from, to, subject, html, text, attachments: [attachment] });
      this.logger.log(`Email "${subject}" -> ${to} accepted by SMTP server (${info.response})`);
      return true;
    } catch (err) {
      this.logger.error(`Failed to send email "${subject}" to ${to}: ${(err as Error).message}`);
      return false;
    }
  }
}

/** Why the mail server didn't take an email, in words for the administrator who asked for it. */
export function describeSmtpFailure(err: unknown, to: string): string {
  const e = err as { code?: string; responseCode?: number; response?: string; message?: string };
  const detail = (e.response || e.message || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (e.code === 'EAUTH' || e.responseCode === 535 || e.responseCode === 534) {
    return 'The mail server refused HaiVE’s sign-in, so nothing was sent. The email account settings (SMTP_USER / SMTP_PASSWORD) need checking.';
  }
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ECONNRESET'].includes(e.code ?? '')) {
    return 'HaiVE couldn’t reach the mail server, so nothing was sent. Try again in a few minutes.';
  }
  if (e.code === 'EENVELOPE' || (e.responseCode !== undefined && e.responseCode >= 550 && e.responseCode < 560)) {
    return `The mail server wouldn’t send to ${to}${detail ? ` (${detail})` : ''}.`;
  }
  return `The mail server didn’t accept the email${detail ? ` (${detail})` : ''}.`;
}
