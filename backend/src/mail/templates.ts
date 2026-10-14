// Every email HaiVE sends, built from one shared shell so they all look like
// the same product — without a template engine for what is a handful of short
// emails.
//
// Written for mail clients, not browsers: tables for layout, every style
// inline, system fonts, solid colours behind every gradient, no images and no
// scripts. A light design on purpose — dark emails are re-coloured unpredictably
// by Gmail and Outlook. The one <style> block only adjusts spacing on phones;
// the email reads correctly without it. Each email also carries a plain-text
// version (mail servers trust a message more when it has one).

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

const C = {
  page: '#F5F3EF',
  card: '#FFFFFF',
  line: '#ECE9E4',
  ink: '#1C1B1A',
  body: '#4B4A48',
  muted: '#8A8782',
  accent: '#D96F1F',
  accentSoft: '#F2994A',
  tint: '#FDF4EB',
  tintLine: '#F6DDC6',
  soft: '#F7F6F3',
  danger: '#C8372D',
  dangerTint: '#FDECEA',
  success: '#2E8B57',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";

// Names, notification text and AI-written report text all come from outside
// this file — anything interpolated into the HTML goes through here first.
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Escaped, with the writer's own line breaks kept. */
function escapeMultiline(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

/** A link the reader can actually open: an http(s) address that isn't this machine. */
export function publicAppUrl(appUrl?: string): string | undefined {
  const url = (appUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return undefined;
  return /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url) ? undefined : url;
}

// ---- building blocks -----------------------------------------------------------------

const p = (html: string, extra = '') => `<p style="margin:0 0 14px 0;${extra}">${html}</p>`;

const eyebrow = (text: string, color = C.accent) =>
  `<div style="margin:0 0 8px 0;font-family:${FONT};font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${color};">${text}</div>`;

/** The main thing to do, as a button that also works in Outlook (a coloured table cell, not CSS alone). */
function button(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btn" style="margin:22px 0 4px 0;">
      <tr>
        <td align="center" bgcolor="${C.accent}" style="border-radius:10px;background:${C.accent};background-image:linear-gradient(135deg,${C.accentSoft},${C.accent});">
          <a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:10px;">${label}&nbsp;&rarr;</a>
        </td>
      </tr>
    </table>`;
}

/** A one-time code, large enough to read at a glance and easy to select. */
function codeBlock(code: string, caption: string, expires: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 20px 0;">
      <tr>
        <td align="center" bgcolor="${C.tint}" style="padding:22px 16px 20px 16px;background:${C.tint};border:1px solid ${C.tintLine};border-radius:14px;">
          <div style="font-family:${FONT};font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${C.muted};">${caption}</div>
          <div class="code" style="margin:8px 0 6px 0;font-family:${MONO};font-size:34px;line-height:42px;font-weight:700;letter-spacing:10px;color:${C.ink};">${escapeHtml(code)}</div>
          <div style="font-family:${FONT};font-size:13px;line-height:18px;color:${C.muted};">${expires}</div>
        </td>
      </tr>
    </table>`;
}

/** A quieter aside: the "wasn't you?" kind of note. */
function note(html: string, tone: 'neutral' | 'alert' = 'neutral'): string {
  const [background, edge] = tone === 'alert' ? [C.dangerTint, C.danger] : [C.soft, C.line];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0 0;">
      <tr>
        <td bgcolor="${background}" style="padding:14px 16px;background:${background};border-left:3px solid ${edge};border-radius:8px;font-family:${FONT};font-size:13px;line-height:20px;color:${C.body};">${html}</td>
      </tr>
    </table>`;
}

/** A short list of things, each with a tick. */
function checklist(items: [string, string][]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px 0;">
      ${items
        .map(
          ([title, detail]) => `<tr>
        <td valign="top" width="30" style="padding:8px 0;">
          <div style="width:20px;height:20px;border-radius:10px;background:${C.tint};color:${C.accent};font-family:${FONT};font-size:12px;line-height:20px;font-weight:700;text-align:center;">&#10003;</div>
        </td>
        <td valign="top" style="padding:8px 0;font-family:${FONT};font-size:14px;line-height:21px;color:${C.body};"><strong style="color:${C.ink};">${title}</strong><br>${detail}</td>
      </tr>`,
        )
        .join('')}
    </table>`;
}

interface Shell {
  /** The first words shown next to the subject in an inbox list. Plain text: the shell escapes it. */
  preview: string;
  eyebrow?: string;
  title: string;
  body: string;
  /** Why the reader is getting this, under the card. */
  footer?: string;
}

function shell({ preview, eyebrow: kicker, title, body, footer }: Shell): string {
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>${title}</title>
    <style>
      @media only screen and (max-width: 600px) {
        .wrap { width: 100% !important; }
        .outer { padding: 20px 10px !important; }
        .pad { padding: 26px 22px 28px 22px !important; }
        .title { font-size: 21px !important; line-height: 28px !important; }
        .code { font-size: 30px !important; letter-spacing: 7px !important; }
        .btn { width: 100% !important; }
        .btn a { display: block !important; text-align: center !important; }
        .stat { padding: 12px 6px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">
    <div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${C.page};">${escapeHtml(preview)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page};">
      <tr>
        <td align="center" class="outer" style="padding:36px 16px;">
          <table role="presentation" class="wrap" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:560px;">
            <tr>
              <td style="padding:0 6px 16px 6px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td width="34" height="34" align="center" bgcolor="${C.accent}" style="width:34px;height:34px;border-radius:10px;background:${C.accent};background-image:linear-gradient(135deg,${C.accentSoft},${C.accent});font-family:${FONT};font-size:17px;line-height:34px;font-weight:800;color:#FFFFFF;">H</td>
                    <td style="padding-left:10px;font-family:${FONT};font-size:19px;line-height:34px;font-weight:800;letter-spacing:-0.3px;color:${C.ink};">HaiVE</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.line};border-top:4px solid ${C.accent};border-radius:16px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td class="pad" style="padding:32px 36px 34px 36px;font-family:${FONT};font-size:15px;line-height:24px;color:${C.body};">
                      ${kicker ? eyebrow(kicker) : ''}
                      <h1 class="title" style="margin:0 0 14px 0;font-family:${FONT};font-size:23px;line-height:30px;font-weight:700;letter-spacing:-0.3px;color:${C.ink};">${title}</h1>
                      ${body}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:20px 24px 0 24px;font-family:${FONT};font-size:12px;line-height:19px;color:${C.muted};">
                ${footer ? `${footer}<br>` : ''}HaiVE &middot; the AI workspace for your team
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** The plain-text version: the same words, top to bottom. */
function plain(lines: (string | undefined | false)[]): string {
  return `${lines.filter((line): line is string => typeof line === 'string').join('\n')}\n\n— HaiVE`;
}

// ---- the emails ------------------------------------------------------------------------

export function welcomeEmail(name: string, appUrl?: string): EmailContent {
  const url = publicAppUrl(appUrl);
  const first = name.trim().split(/\s+/)[0] || 'there';
  return {
    subject: 'Welcome to HaiVE',
    html: shell({
      preview: 'Your workspace is ready — here is how to get started.',
      eyebrow: 'Welcome',
      title: `Good to have you, ${escapeHtml(first)}`,
      body: `${p('Your HaiVE workspace is ready. Sign in and you can start working with your AI agents straight away.')}
        ${checklist([
          ['Chat with your AI agents', 'Ask a question, hand over a task, get an answer.'],
          ['Connect your tools', 'Mailbox and CRM, under Settings &rsaquo; Integrations.'],
          ['Stay on top of the day', 'Your dashboard and to-dos update as you work.'],
        ])}
        ${url ? button('Open HaiVE', url) : ''}`,
      footer: 'You received this because an account was created with this email address.',
    }),
    text: plain([
      `Good to have you, ${first}.`,
      '',
      'Your HaiVE workspace is ready. Sign in and you can start working with your AI agents straight away.',
      '',
      '- Chat with your AI agents: ask a question, hand over a task, get an answer.',
      '- Connect your tools: mailbox and CRM, under Settings > Integrations.',
      '- Stay on top of the day: your dashboard and to-dos update as you work.',
      url && `\nOpen HaiVE: ${url}`,
    ]),
  };
}

export function verifyEmailOtp(code: string): EmailContent {
  return {
    subject: 'Verify your email — HaiVE',
    html: shell({
      preview: `Your verification code is ${code}. It expires in 10 minutes.`,
      eyebrow: 'Verify your email',
      title: 'Confirm it’s you',
      body: `${p('Enter this code in HaiVE to verify your email address.')}
        ${codeBlock(code, 'Verification code', 'Expires in 10 minutes')}
        ${note('<strong>Didn’t ask for this?</strong> You can ignore this email — nothing changes without the code.')}`,
      footer: 'Never share this code. HaiVE will never ask you for it.',
    }),
    text: plain([
      'Enter this code in HaiVE to verify your email address:',
      '',
      `    ${code}`,
      '',
      'It expires in 10 minutes.',
      'Didn’t ask for this? You can ignore this email — nothing changes without the code.',
      'Never share this code. HaiVE will never ask you for it.',
    ]),
  };
}

export function passwordResetOtp(code: string): EmailContent {
  return {
    subject: 'Reset your password — HaiVE',
    html: shell({
      preview: `Your password reset code is ${code}. It expires in 15 minutes.`,
      eyebrow: 'Password reset',
      title: 'Reset your password',
      body: `${p('Use this code to choose a new password.')}
        ${codeBlock(code, 'Reset code', 'Expires in 15 minutes')}
        ${note('<strong>Didn’t ask for this?</strong> Ignore this email and your password stays exactly as it is.')}`,
      footer: 'Never share this code. HaiVE will never ask you for it.',
    }),
    text: plain([
      'Use this code to choose a new password:',
      '',
      `    ${code}`,
      '',
      'It expires in 15 minutes.',
      'Didn’t ask for this? Ignore this email and your password stays exactly as it is.',
      'Never share this code. HaiVE will never ask you for it.',
    ]),
  };
}

// The title and description are whatever raised the notification — often the
// subject of a customer's email — so both are escaped.
export function notificationEmail(title: string, description: string, appUrl?: string): EmailContent {
  const url = publicAppUrl(appUrl);
  return {
    subject: title,
    html: shell({
      preview: description,
      eyebrow: 'Notification',
      title: escapeHtml(title),
      body: `${description.trim() ? p(escapeMultiline(description.trim())) : ''}
        ${url ? button('Open HaiVE', `${url}/notifications`) : p('Open HaiVE to see the details.', `color:${C.muted};font-size:13px;`)}`,
      footer: 'You get these because email notifications are on. Turn them off any time under Settings &rsaquo; Notifications.',
    }),
    text: plain([
      title,
      '',
      description.trim(),
      url ? `\nOpen HaiVE: ${url}/notifications` : '\nOpen HaiVE to see the details.',
      '',
      'You get these because email notifications are on. Turn them off any time under Settings > Notifications.',
    ]),
  };
}

export function twoFactorEnabledEmail(appUrl?: string): EmailContent {
  const url = publicAppUrl(appUrl);
  return {
    subject: 'Two-factor authentication enabled — HaiVE',
    html: shell({
      preview: 'Your account now asks for a code from your authenticator app when you sign in.',
      eyebrow: 'Security',
      title: 'Two-factor authentication is on',
      body: `${p('From now on, signing in takes your password <strong>and</strong> a code from your authenticator app. Your account is harder to get into for anyone who isn’t you.')}
        ${note(
          '<strong>Wasn’t you?</strong> Secure your account now: sign in, change your password, then turn two-factor authentication off under Settings &rsaquo; Security.',
          'alert',
        )}
        ${url ? button('Review security settings', `${url}/settings/security`) : ''}`,
      footer: 'Security emails like this one are always sent.',
    }),
    text: plain([
      'Two-factor authentication is on.',
      '',
      'From now on, signing in takes your password and a code from your authenticator app.',
      '',
      'Wasn’t you? Secure your account now: sign in, change your password, then turn two-factor authentication off under Settings > Security.',
      url && `\nReview security settings: ${url}/settings/security`,
    ]),
  };
}

const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low'] as const;
const PRIORITY_LABEL: Record<string, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
const PRIORITY_COLOR: Record<string, string> = { urgent: C.danger, high: C.accent, medium: '#C99A1A', low: C.muted };

export interface DailyReportEmailTask {
  title: string;
  priority: string;
  isOverdue: boolean;
  status: string;
}

/** "2026-10-06" → "Tuesday, 6 October 2026"; anything else is shown as it came. */
function longDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// The space between two numbers in the row below, as a cell of its own.
const STAT_GAP = '<td width="2%" style="font-size:0;line-height:0;">&nbsp;</td>';

function stat(value: number, label: string, color: string): string {
  return `<td class="stat" align="center" width="32%" bgcolor="${C.soft}" style="padding:14px 8px;background:${C.soft};border-radius:12px;">
          <div style="font-family:${FONT};font-size:24px;line-height:28px;font-weight:700;color:${color};">${value}</div>
          <div style="font-family:${FONT};font-size:11px;line-height:16px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${C.muted};">${label}</div>
        </td>`;
}

// Renders the actual EOD/morning report — the numbers, the AI summary and the
// task list grouped by priority — not a generic "your report is ready" notice
// (that's what notificationEmail above already covers for every other alert).
// Task titles and the summary are AI-written text, escaped like anything else
// from outside.
export function dailyReportEmail(
  storeName: string,
  reportType: 'morning' | 'eod',
  date: string,
  tasks: DailyReportEmailTask[],
  summary: string,
  appUrl?: string,
): EmailContent {
  const url = publicAppUrl(appUrl);
  const label = reportType === 'eod' ? 'End-of-Day Report' : 'Morning Briefing';
  const subject = `${storeName} — ${label} (${date})`;
  const done = tasks.filter((t) => t.status === 'done');
  const open = tasks.filter((t) => t.status !== 'done');
  const overdue = open.filter((t) => t.isOverdue);

  const groups = PRIORITY_ORDER.map((priority) => ({ priority, items: tasks.filter((t) => t.priority === priority) })).filter((g) => g.items.length > 0);

  const taskRow = (task: DailyReportEmailTask, last: boolean) => {
    const finished = task.status === 'done';
    const box = finished
      ? `<div style="width:18px;height:18px;border-radius:5px;background:${C.success};color:#FFFFFF;font-family:${FONT};font-size:12px;line-height:18px;font-weight:700;text-align:center;">&#10003;</div>`
      : `<div style="width:16px;height:16px;border:1px solid #CFCBC4;border-radius:5px;font-size:0;line-height:0;">&nbsp;</div>`;
    return `<tr>
          <td valign="top" width="30" style="padding:10px 0;${last ? '' : `border-bottom:1px solid ${C.line};`}">${box}</td>
          <td valign="top" style="padding:8px 0 9px 0;${last ? '' : `border-bottom:1px solid ${C.line};`}font-family:${FONT};font-size:14px;line-height:21px;color:${finished ? C.muted : C.ink};${finished ? 'text-decoration:line-through;' : ''}">${escapeHtml(task.title)}${
            task.isOverdue && !finished
              ? ` <span style="display:inline-block;margin-left:4px;padding:0 8px;border-radius:9px;background:${C.dangerTint};color:${C.danger};font-size:11px;line-height:18px;font-weight:700;text-decoration:none;white-space:nowrap;">Overdue</span>`
              : ''
          }</td>
        </tr>`;
  };

  const tasksHtml =
    groups.length === 0
      ? note('No actionable items in this report.')
      : groups
          .map(
            (group) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 0 0;">
        <tr>
          <td colspan="2" style="padding:0 0 4px 0;font-family:${FONT};font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${PRIORITY_COLOR[group.priority]};">
            <span style="display:inline-block;width:8px;height:8px;margin-right:6px;border-radius:4px;background:${PRIORITY_COLOR[group.priority]};"></span>${PRIORITY_LABEL[group.priority]} &middot; ${group.items.length}
          </td>
        </tr>
        ${group.items.map((task, index) => taskRow(task, index === group.items.length - 1)).join('')}
      </table>`,
          )
          .join('');

  const html = shell({
    preview: `${open.length} open, ${overdue.length} overdue, ${done.length} done. ${summary}`.slice(0, 160),
    eyebrow: label,
    title: escapeHtml(storeName),
    body: `${p(escapeHtml(longDate(date)), `margin-top:-8px;color:${C.muted};font-size:13px;`)}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 0 0;">
        <tr>
          ${stat(open.length, 'Open', C.ink)}
          ${STAT_GAP}
          ${stat(overdue.length, 'Overdue', overdue.length > 0 ? C.danger : C.ink)}
          ${STAT_GAP}
          ${stat(done.length, 'Done', done.length > 0 ? C.success : C.ink)}
        </tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 0 0;">
        <tr>
          <td bgcolor="${C.tint}" style="padding:16px 18px;background:${C.tint};border:1px solid ${C.tintLine};border-radius:12px;">
            ${eyebrow('Summary')}
            <div style="font-family:${FONT};font-size:14px;line-height:22px;color:${C.ink};">${escapeMultiline(summary)}</div>
          </td>
        </tr>
      </table>
      ${tasksHtml}
      ${url ? button('Open the To-Do board', `${url}/todo-eod`) : p('Open HaiVE’s To-Do / EOD page for the full board and task history.', `margin-top:22px;margin-bottom:0;color:${C.muted};font-size:13px;`)}`,
    footer: `Sent to the people who get ${reportType === 'eod' ? 'end-of-day' : 'morning'} reports for ${escapeHtml(storeName)}.`,
  });

  const text = plain([
    `${storeName} — ${label}`,
    longDate(date),
    '',
    `${open.length} open · ${overdue.length} overdue · ${done.length} done`,
    '',
    'Summary',
    summary,
    ...(groups.length === 0
      ? ['', 'No actionable items in this report.']
      : groups.flatMap((group) => [
          '',
          `${PRIORITY_LABEL[group.priority].toUpperCase()} (${group.items.length})`,
          ...group.items.map(
            (task) => `${task.status === 'done' ? '[x]' : '[ ]'} ${task.title}${task.isOverdue && task.status !== 'done' ? ' (overdue)' : ''}`,
          ),
        ])),
    url ? `\nOpen the To-Do board: ${url}/todo-eod` : '\nOpen HaiVE’s To-Do / EOD page for the full board and task history.',
  ]);

  return { subject, html, text };
}
