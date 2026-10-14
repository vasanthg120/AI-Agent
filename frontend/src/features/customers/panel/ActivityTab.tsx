import {
  FiBriefcase,
  FiCheckSquare,
  FiClock,
  FiCreditCard,
  FiEdit3,
  FiFileText,
  FiInbox,
  FiLayers,
  FiMail,
  FiMessageSquare,
  FiPaperclip,
  FiSend,
  FiShoppingBag,
  FiUserPlus,
} from 'react-icons/fi';
import type { IconType } from 'react-icons';
import clsx from 'clsx';
import { Badge } from '@/components/ui';
import type { CustomerDetail, TimelineEvent } from '@/services/customersService';
import { formatDate, formatMoney } from '../format';
import detailStyles from '../customer-detail.module.css';

const TIMELINE_ICON: Record<TimelineEvent['kind'], IconType> = {
  contact: FiUserPlus,
  enquiry: FiInbox,
  deal: FiBriefcase,
  quotation: FiFileText,
  order: FiShoppingBag,
  payment: FiCreditCard,
  email_received: FiMail,
  email_sent: FiSend,
  follow_up: FiClock,
  comment: FiMessageSquare,
  task: FiCheckSquare,
  file: FiPaperclip,
  status: FiEdit3,
  job: FiLayers,
};

// Everything that happened with the customer, newest first, in one line of time:
// what their records say, the email, and what the team itself wrote and did.
export function ActivityTab({ detail }: { detail: CustomerDetail }) {
  const money = (amount: number) => formatMoney(amount, detail.currency);
  if (detail.timeline.length === 0)
    return <p className={detailStyles.muted}>Nothing has happened with this customer yet.</p>;
  return (
    <ol className={detailStyles.timeline}>
      {detail.timeline.map((event, n) => {
        const Icon = TIMELINE_ICON[event.kind] ?? FiClock;
        return (
          <li
            key={`${event.at}-${n}`}
            className={clsx(detailStyles.timelineItem, event.attention && detailStyles.timelineAttention)}
          >
            <span className={detailStyles.timelineIcon}>
              <Icon aria-hidden />
            </span>
            <div className={detailStyles.timelineBody}>
              <div className={detailStyles.timelineHead}>
                <strong>{event.title}</strong>
                {event.amount ? <span>{money(event.amount)}</span> : null}
                {event.attention && event.kind === 'email_received' && <Badge variant="warning">Not answered</Badge>}
                <time dateTime={event.at}>{formatDate(event.at)}</time>
              </div>
              {event.detail && <div className={detailStyles.sub}>{event.detail}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
