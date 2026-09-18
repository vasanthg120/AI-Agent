import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { dailyReportEmail, notificationEmail, passwordResetOtp, twoFactorEnabledEmail, verifyEmailOtp, welcomeEmail } from './templates';
import type { DailyReportEmailTask } from './templates';

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

  constructor(private config: ConfigService) {
    const host = this.config.get<string>('mail.host');
    this.from = this.config.get<string>('mail.from') ?? '';

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
    });
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.transporter) {
      this.logger.warn(`Email suppressed (SMTP not configured): "${subject}" -> ${to}`);
      return;
    }
    try {
      const info = await this.transporter.sendMail({ from: this.from, to, subject, html });
      // Was silent on success before — made every "not receiving email"
      // report indistinguishable between "never sent" and "sent, check
      // spam/provider" without re-running an ad-hoc script to find out.
      this.logger.log(`Email "${subject}" -> ${to} accepted by SMTP server (${info.response})`);
    } catch (err) {
      this.logger.error(`Failed to send email "${subject}" to ${to}: ${(err as Error).message}`);
    }
  }

  sendWelcomeEmail(to: string, name: string): Promise<void> {
    const { subject, html } = welcomeEmail(name);
    return this.send(to, subject, html);
  }

  sendVerificationOtp(to: string, code: string): Promise<void> {
    const { subject, html } = verifyEmailOtp(code);
    return this.send(to, subject, html);
  }

  sendPasswordResetOtp(to: string, code: string): Promise<void> {
    const { subject, html } = passwordResetOtp(code);
    return this.send(to, subject, html);
  }

  // Real delivery for the "Email" notification channel — see
  // NotificationsService.dispatchExternalChannels, the single place this is
  // called from (checked against the target user's own preference and their
  // org's notificationPolicy ceiling first).
  sendNotificationEmail(to: string, title: string, description: string): Promise<void> {
    const { subject, html } = notificationEmail(title, description);
    return this.send(to, subject, html);
  }

  sendTwoFactorEnabledEmail(to: string): Promise<void> {
    const { subject, html } = twoFactorEnabledEmail();
    return this.send(to, subject, html);
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
    const { subject, html } = dailyReportEmail(storeName, reportType, date, tasks, summary);
    if (!this.transporter) {
      this.logger.warn(`Email suppressed (SMTP not configured): "${subject}" -> ${to}`);
      return false;
    }
    try {
      const info = await this.transporter.sendMail({ from: this.from, to, subject, html });
      this.logger.log(`Email "${subject}" -> ${to} accepted by SMTP server (${info.response})`);
      return true;
    } catch (err) {
      this.logger.error(`Failed to send email "${subject}" to ${to}: ${(err as Error).message}`);
      return false;
    }
  }
}
