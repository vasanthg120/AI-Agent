import { FiAward, FiBriefcase, FiCheckSquare, FiClock, FiCornerUpLeft, FiMail, FiPhone, FiPhoneMissed, FiUsers } from 'react-icons/fi';
import { formatAmountIn } from '@/utils/currency';
import { formatTalkTime, formatWait, type ActivityCounts } from '@/services/teamActivityService';
import type { KpiCardDef } from './EmployeeParts';
import { changePct } from './status';

export type HeadlineTab = 'sales' | 'email' | 'calls' | 'usage';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (value: number, currency: string | null) => (currency ? formatAmountIn(value, currency) : '—');

/** The overview's headline cards: each a number, a line of context and its change since the period before; a card opens its tab. */
export function headlineCards(
  c: ActivityCounts,
  previous: ActivityCounts | undefined,
  currency: string | null,
  go: (tab: HeadlineTab) => void,
  people?: { employees: number; active: number; now: number },
): KpiCardDef[] {
  const change = (key: keyof ActivityCounts) => changePct(c[key] as number | null, previous?.[key] as number | null | undefined);
  const missed = c.emailsMissed + c.callsMissed;
  const unanswered = c.emailsUnanswered + c.callsUnanswered;
  const cards: KpiCardDef[] = [];
  if (people)
    cards.push({
      key: 'people',
      label: 'Employees active',
      icon: FiUsers,
      value: `${people.active}/${people.employees}`,
      context: people.now ? `${people.now} active in HaiVE now` : 'nobody in HaiVE right now',
      title: 'Employees who did anything in the period: time in HaiVE, a call, an email, a deal or a finished task.',
    });
  cards.push(
    {
      key: 'time',
      label: 'Active time',
      icon: FiClock,
      value: formatTalkTime(c.activeSeconds),
      context: `${formatTalkTime(c.haiveSeconds)} in HaiVE · ${formatTalkTime(c.talkSeconds)} on calls`,
      change: change('activeSeconds'),
      onClick: () => go('usage'),
      title: 'Measured: HaiVE in active use or on a call — never an open tab nobody touches.',
    },
    {
      key: 'revenue',
      label: 'Revenue won',
      icon: FiAward,
      value: money(c.wonValue, currency),
      context: `${plural(c.dealsWon, 'deal')} won${c.dealConversionPct !== null ? ` · ${c.dealConversionPct}% win rate` : ''}`,
      change: currency ? change('wonValue') : null,
      onClick: () => go('sales'),
    },
    {
      key: 'deals',
      label: 'Deals created',
      icon: FiBriefcase,
      value: String(c.dealsCreated),
      context: `${c.dealsLost} lost · ${c.openDeals} open now`,
      change: change('dealsCreated'),
      onClick: () => go('sales'),
    },
    {
      key: 'emails',
      label: 'Emails sent',
      icon: FiMail,
      value: String(c.emailsSent),
      context: `${c.emailsReplied} customer replies${c.avgResponseSeconds !== null ? ` · avg ${formatWait(c.avgResponseSeconds)}` : ''}`,
      change: change('emailsSent'),
      onClick: () => go('email'),
    },
    {
      key: 'calls',
      label: 'Calls',
      icon: FiPhone,
      value: String(c.calls),
      context: `${c.callsMade} out · ${c.callsReceived} in${c.callConnectionRatePct !== null ? ` · ${c.callConnectionRatePct}% connected` : ''}`,
      change: change('calls'),
      onClick: () => go('calls'),
    },
    {
      key: 'missed',
      label: 'Missed',
      icon: FiPhoneMissed,
      value: String(missed),
      context: `${plural(c.emailsMissed, 'email')} · ${plural(c.callsMissed, 'call')} missed · ${unanswered} unanswered`,
      change: changePct(missed, previous ? previous.emailsMissed + previous.callsMissed : undefined),
      goodWhen: 'down',
      tone: missed > 0 ? 'danger' : undefined,
      onClick: () => go('email'),
      title: 'Customer emails that went 24 hours without a reply, and incoming calls nobody answered. Unanswered: emails still owed a reply and outgoing calls nobody picked up.',
    },
    {
      key: 'tasks',
      label: 'Tasks done',
      icon: FiCheckSquare,
      value: String(c.followUpsCompleted),
      context: `${c.followUpsPending} open · ${c.followUpsOverdue} overdue`,
      change: change('followUpsCompleted'),
      tone: c.followUpsOverdue > 0 ? 'warning' : undefined,
    },
  );
  // One person: how fast they reply, where the team view has its head count.
  if (!people)
    cards.splice(5, 0, {
      key: 'reply',
      label: 'Average reply time',
      icon: FiCornerUpLeft,
      value: formatWait(c.avgResponseSeconds),
      context: `${c.emailsUnanswered} customer email${c.emailsUnanswered === 1 ? '' : 's'} still unanswered`,
      change: changePct(c.avgResponseSeconds, previous?.avgResponseSeconds),
      goodWhen: 'down',
      onClick: () => go('email'),
      title: 'How long customers waited for their replies, on average — written in HaiVE or Outlook.',
    });
  return cards;
}
