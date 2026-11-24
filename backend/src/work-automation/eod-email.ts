import type { EmailContent } from '../mail/templates';
import { headlineSentence } from './eod-sections';
import { EodSections, TaskSnapshot } from './schemas/eod-report.schema';

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const due = (d?: Date | string) => (d ? new Date(d).toISOString().slice(0, 10) : '');

function section(title: string, items: TaskSnapshot[], showEvidence = false): { html: string; text: string } {
  if (items.length === 0) return { html: '', text: '' };
  const rows = items
    .slice(0, 30)
    .map((t) => {
      const meta = [t.priority, t.dueDate ? `due ${due(t.dueDate)}` : '', t.sourcePlatform].filter(Boolean).join(' · ');
      const ev = showEvidence && t.evidence ? `<br><span style="color:#8A8782;font-size:12px">Verified: ${esc(t.evidence.detail)}</span>` : '';
      return `<li style="margin:0 0 8px">${esc(t.title)} <span style="color:#8A8782;font-size:12px">(${esc(meta)})</span>${ev}</li>`;
    })
    .join('');
  const more = items.length > 30 ? `<p style="color:#8A8782;font-size:12px">…and ${items.length - 30} more in Haive.</p>` : '';
  const text = [`${title} (${items.length})`, ...items.slice(0, 30).map((t) => `- ${t.title} [${t.priority}${t.dueDate ? `, due ${due(t.dueDate)}` : ''}]${showEvidence && t.evidence ? ` — verified: ${t.evidence.detail}` : ''}`)].join('\n');
  return { html: `<h3 style="margin:20px 0 8px;font-size:15px">${esc(title)} (${items.length})</h3><ul style="padding-left:18px;margin:0">${rows}</ul>${more}`, text };
}

export interface EodEmailInput {
  employeeName: string;
  date: string;
  timezone: string;
  summary: string;
  summarySource?: string;
  sections: EodSections;
  dataGaps: string[];
  appUrl?: string;
  /** Who is reading: the employee, or their manager (wording only). */
  audience: 'employee' | 'manager' | 'admin';
}

/** The EOD report as an email: counts and lists are the stored sections; the AI narrative is labelled as such. */
export function eodReportEmail(i: EodEmailInput): EmailContent {
  const s = i.sections;
  const subject = `End-of-day report — ${i.employeeName} (${i.date})`;
  const blocks = [
    section('Completed', s.completed, true),
    section('Overdue', s.overdue),
    section('Blocked', s.blocked),
    section('Awaiting verification', s.awaitingVerification),
    section('Pending', s.pending),
    section('Customer follow-ups still open', s.customerFollowUps.pending),
    section('Next-day priorities', s.nextDayPriorities),
  ];
  const meetings = s.meetings.items.length
    ? {
        html: `<h3 style="margin:20px 0 8px;font-size:15px">Meetings (${s.meetings.items.length})</h3><ul style="padding-left:18px;margin:0">${s.meetings.items.map((m) => `<li>${esc(m.title)}</li>`).join('')}</ul>`,
        text: `Meetings (${s.meetings.items.length})\n${s.meetings.items.map((m) => `- ${m.title}`).join('\n')}`,
      }
    : { html: '', text: '' };
  const crm = s.crmUpdates.length
    ? {
        html: `<h3 style="margin:20px 0 8px;font-size:15px">CRM updates (${s.crmUpdates.length})</h3><ul style="padding-left:18px;margin:0">${s.crmUpdates.slice(0, 20).map((c) => `<li>${esc(c.entity)} ${esc(c.kind)}${c.customerName ? ` — ${esc(c.customerName)}` : ''}</li>`).join('')}</ul>`,
        text: `CRM updates (${s.crmUpdates.length})\n${s.crmUpdates.slice(0, 20).map((c) => `- ${c.entity} ${c.kind}${c.customerName ? ` — ${c.customerName}` : ''}`).join('\n')}`,
      }
    : { html: '', text: '' };

  const counts = `${s.counts.completed} completed · ${s.counts.pending} pending · ${s.counts.overdue} overdue${s.counts.blocked ? ` · ${s.counts.blocked} blocked` : ''}${s.counts.awaitingVerification ? ` · ${s.counts.awaitingVerification} awaiting verification` : ''}`;
  const narrativeLabel = i.summarySource === 'ai' ? 'AI summary of the verified records below' : 'Summary';
  const headline = s.assessment ? headlineSentence(s.assessment, s.counts) : '';
  const headlineHtml = headline ? `<p style="background:#F7F6F3;border:1px solid #ECE9E4;padding:10px;font-size:13px">${esc(headline)}</p>` : '';
  const gaps = i.dataGaps.length ? `<p style="background:#FDF4EB;border:1px solid #F6DDC6;padding:10px;font-size:13px"><strong>Data notes:</strong> ${i.dataGaps.map(esc).join(' ')}</p>` : '';
  const link = i.appUrl ? `<p style="margin-top:24px"><a href="${esc(i.appUrl.replace(/\/+$/, ''))}/eod" style="color:#D96F1F">Open in Haive</a></p>` : '';
  const intro = i.audience === 'admin' ? `End-of-day report for ${esc(i.employeeName)}.` : i.audience === 'manager' ? `Daily report for ${esc(i.employeeName)}, who reports to you.` : 'Here is your end-of-day report, generated from your tracked work.';

  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1C1B1A;max-width:640px;margin:0 auto;padding:16px">
<h2 style="margin:0 0 4px">End-of-day report</h2>
<p style="margin:0 0 12px;color:#8A8782">${esc(i.employeeName)} · ${esc(i.date)} (${esc(i.timezone)})</p>
<p style="font-size:14px">${intro}</p>
<p style="font-size:15px;font-weight:600">${esc(counts)}</p>
<p style="font-size:12px;color:#8A8782;margin:12px 0 2px">${esc(narrativeLabel)}</p>
<p style="font-size:14px;margin:0">${esc(i.summary)}</p>
${headlineHtml}${gaps}${blocks.map((b) => b.html).join('')}${meetings.html}${crm.html}${link}
</div>`;

  const text = [
    `End-of-day report — ${i.employeeName} (${i.date}, ${i.timezone})`,
    counts,
    '',
    `${narrativeLabel}: ${i.summary}`,
    ...(headline ? ['', headline] : []),
    ...(i.dataGaps.length ? ['', `Data notes: ${i.dataGaps.join(' ')}`] : []),
    ...[...blocks, meetings, crm].filter((b) => b.text).flatMap((b) => ['', b.text]),
    ...(i.appUrl ? ['', `Open in Haive: ${i.appUrl.replace(/\/+$/, '')}/eod`] : []),
  ].join('\n');

  return { subject, html, text };
}
