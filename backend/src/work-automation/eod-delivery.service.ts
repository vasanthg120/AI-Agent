import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MailService } from '../mail/mail.service';
import type { EmailContent } from '../mail/templates';
import { User, UserDocument } from '../users/schemas/user.schema';
import { AutomationConfigService } from './automation-config.service';
import { EodAiClient } from './eod-ai.client';
import { EodRecipientResolver } from './eod-recipient.resolver';
import { eodReportEmail } from './eod-email';
import { ChannelAttempt, DeliveryRole, EodDelivery, EodDeliveryDocument } from './schemas/eod-delivery.schema';
import { EodReport, EodReportDocument } from './schemas/eod-report.schema';

/** Retry delays after the 1st, 2nd, ... failed attempt. */
const BACKOFF_MINUTES = [5, 15, 45, 120];
/** A delivery stuck in "sending" this long (the process died mid-send) may be retaken. */
const STALE_SENDING_MS = 10 * 60 * 1000;

export interface Transport {
  channel: 'gmail' | 'outlook' | 'smtp';
  /** Sends `content` to `to` and says whether it was accepted. Never throws. */
  send(args: { organizationId: string; senderUserId: string; to: string; content: EmailContent }): Promise<{ ok: true; response?: unknown } | { ok: false; error: string }>;
}

/** Sends from `senderUserId`'s own connected Gmail / Outlook mailbox (via python-agent, which refreshes expired tokens). */
export class MailboxTransport implements Transport {
  constructor(
    readonly channel: 'gmail' | 'outlook',
    private ai: EodAiClient,
  ) {}
  async send({ organizationId, senderUserId, to, content }: Parameters<Transport['send']>[0]) {
    try {
      const response = await this.ai.sendMail(organizationId, senderUserId, this.channel, [to], content);
      return { ok: true as const, response };
    } catch (err) {
      return { ok: false as const, error: describe(err) };
    }
  }
}

/** The configured SMTP server (the fallback). */
export class SmtpTransport implements Transport {
  readonly channel = 'smtp' as const;
  constructor(private mail: MailService) {}
  async send({ to, content }: Parameters<Transport['send']>[0]) {
    const res = await this.mail.sendContent(to, content);
    return res.sent ? { ok: true as const } : { ok: false as const, error: res.problem };
  }
}

function describe(err: unknown): string {
  const e = err as { response?: { status?: number; data?: { detail?: unknown } }; message?: string };
  const detail = e.response?.data?.detail;
  return `${e.response?.status ? `${e.response.status}: ` : ''}${typeof detail === 'string' ? detail : (e.message ?? 'send failed')}`.slice(0, 300);
}

@Injectable()
export class EodDeliveryService {
  private readonly logger = new Logger(EodDeliveryService.name);
  private readonly appUrl: string;
  private transports: Transport[];

  constructor(
    @InjectModel(EodDelivery.name) private deliveries: Model<EodDeliveryDocument>,
    @InjectModel(EodReport.name) private reports: Model<EodReportDocument>,
    @InjectModel(User.name) private users: Model<UserDocument>,
    private config: AutomationConfigService,
    ai: EodAiClient,
    mail: MailService,
    appConfig: ConfigService,
    private recipients: EodRecipientResolver,
  ) {
    this.appUrl = appConfig.get<string>('mail.appUrl') ?? '';
    this.transports = [new MailboxTransport('gmail', ai), new MailboxTransport('outlook', ai), new SmtpTransport(mail)];
  }

  /** Replaces the transports (tests). */
  useTransports(t: Transport[]) {
    this.transports = t;
  }

  /**
   * Creates the delivery rows of a generated report: one for the responsible
   * organization admin (resolved from existing records, see EodRecipientResolver),
   * one for the employee's own registered address, and one for their configured
   * reporting manager when that person is a valid recipient (and not the admin,
   * who already has the report). Idempotent per (report, role). A recipient is
   * never invented: no manager configured means no manager row (and a visible
   * "skipped" note), never a guessed address.
   */
  async enqueue(report: EodReportDocument): Promise<EodDeliveryDocument[]> {
    const organizationId = report.organizationId;
    const cfg = await this.config.get(organizationId);
    const employee = await this.users.findOne({ _id: report.userId, organizationId }).select('email reportingManagerId active').lean().exec();
    const rows: EodDeliveryDocument[] = [];
    const make = async (role: DeliveryRole, fields: Partial<EodDelivery>) => {
      try {
        rows.push(await this.deliveries.create({ organizationId, reportId: report._id.toString(), employeeId: report.userId, role, attempts: 0, channelAttempts: [], ...fields }));
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
        const existing = await this.deliveries.findOne({ reportId: report._id.toString(), role }).exec();
        if (existing) rows.push(existing);
      }
    };

    // The admin copy: the report's real destination. Resolved from the organization's own records.
    const admin = await this.recipients.resolveAdmin(organizationId, report.userId, cfg.deliveryChannels);
    if (admin.ok) {
      await make('admin', { recipientUserId: admin.admin.id, recipientEmail: admin.recipientEmail, recipientProvider: admin.provider ?? undefined, warning: admin.warning, status: 'pending' });
      if (admin.warning) this.logger.warn(`EOD for ${report.userId}: ${admin.warning}`);
    } else {
      await make('admin', { status: 'skipped', skippedReason: admin.reason });
    }

    if (employee?.email) await make('employee', { recipientUserId: report.userId, recipientEmail: employee.email, status: 'pending' });
    else await make('employee', { status: 'skipped', skippedReason: 'employee_has_no_email' });

    if (cfg.sendToManager) {
      const manager = await this.validManager(organizationId, report.userId, employee?.reportingManagerId);
      if (manager && admin.ok && manager.id === admin.admin.id) await make('manager', { status: 'skipped', skippedReason: 'same_as_admin' });
      else if (manager) await make('manager', { recipientUserId: manager.id, recipientEmail: manager.email, status: 'pending' });
      else await make('manager', { status: 'skipped', skippedReason: employee?.reportingManagerId ? 'manager_not_valid' : 'no_manager_configured' });
    }
    return rows;
  }

  /** The configured manager if they are an active person of the same organization other than the employee. */
  private async validManager(organizationId: string, employeeId: string, managerId?: string) {
    if (!managerId || managerId === employeeId) return null;
    const m = await this.users.findOne({ _id: managerId, organizationId, active: true }).select('email').lean().exec();
    return m?.email ? { id: managerId, email: m.email } : null;
  }

  /** Delivers everything due now (new, and failed ones whose retry time has come). Returns how many were sent. */
  async processDue(organizationId: string, now = new Date()): Promise<number> {
    const cfg = await this.config.get(organizationId);
    const due = await this.deliveries
      .find({
        organizationId,
        attempts: { $lt: cfg.maxDeliveryAttempts },
        $or: [
          { status: 'pending' },
          { status: 'failed', nextAttemptAt: { $lte: now } },
          { status: 'sending', lockedAt: { $lt: new Date(now.getTime() - STALE_SENDING_MS) } },
        ],
      })
      .limit(500)
      .exec();
    let sent = 0;
    for (const d of due) if (await this.deliver(d._id.toString(), now)) sent += 1;
    return sent;
  }

  /** One delivery, claimed atomically so two workers can never send it twice. True when it was sent. */
  async deliver(deliveryId: string, now = new Date()): Promise<boolean> {
    const first = await this.deliveries.findOne({ _id: deliveryId }).exec();
    if (!first) return false;
    const cfg = await this.config.get(first.organizationId);
    const claimed = await this.deliveries
      .findOneAndUpdate(
        {
          _id: deliveryId,
          attempts: { $lt: cfg.maxDeliveryAttempts },
          $or: [{ status: 'pending' }, { status: 'failed' }, { status: 'sending', lockedAt: { $lt: new Date(now.getTime() - STALE_SENDING_MS) } }],
        },
        { $set: { status: 'sending', lockedAt: now }, $inc: { attempts: 1 } },
        { new: true },
      )
      .exec();
    if (!claimed) return false;

    const report = await this.reports.findOne({ _id: claimed.reportId, organizationId: claimed.organizationId }).exec();
    if (!report || report.status !== 'generated' || !report.sections) return this.fail(claimed, 'report_not_ready', now, cfg.maxDeliveryAttempts);

    // Re-validate the recipient at send time: a manager change or deactivation since enqueue must not leak the report.
    let to = claimed.recipientEmail;
    let senderUserId = claimed.employeeId;
    let channels: string[] = cfg.deliveryChannels;
    if (claimed.role === 'admin') {
      // Resolved again now: an ownership change, deactivation or reconnected mailbox since enqueue is honoured,
      // and the report never goes to someone who is no longer the responsible admin.
      const admin = await this.recipients.resolveAdmin(claimed.organizationId, claimed.employeeId, cfg.deliveryChannels);
      if (!admin.ok || admin.admin.id !== claimed.recipientUserId) {
        await this.deliveries.updateOne({ _id: claimed._id }, { $set: { status: 'skipped', skippedReason: admin.ok ? 'admin_changed' : admin.reason } }).exec();
        return false;
      }
      to = admin.recipientEmail;
      senderUserId = admin.admin.id; // sent from the admin's own connected mailbox
      // No connected mailbox: only the SMTP fallback can carry it, and the admin is told why.
      if (!admin.provider) channels = channels.filter((c) => c === 'smtp');
      await this.deliveries
        .updateOne(
          { _id: claimed._id },
          admin.warning
            ? { $set: { recipientEmail: admin.recipientEmail, recipientProvider: '', warning: admin.warning } }
            : { $set: { recipientEmail: admin.recipientEmail, recipientProvider: admin.provider ?? '' }, $unset: { warning: '' } },
        )
        .exec();
    }
    if (claimed.role === 'manager') {
      const emp = await this.users.findOne({ _id: claimed.employeeId, organizationId: claimed.organizationId }).select('reportingManagerId').lean().exec();
      const m = await this.validManager(claimed.organizationId, claimed.employeeId, emp?.reportingManagerId);
      if (!m || m.id !== claimed.recipientUserId) {
        await this.deliveries.updateOne({ _id: claimed._id }, { $set: { status: 'skipped', skippedReason: 'manager_changed_or_inactive' } }).exec();
        return false;
      }
      to = m.email;
    }
    if (!to) {
      await this.deliveries.updateOne({ _id: claimed._id }, { $set: { status: 'skipped', skippedReason: 'no_recipient' } }).exec();
      return false;
    }

    const content = eodReportEmail({
      employeeName: report.employeeName ?? 'Employee',
      date: report.date,
      timezone: report.timezone,
      summary: report.summary ?? '',
      summarySource: report.summarySource,
      sections: report.sections,
      dataGaps: report.dataGaps ?? [],
      appUrl: this.appUrl || undefined,
      audience: claimed.role,
    });

    const attempts: ChannelAttempt[] = [...(claimed.channelAttempts ?? [])];
    for (const channel of channels) {
      const transport = this.transports.find((t) => t.channel === channel);
      if (!transport) continue;
      const result = await transport.send({ organizationId: claimed.organizationId, senderUserId, to, content });
      attempts.push({ channel, ok: result.ok, error: result.ok ? undefined : result.error, response: result.ok ? result.response : undefined, at: new Date() });
      if (result.ok) {
        await this.deliveries.updateOne({ _id: claimed._id }, { $set: { status: 'sent', sentAt: new Date(), channel, channelAttempts: attempts, ...(result.response !== undefined ? { providerResponse: result.response } : {}) }, $unset: { lastError: '', nextAttemptAt: '' } }).exec();
        return true;
      }
    }
    const lastError = attempts.filter((a) => !a.ok).slice(-Math.max(channels.length, 1)).map((a) => `${a.channel}: ${a.error}`).join(' | ');
    await this.deliveries.updateOne({ _id: claimed._id }, { $set: { channelAttempts: attempts } }).exec();
    return this.fail(claimed, lastError || 'no delivery channel is available', now, cfg.maxDeliveryAttempts);
  }

  private async fail(d: EodDeliveryDocument, error: string, now: Date, max: number): Promise<false> {
    const delay = BACKOFF_MINUTES[Math.min(d.attempts, BACKOFF_MINUTES.length) - 1] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1];
    const canRetry = d.attempts < max;
    await this.deliveries
      .updateOne(
        { _id: d._id },
        {
          $set: { status: 'failed', lastError: error.slice(0, 500), ...(canRetry ? { nextAttemptAt: new Date(now.getTime() + delay * 60_000) } : {}) },
          // Out of attempts: nothing is scheduled any more (an admin reset starts it over).
          ...(canRetry ? {} : { $unset: { nextAttemptAt: '' } }),
        },
      )
      .exec();
    this.logger.warn(`EOD delivery ${d._id.toString()} (${d.role}) attempt ${d.attempts}/${max} failed: ${error}`);
    return false;
  }

  /** Admin: give failed deliveries of a report a fresh set of attempts. */
  async resetFailed(organizationId: string, reportId: string): Promise<number> {
    const res = await this.deliveries.updateMany({ organizationId, reportId, status: 'failed' }, { $set: { status: 'pending', attempts: 0 }, $unset: { nextAttemptAt: '' } }).exec();
    return res.modifiedCount;
  }

  list(organizationId: string, reportId: string) {
    return this.deliveries.find({ organizationId, reportId }).exec();
  }
}
