// Deal health — a transparent score worked out from the stored records, never
// by the AI, and kept apart from the AI's "chance to win": health says how
// well the deal is being worked (contact, replies, progress, call quality,
// timeliness), not how likely the customer is to buy.
//
// The weights are here, in one place, and add up to 100. Change them here and
// the score, its explanation and the tests all follow.
export const HEALTH_WEIGHTS = {
  recency: 25, // how recently anyone was in touch with the customer
  responsiveness: 20, // no customer email left waiting for our reply
  engagement: 15, // the customer writing or talking to us lately
  progression: 20, // a quotation sent, or accepted
  callQuality: 10, // how the AI Coach scored the calls about it
  timeliness: 10, // closing date not passed, no follow-up overdue
} as const;

export type HealthFactorKey = keyof typeof HEALTH_WEIGHTS;

export interface HealthFactor {
  key: HealthFactorKey;
  label: string;
  points: number;
  max: number;
  detail: string;
}

export interface DealHealth {
  // null for a deal already won or lost: there is nothing left to work.
  score: number | null;
  band: 'healthy' | 'watch' | 'at_risk' | 'closed';
  factors: HealthFactor[];
  risks: string[];
  improvements: string[];
}

export interface HealthInputs {
  status: 'open' | 'won' | 'lost';
  daysSinceLastContact?: number;
  waitingForReply: number;
  customerMessagesLast30Days: number;
  connectedCallsLast30Days: number;
  quoteStatuses: { status: string; approval?: string }[];
  callScores: number[];
  expectedClosingDate?: string;
  today: string;
  overdueFollowUps: number;
}

const QUOTE_DRAFT = new Set(['draft', 'voided']);

export function dealHealth(input: HealthInputs): DealHealth {
  if (input.status !== 'open') {
    return { score: null, band: 'closed', factors: [], risks: [], improvements: [] };
  }
  const factors: HealthFactor[] = [];
  const risks: string[] = [];
  const improvements: string[] = [];
  const add = (key: HealthFactorKey, label: string, share: number, detail: string) =>
    factors.push({ key, label, points: Math.round(HEALTH_WEIGHTS[key] * share), max: HEALTH_WEIGHTS[key], detail });

  const days = input.daysSinceLastContact;
  if (days === undefined) {
    add('recency', 'Recent contact', 0, 'No email or call with the customer is recorded.');
    risks.push('No contact with the customer is recorded.');
    improvements.push('Make first contact — a call or an email.');
  } else {
    const share = days <= 3 ? 1 : days <= 7 ? 0.6 : days <= 14 ? 0.2 : 0;
    add('recency', 'Recent contact', share, days === 0 ? 'In touch today.' : `Last contact ${days} day${days === 1 ? '' : 's'} ago.`);
    if (days > 7) {
      risks.push(`No contact for ${days} days.`);
      improvements.push('Get back in touch — the deal has gone quiet.');
    }
  }

  if (input.waitingForReply > 0) {
    add('responsiveness', 'Customer emails answered', 0, `${input.waitingForReply} customer email${input.waitingForReply === 1 ? ' is' : 's are'} waiting for our reply.`);
    risks.push('The customer is waiting for our reply.');
    improvements.push('Reply to the customer’s waiting email.');
  } else {
    add('responsiveness', 'Customer emails answered', 1, 'Nothing from the customer is waiting for a reply.');
  }

  const touches = input.customerMessagesLast30Days + input.connectedCallsLast30Days;
  add('engagement', 'Customer engagement', touches >= 3 ? 1 : touches >= 1 ? 0.5 : 0, `${input.customerMessagesLast30Days} email${input.customerMessagesLast30Days === 1 ? '' : 's'} from the customer and ${input.connectedCallsLast30Days} connected call${input.connectedCallsLast30Days === 1 ? '' : 's'} in the last 30 days.`);
  if (touches === 0) improvements.push('Draw the customer in — no emails or calls from them in 30 days.');

  const accepted = input.quoteStatuses.some((q) => q.approval === 'approved' || q.status === 'accepted');
  const sent = input.quoteStatuses.some((q) => !QUOTE_DRAFT.has(q.status));
  if (accepted) add('progression', 'Progress', 1, 'A quotation has been accepted.');
  else if (sent) add('progression', 'Progress', 0.6, 'A quotation has been sent, not yet accepted.');
  else {
    add('progression', 'Progress', 0, input.quoteStatuses.length ? 'Only draft quotations so far.' : 'No quotation yet.');
    improvements.push('Send a quotation.');
  }

  if (input.callScores.length === 0) add('callQuality', 'Call quality', 0.5, 'No scored calls about this deal.');
  else {
    const avg = Math.round((input.callScores.reduce((s, v) => s + v, 0) / input.callScores.length) * 10) / 10;
    add('callQuality', 'Call quality', avg >= 7 ? 1 : avg >= 5 ? 0.5 : 0, `AI Coach average ${avg}/10 over ${input.callScores.length} call${input.callScores.length === 1 ? '' : 's'}.`);
    if (avg < 5) improvements.push('Review the calls with the salesperson — they scored low.');
  }

  const pastClosing = !!input.expectedClosingDate && input.expectedClosingDate.slice(0, 10) < input.today;
  const timelyShare = (pastClosing ? 0 : 0.5) + (input.overdueFollowUps > 0 ? 0 : 0.5);
  const timelyNotes = [
    pastClosing ? `Expected to close on ${input.expectedClosingDate!.slice(0, 10)}, which has passed.` : input.expectedClosingDate ? 'Closing date still ahead.' : 'No closing date set.',
    input.overdueFollowUps > 0 ? `${input.overdueFollowUps} follow-up${input.overdueFollowUps === 1 ? ' is' : 's are'} overdue.` : 'No follow-up overdue.',
  ];
  add('timeliness', 'On schedule', timelyShare, timelyNotes.join(' '));
  if (pastClosing) {
    risks.push('The expected closing date has passed.');
    improvements.push('Agree a new closing date with the customer, or close the deal as lost.');
  }
  if (input.overdueFollowUps > 0) risks.push('A follow-up is overdue.');

  const score = factors.reduce((s, f) => s + f.points, 0);
  return { score, band: score >= 70 ? 'healthy' : score >= 40 ? 'watch' : 'at_risk', factors, risks, improvements };
}
