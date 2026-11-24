// LIVE email delivery check - sends REAL emails. It is skipped unless you opt in with test accounts
// you control, so the normal suite never sends anything.
//
//   LIVE_EMAIL_EMPLOYEE_TO=<your test employee inbox>   (required)
//   LIVE_EMAIL_MANAGER_TO=<your test manager inbox>     (required)
//   LIVE_PYTHON_URL=http://127.0.0.1:8011               (only to also test mailbox sending; a python-agent that
//                                                        serves /work/send-mail, e.g. the full app)
//   LIVE_SENDER_USER_ID=<Haive user id>                 (the TEST employee whose connected Gmail/Outlook sends)
//   LIVE_SENDER_ORG_ID=<that user's organization id>
//   LIVE_SENDER_CHANNEL=outlook|gmail                   (default: both are tried in that order)
//
// What it proves, printed as evidence: the provider's own response for every send (SMTP: the server's
// accepted/rejected lists and message id; mailbox: python-agent's reply from Gmail / Microsoft Graph), the
// recipients each copy went to, and the delivery rows written (attempts, channel, errors). Whether the
// message then ARRIVED must be checked in the two inboxes - the test prints the subject line to look for.
//
//   cd backend && LIVE_EMAIL_EMPLOYEE_TO=a@... LIVE_EMAIL_MANAGER_TO=b@... npx jest work-automation.live-email

import * as nodemailer from 'nodemailer';
import { eodReportEmail } from './eod-email';
import { EodSections } from './schemas/eod-report.schema';

const EMP = process.env.LIVE_EMAIL_EMPLOYEE_TO;
const MGR = process.env.LIVE_EMAIL_MANAGER_TO;
const PY = process.env.LIVE_PYTHON_URL;
const SENDER = process.env.LIVE_SENDER_USER_ID;
const ORG = process.env.LIVE_SENDER_ORG_ID;

const sections: EodSections = {
  completed: [{ taskId: 't1', title: 'LIVE TEST: closed deal', priority: 'high', status: 'completed', sourcePlatform: 'hoops', sourceType: 'deal', evidence: { type: 'source_status', detail: 'Deal marked won in hoops.', at: new Date() } }],
  pending: [], overdue: [], blocked: [], awaitingVerification: [],
  meetings: { source: 'not_connected', items: [] },
  customerFollowUps: { repliesSent: 0, completed: [], pending: [] },
  crmUpdates: [], nextDayPriorities: [],
  counts: { completed: 1, pending: 0, overdue: 0, blocked: 0, awaitingVerification: 0 },
};

(EMP && MGR ? describe : describe.skip)('LIVE email delivery (sends real mail)', () => {
  const evidence: string[] = [];
  afterAll(() => {
    // eslint-disable-next-line no-console
    console.log(`\n===== LIVE EMAIL EVIDENCE =====\n${evidence.join('\n')}\n===============================`);
  });
  const content = (audience: 'employee' | 'manager') => eodReportEmail({ employeeName: 'Haive LIVE TEST', date: new Date().toISOString().slice(0, 10), timezone: 'UTC', summary: 'This is a test of automatic EOD delivery. No action needed.', summarySource: 'deterministic', sections, dataGaps: [], audience });

  it('SMTP: the configured server accepts a message for each recipient (provider response recorded)', async () => {
    const host = process.env.SMTP_HOST;
    expect(host).toBeTruthy();
    const port = Number(process.env.SMTP_PORT ?? 587);
    const t = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } });
    for (const [role, to] of [['employee', EMP!], ['manager', MGR!]] as const) {
      const c = content(role);
      const info = await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject: `[LIVE TEST ${role}] ${c.subject}`, html: c.html, text: c.text });
      evidence.push(`SMTP ${role}: to=${to} accepted=${JSON.stringify(info.accepted)} rejected=${JSON.stringify(info.rejected)} messageId=${info.messageId} response="${info.response}"`);
      expect(info.rejected).toEqual([]);
      expect(info.accepted).toContain(to);
    }
  }, 60_000);

  (PY && SENDER && ORG ? it : it.skip)('Mailbox: the test employee\'s own connected Gmail/Outlook sends to the employee and the manager', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
    const token = jwt.sign({ sub: SENDER, organizationId: ORG }, process.env.JWT_SECRET as string, { expiresIn: '5m' });
    const channels = process.env.LIVE_SENDER_CHANNEL ? [process.env.LIVE_SENDER_CHANNEL] : ['outlook', 'gmail'];
    let sentVia: string | undefined;
    for (const channel of channels) {
      const results: string[] = [];
      let ok = true;
      for (const [role, to] of [['employee', EMP!], ['manager', MGR!]] as const) {
        const c = content(role);
        const res = await fetch(`${PY}/work/send-mail`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ channel, to: [to], subject: `[LIVE TEST ${role}] ${c.subject}`, html: c.html, text: c.text }) });
        const body = await res.text();
        results.push(`${role}: HTTP ${res.status} ${body.slice(0, 300)}`);
        if (res.status !== 200) ok = false;
      }
      evidence.push(`MAILBOX ${channel} (sender user ${SENDER}): ${results.join(' | ')}`);
      if (ok) {
        sentVia = channel;
        break;
      }
    }
    expect(sentVia).toBeDefined();
  }, 120_000);

  it('tells you what to check', () => {
    evidence.push(`CHECK THE INBOXES: ${EMP} and ${MGR} must each show a message whose subject starts "[LIVE TEST employee]" / "[LIVE TEST manager]". Delivery is only confirmed when you see them.`);
  });
});
