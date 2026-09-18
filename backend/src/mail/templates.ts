// Shared HTML shell so every transactional email looks like it came from the
// same product, without pulling in a template engine dependency for what is
// currently a handful of short, mostly-static emails.
function shell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0b0b0c;font-family:Segoe UI,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0;background:#0b0b0c;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#17171a;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 0 32px;">
                <span style="color:#f2994a;font-size:20px;font-weight:700;">HaiVE</span>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 32px 32px;color:#e8e8ea;font-size:15px;line-height:1.6;">
                <h1 style="font-size:20px;margin:0 0 16px 0;color:#ffffff;">${title}</h1>
                ${bodyHtml}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function otpBlock(code: string): string {
  return `<div style="margin:20px 0;padding:16px;background:#0b0b0c;border-radius:8px;text-align:center;">
    <span style="font-size:28px;letter-spacing:8px;font-weight:700;color:#f2994a;">${code}</span>
  </div>`;
}

export function welcomeEmail(name: string): { subject: string; html: string } {
  return {
    subject: 'Welcome to HaiVE',
    html: shell(
      `Welcome aboard, ${name}`,
      `<p>Your HaiVE workspace is ready. You can sign in and start chatting with your AI agents right away.</p>`,
    ),
  };
}

export function verifyEmailOtp(code: string): { subject: string; html: string } {
  return {
    subject: 'Verify your email — HaiVE',
    html: shell(
      'Verify your email',
      `<p>Enter this code to verify your email address. It expires in 10 minutes.</p>${otpBlock(code)}<p>If you didn't request this, you can safely ignore this email.</p>`,
    ),
  };
}

export function passwordResetOtp(code: string): { subject: string; html: string } {
  return {
    subject: 'Reset your password — HaiVE',
    html: shell(
      'Reset your password',
      `<p>Use this code to reset your password. It expires in 15 minutes.</p>${otpBlock(code)}<p>If you didn't request this, you can safely ignore this email — your password won't change.</p>`,
    ),
  };
}

export function notificationEmail(title: string, description: string): { subject: string; html: string } {
  return {
    subject: title,
    html: shell(
      title,
      `<p>${description}</p><p style="margin-top:24px;color:#9a9aa0;font-size:13px;">You're receiving this because email notifications are enabled in your HaiVE Settings — you can turn them off any time under Settings &rsaquo; Notifications.</p>`,
    ),
  };
}

export function twoFactorEnabledEmail(): { subject: string; html: string } {
  return {
    subject: 'Two-factor authentication enabled — HaiVE',
    html: shell(
      'Two-factor authentication is now on',
      `<p>Your account now requires a code from your authenticator app to sign in, in addition to your password.</p><p>If you didn't make this change, secure your account immediately: sign in, change your password, and disable two-factor authentication under Settings &rsaquo; Security.</p>`,
    ),
  };
}

// Task titles/summary below are AI-generated text (see crew_reports.py /
// anthropic_client.py's extract_report_structure) — untrusted like any other
// user-adjacent content, so it's escaped before going into the HTML body,
// unlike this file's other templates which only ever interpolate static or
// numeric (OTP) text.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low'] as const;
const PRIORITY_LABEL: Record<string, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
const PRIORITY_COLOR: Record<string, string> = { urgent: '#e05252', high: '#f2994a', medium: '#e8b93f', low: '#8a8a90' };

export interface DailyReportEmailTask {
  title: string;
  priority: string;
  isOverdue: boolean;
  status: string;
}

// Renders the actual EOD/morning report — task list grouped by priority plus
// the AI summary — not a generic "your report is ready" notice (that's what
// notificationEmail above already covers for every other kind of alert).
export function dailyReportEmail(
  storeName: string,
  reportType: 'morning' | 'eod',
  date: string,
  tasks: DailyReportEmailTask[],
  summary: string,
): { subject: string; html: string } {
  const label = reportType === 'eod' ? 'End-of-Day Report' : 'Morning Briefing';
  const subject = `${storeName} — ${label} (${date})`;

  const groups = PRIORITY_ORDER.map((p) => ({ priority: p, items: tasks.filter((t) => t.priority === p) })).filter(
    (g) => g.items.length > 0,
  );

  const tasksHtml =
    groups.length === 0
      ? '<p style="color:#9a9aa0;">No actionable items in this report.</p>'
      : groups
          .map(
            (g) => `<div style="margin:0 0 16px 0;">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:${PRIORITY_COLOR[g.priority]};margin-bottom:6px;">${PRIORITY_LABEL[g.priority]}</div>
        <ul style="margin:0;padding-left:20px;">
          ${g.items
            .map(
              (t) =>
                `<li style="margin-bottom:4px;${t.status === 'done' ? 'color:#9a9aa0;text-decoration:line-through;' : ''}">${escapeHtml(t.title)}${t.isOverdue ? ' <span style="color:#e05252;font-size:12px;">(overdue)</span>' : ''}</li>`,
            )
            .join('')}
        </ul>
      </div>`,
          )
          .join('');

  return {
    subject,
    html: shell(
      `${storeName} — ${label}`,
      `<p style="color:#9a9aa0;font-size:13px;margin:0 0 20px 0;">${date}</p>
      ${tasksHtml}
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid #2a2a2e;">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:#9a9aa0;margin-bottom:6px;">Summary</div>
        <p style="margin:0;">${escapeHtml(summary)}</p>
      </div>
      <p style="margin-top:24px;color:#9a9aa0;font-size:13px;">Open HaiVE's To-Do / EOD page for the full board and task history.</p>`,
    ),
  };
}
