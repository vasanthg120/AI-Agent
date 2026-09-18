import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MailService } from './mail.service';
import { dailyReportEmail } from './templates';

// Unit tests for the new EOD/morning report email (Fix 5) — no Mongo needed.
// Mirrors the existing fail-open-without-SMTP behavior every other MailService
// method already has, plus the new boolean success/failure return value
// sendDailyReportEmail needs that the other (fire-and-forget) methods don't.

describe('dailyReportEmail template', () => {
  it('groups tasks by priority and escapes AI-generated text', () => {
    const { subject, html } = dailyReportEmail(
      'Test Store',
      'eod',
      '2026-01-15',
      [
        { title: '<script>alert(1)</script>', priority: 'urgent', isOverdue: true, status: 'todo' },
        { title: 'Follow up with client', priority: 'low', isOverdue: false, status: 'done' },
      ],
      'Summary with <b>markup</b> in it',
    );

    expect(subject).toContain('Test Store');
    expect(subject).toContain('End-of-Day Report');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;markup&lt;/b&gt;');
    expect(html).toContain('(overdue)');
  });

  it('renders a clean "no actionable items" state instead of an empty list', () => {
    const { html } = dailyReportEmail('Test Store', 'morning', '2026-01-15', [], 'Nothing to report today.');
    expect(html).toContain('No actionable items in this report.');
  });
});

describe('MailService.sendDailyReportEmail', () => {
  it('returns false (and suppresses, not throws) when SMTP is not configured', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [MailService, { provide: ConfigService, useValue: { get: () => undefined } }],
    }).compile();
    const mailService = moduleRef.get(MailService);

    const sent = await mailService.sendDailyReportEmail(
      'someone@example.com',
      'Test Store',
      'eod',
      '2026-01-15',
      [{ title: 'A task', priority: 'medium', isOverdue: false, status: 'todo' }],
      'Summary',
    );
    expect(sent).toBe(false);
  });
});
