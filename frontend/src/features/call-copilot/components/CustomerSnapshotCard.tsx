import { useQuery } from '@tanstack/react-query';
import { FiArrowRight, FiPhone, FiUser } from 'react-icons/fi';
import { Badge, Skeleton } from '@/components/ui';
import { dayjs } from '@/utils/date';
import { customerSnapshotService } from '@/services/customerSnapshotService';
import styles from './CustomerSnapshotCard.module.css';

const money = (amount: number, currency: string) => {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-AU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount).toLocaleString()}`;
  }
};

// Who you are about to talk to, in a few lines: new or repeat, what they bought,
// what is open, when you last spoke, and the next one or two things to do. Found
// by the call's deal, else the number dialled. Nothing shows until there is one.
export function CustomerSnapshotCard({ dealId, phone }: { dealId?: string; phone?: string }) {
  const digits = (phone ?? '').replace(/\D/g, '');
  const ref = { dealId: dealId || undefined, phone: digits.length >= 10 ? digits : undefined };
  const enabled = !!ref.dealId || !!ref.phone;
  const { data, isLoading, isError } = useQuery({
    queryKey: ['customer-snapshot', ref.dealId ?? '', ref.phone ?? ''],
    queryFn: () => customerSnapshotService.get(ref),
    enabled,
    staleTime: 60_000,
    retry: false,
  });

  if (!enabled || isError) return null;
  if (isLoading) return <Skeleton height={64} />;
  if (!data) return null;
  if (!data.found) return <p className={styles.note}>No history with this customer yet — a new contact.</p>;
  if (data.restricted) return <p className={styles.note}>An existing customer, but not one of yours — their history isn’t shown.</p>;

  const facts = [
    `${data.orders} order${data.orders === 1 ? '' : 's'}${data.revenue > 0 ? ` · ${money(data.revenue, data.currency)}` : ''}`,
    data.openQuotes > 0 ? `${data.openQuotes} open quote${data.openQuotes === 1 ? '' : 's'} · ${money(data.openQuoteValue, data.currency)}` : null,
    data.lastContactAt ? `Last contact ${dayjs(data.lastContactAt).fromNow()}` : null,
    data.unansweredEmails > 0 ? `${data.unansweredEmails} email${data.unansweredEmails === 1 ? '' : 's'} waiting for a reply` : null,
    data.health.score !== null ? `Health ${data.health.score}/100` : null,
  ].filter((f): f is string => !!f);

  return (
    <section className={styles.card} aria-label="About this customer">
      <div className={styles.head}>
        <span className={styles.name}>
          <FiUser aria-hidden /> {data.customer.name}
          {data.customer.company && data.customer.company !== data.customer.name && <span className={styles.company}> · {data.customer.company}</span>}
        </span>
        <span className={styles.badges}>
          <Badge variant={data.stage.tone} title={data.stage.reason}>
            {data.stage.label}
          </Badge>
          {data.flags
            .filter((f) => f.key !== 'active')
            .map((f) => (
              <Badge key={f.key} variant={f.tone} title={f.reason}>
                {f.label}
              </Badge>
            ))}
        </span>
      </div>
      <p className={styles.facts}>{facts.join('  ·  ')}</p>
      {data.lastCall?.summary && (
        <p className={styles.line}>
          <FiPhone aria-hidden />
          <span className={styles.clamp} title={data.lastCall.summary}>
            Last call {dayjs(data.lastCall.at).format('D MMM')}: {data.lastCall.summary}
          </span>
        </p>
      )}
      {data.nextSteps.length > 0 && (
        <ul className={styles.steps}>
          {data.nextSteps.map((step) => (
            <li key={step}>
              <FiArrowRight aria-hidden />
              <span className={styles.clamp} title={step}>
                {step}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
