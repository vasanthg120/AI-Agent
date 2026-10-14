import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MailService } from './mail.service';
import { dailyReportEmail, notificationEmail, passwordResetOtp, publicAppUrl, twoFactorEnabledEmail, verifyEmailOtp, welcomeEmail } from './templates';

// Unit tests for the emails HaiVE sends — no Mongo needed. The EOD/morning
// report (Fix 5) keeps its fail-open-without-SMTP behavior and its boolean
// success/failure return value; every email shares one shell, carries a
// plain-text version, and escapes whatever came from outside.

const APP = 'https://app.haive.example';

describe('dailyReportEmail template', () => {
  it('groups tasks by priority and escapes AI-generated text', () => {
    const { subject, html, text } = dailyReportEmail(
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
    // Urgent before low, the overdue one flagged, the date written out.
    expect(html.indexOf('Urgent &middot; 1')).toBeGreaterThan(-1);
    expect(html.indexOf('Urgent &middot; 1')).toBeLessThan(html.indexOf('Low &middot; 1'));
    expect(html).toContain('>Overdue</span>'); // the flag on the task, not the "Overdue" count above the list
    expect(html).toContain('Thursday, 15 January 2026');
    expect(text).toContain('1 open · 1 overdue · 1 done');
    expect(text).toContain('[ ] <script>alert(1)</script> (overdue)');
    expect(text).toContain('[x] Follow up with client');
  });

  it('a finished task is never called overdue, and counts as done', () => {
    const { html, text } = dailyReportEmail(
      'Test Store',
      'eod',
      '2026-01-15',
      [{ title: 'Late but done', priority: 'high', isOverdue: true, status: 'done' }],
      'All done.',
    );
    expect(html).not.toContain('>Overdue</span>');
    expect(text).toContain('0 open · 0 overdue · 1 done');
    expect(text).not.toContain('(overdue)');
  });

  it('renders a clean "no actionable items" state instead of an empty list', () => {
    const { html, text } = dailyReportEmail('Test Store', 'morning', '2026-01-15', [], 'Nothing to report today.');
    expect(html).toContain('No actionable items in this report.');
    expect(html).toContain('Morning Briefing');
    expect(text).toContain('No actionable items in this report.');
  });

  it('links to the To-Do board only when HaiVE has a public address', () => {
    const tasks = [{ title: 'A task', priority: 'medium', isOverdue: false, status: 'todo' }];
    expect(dailyReportEmail('Test Store', 'eod', '2026-01-15', tasks, 'S', APP).html).toContain(`href="${APP}/todo-eod"`);
    const unlinked = dailyReportEmail('Test Store', 'eod', '2026-01-15', tasks, 'S', 'http://localhost:5173');
    expect(unlinked.html).not.toContain('href=');
    expect(unlinked.html).toContain('To-Do / EOD page');
  });
});

describe('every email', () => {
  const all = {
    welcome: welcomeEmail('Vasanth G', APP),
    verify: verifyEmailOtp('482913'),
    reset: passwordResetOtp('730164'),
    notification: notificationEmail('New email needs review', 'Quotation for 300 polo t-shirts — high priority', APP),
    twoFactor: twoFactorEnabledEmail(APP),
    report: dailyReportEmail('Test Store', 'eod', '2026-01-15', [{ title: 'A task', priority: 'medium', isOverdue: false, status: 'todo' }], 'Summary', APP),
  };

  it.each(Object.entries(all))('%s is a complete HTML email with a plain-text version', (_name, email) => {
    expect(email.subject.length).toBeGreaterThan(0);
    expect(email.html.startsWith('<!doctype html>')).toBe(true);
    expect(email.html).toContain('</html>');
    // Readable on a phone, and kept light in clients that would otherwise recolour it.
    expect(email.html).toContain('name="viewport"');
    expect(email.html).toContain('name="color-scheme" content="light"');
    // Mail clients strip scripts and block remote images: there are none to lose.
    expect(email.html).not.toMatch(/<script|<img|<link /i);
    expect(email.html).not.toMatch(/undefined|NaN|\[object/);
    expect(email.text.trim().length).toBeGreaterThan(20);
    expect(email.text).not.toMatch(/<[a-z/]|&[a-z]+;|undefined/i);
    expect(email.text).toContain('— HaiVE');
  });

  it('the one-time codes are in the email, its preview line and its text', () => {
    expect(all.verify.html).toContain('>482913<');
    expect(all.verify.html).toContain('Your verification code is 482913');
    expect(all.verify.text).toContain('482913');
    expect(all.verify.html).toContain('Expires in 10 minutes');
    expect(all.reset.html).toContain('>730164<');
    expect(all.reset.html).toContain('Expires in 15 minutes');
    expect(all.reset.text).toContain('730164');
  });

  it('whatever came from outside is escaped: a name, a notification’s title and text', () => {
    const welcome = welcomeEmail('<b>Mallory</b> Smith', APP);
    expect(welcome.html).not.toContain('<b>Mallory</b>');
    expect(welcome.html).toContain('Good to have you, &lt;b&gt;Mallory&lt;/b&gt;');

    const notification = notificationEmail('Re: <img src=x onerror=alert(1)>', 'First line\n<a href="https://evil.example">click</a>', APP);
    expect(notification.html).not.toContain('<img src=x');
    expect(notification.html).not.toContain('<a href="https://evil.example">');
    expect(notification.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // The writer's line breaks survive.
    expect(notification.html).toContain('First line<br>&lt;a href=');
    // The subject is plain text already: it is not HTML-escaped.
    expect(notification.subject).toBe('Re: <img src=x onerror=alert(1)>');
  });

  it('buttons lead into the app where the email is about', () => {
    expect(all.welcome.html).toContain(`href="${APP}"`);
    expect(all.notification.html).toContain(`href="${APP}/notifications"`);
    expect(all.twoFactor.html).toContain(`href="${APP}/settings/security"`);
    expect(all.twoFactor.text).toContain(`${APP}/settings/security`);
    // Without a public address there is no button — and no dead link.
    expect(welcomeEmail('Vasanth').html).not.toContain('href=');
    expect(notificationEmail('T', 'D').html).toContain('Open HaiVE to see the details.');
    expect(twoFactorEnabledEmail('http://localhost:5173').html).not.toContain('href=');
  });
});

describe('publicAppUrl', () => {
  it('keeps a real address, without its trailing slash', () => {
    expect(publicAppUrl('https://app.haive.example/')).toBe('https://app.haive.example');
    expect(publicAppUrl(' http://haive.internal:8080 ')).toBe('http://haive.internal:8080');
  });

  it('never puts an address on this machine, or something that is not an address, in an email', () => {
    for (const value of [
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'https://localhost',
      'http://0.0.0.0:80',
      'http://[::1]:5173',
      '',
      undefined,
      'app.haive.example',
      'javascript:alert(1)',
    ]) {
      expect(publicAppUrl(value)).toBeUndefined();
    }
  });
});

describe('MailService', () => {
  const serviceWith = async (config: Record<string, unknown>) => {
    const moduleRef = await Test.createTestingModule({
      providers: [MailService, { provide: ConfigService, useValue: { get: (key: string) => config[key] } }],
    }).compile();
    return moduleRef.get(MailService);
  };

  it('sendDailyReportEmail returns false (and suppresses, not throws) when SMTP is not configured', async () => {
    const mailService = await serviceWith({});
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

  it('sends the HTML and the plain text together, with links to where the app really is', async () => {
    const mailService = await serviceWith({ 'mail.host': 'smtp.example.test', 'mail.from': 'HaiVE <no-reply@example.test>', 'mail.appUrl': `${APP}/` });
    // The real transport would open a connection; what matters here is what it is handed.
    const sendMail = jest.fn(async () => ({ response: '250 OK' }));
    (mailService as unknown as { transporter: { sendMail: typeof sendMail } }).transporter = { sendMail };

    await mailService.sendNotificationEmail('someone@example.com', 'New email needs review', 'Quotation for 300 polo t-shirts');
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'HaiVE <no-reply@example.test>',
        to: 'someone@example.com',
        subject: 'New email needs review',
        html: expect.stringContaining(`href="${APP}/notifications"`),
        text: expect.stringContaining(`${APP}/notifications`),
      }),
    );

    expect(await mailService.sendDailyReportEmail('someone@example.com', 'Test Store', 'eod', '2026-01-15', [], 'Summary')).toBe(true);
    expect(sendMail).toHaveBeenLastCalledWith(
      expect.objectContaining({ html: expect.stringContaining(`${APP}/todo-eod`), text: expect.stringContaining('Test Store — End-of-Day Report') }),
    );

    // A send the mail server refuses is reported, never thrown.
    sendMail.mockRejectedValueOnce(new Error('550 mailbox unavailable'));
    expect(await mailService.sendDailyReportEmail('someone@example.com', 'Test Store', 'eod', '2026-01-15', [], 'Summary')).toBe(false);
    sendMail.mockRejectedValueOnce(new Error('550 mailbox unavailable'));
    await expect(mailService.sendVerificationOtp('someone@example.com', '123456')).resolves.toBeUndefined();
  });
});
