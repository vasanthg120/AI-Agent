import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { dailyReportEmail, notificationEmail, passwordResetOtp, twoFactorEnabledEmail, verifyEmailOtp, welcomeEmail } from './templates';
import type { DailyReportEmailTask, EmailContent } from './templates';

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
    });
  }

  // Every email goes out with its plain-text version alongside the HTML.
  private async send(to: string, { subject, html, text }: EmailContent): Promise<void> {
    if (!this.transporter) {
      this.logger.warn(`Email suppressed (SMTP not configured): "${subject}" -> ${to}`);
      return;
    }
    try {
      const info = await this.transporter.sendMail({ from: this.from, to, subject, html, text });
      // Was silent on success before — made every "not receiving email"
      // report indistinguishable between "never sent" and "sent, check
      // spam/provider" without re-running an ad-hoc script to find out.
      this.logger.log(`Email "${subject}" -> ${to} accepted by SMTP server (${info.response})`);
    } catch (err) {
      this.logger.error(`Failed to send email "${subject}" to ${to}: ${(err as Error).message}`);
    }
  }

  sendWelcomeEmail(to: string, name: string): Promise<void> {
    return this.send(to, welcomeEmail(name, this.appUrl));
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
}
