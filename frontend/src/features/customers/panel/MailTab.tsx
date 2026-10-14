import { useNavigate } from 'react-router-dom';
import { FiArrowDownLeft, FiArrowUpRight, FiClock, FiExternalLink } from 'react-icons/fi';
import clsx from 'clsx';
import { Badge } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import type { CustomerDetail, CustomerFollowUp } from '@/services/customersService';
import { formatDate } from '../format';
import { MAIL_VARIANT } from '../status';
import detailStyles from '../customer-detail.module.css';
import styles from './panel.module.css';

const FOLLOW_UP_BADGE = (followUp: CustomerFollowUp) =>
  followUp.status === 'done'
    ? ({ variant: 'success', label: 'Done' } as const)
    : followUp.status === 'dismissed'
      ? ({ variant: 'neutral', label: 'Dismissed' } as const)
      : followUp.due
        ? ({ variant: 'danger', label: 'Due' } as const)
        : ({ variant: 'info', label: 'Planned' } as const);

// The email exchanged with the customer and the follow-ups set on it. An email
// from them opens in AI Email Inbox, where it can be answered.
export function MailTab({ detail }: { detail: CustomerDetail }) {
  const navigate = useNavigate();
  const { mail, emails, followUps } = detail;
  const speed = [
    detail.customerRepliesInDays !== null
      ? `They usually reply within ${detail.customerRepliesInDays < 1 ? 'a day' : `${Math.round(detail.customerRepliesInDays)} days`}.`
      : '',
    detail.weReplyInHours !== null
      ? `You usually answer them within ${detail.weReplyInHours < 1 ? 'an hour' : `${Math.round(detail.weReplyInHours)} hours`}.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  const inInbox = (id: string) => navigate(`${ROUTES.emailIntelligence}?openEmailId=${encodeURIComponent(id)}`);

  return (
    <>
      <div className={styles.mailSummary}>
        <Badge variant={MAIL_VARIANT[mail.status]}>{mail.label}</Badge>
        <span>
          {mail.received} received · {mail.sent} sent
          {mail.unanswered > 0 ? ` · ${mail.unanswered} waiting for a reply` : ''}
        </span>
      </div>
      {speed && <p className={detailStyles.muted}>{speed}</p>}

      {followUps.length > 0 && (
        <section className={detailStyles.section}>
          <h3>
            Follow-ups <span className={detailStyles.sectionCount}>{followUps.length}</span>
          </h3>
          <ul className={styles.list}>
            {followUps.map((followUp, n) => {
              const badge = FOLLOW_UP_BADGE(followUp);
              return (
                <li
                  key={`${followUp.dueDate}-${n}`}
                  className={clsx(styles.listRow, followUp.due && styles.listRowDue)}
                >
                  <FiClock aria-hidden className={styles.listIcon} />
                  <div className={styles.listMain}>
                    <strong>{followUp.title}</strong>
                    <span>Due {formatDate(followUp.dueDate)}</span>
                  </div>
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className={detailStyles.section}>
        <h3>
          Emails <span className={detailStyles.sectionCount}>{emails.length ? `latest ${emails.length}` : ''}</span>
        </h3>
        {emails.length === 0 ? (
          <p className={detailStyles.muted}>
            {detail.email
              ? 'No email has been exchanged with this customer yet.'
              : 'No email address is on record for this customer, so their email can’t be matched.'}
          </p>
        ) : (
          <ul className={styles.list}>
            {emails.map((email) => {
              const received = email.direction === 'received';
              return (
                <li
                  key={`${email.direction}-${email.id}`}
                  className={clsx(styles.listRow, email.needsReply && styles.listRowDue)}
                >
                  {received ? (
                    <FiArrowDownLeft aria-label="From the customer" className={styles.listIcon} />
                  ) : (
                    <FiArrowUpRight aria-label="Sent to the customer" className={styles.listIcon} />
                  )}
                  <div className={styles.listMain}>
                    <strong>{email.subject}</strong>
                    <span>
                      {received ? 'From the customer' : 'Sent to the customer'} · {formatDate(email.at)}
                    </span>
                  </div>
                  {email.needsReply && <Badge variant="danger">Not answered</Badge>}
                  {received && (
                    <button
                      type="button"
                      className={styles.iconLink}
                      title="Open in AI Email Inbox"
                      aria-label={`Open “${email.subject}” in AI Email Inbox`}
                      onClick={() => inInbox(email.id)}
                    >
                      <FiExternalLink aria-hidden />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
