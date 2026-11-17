import { FiChevronRight } from 'react-icons/fi';
import { formatAmountIn } from '@/utils/currency';
import { formatTalkTime, type TeamActivityBusiness, type TeamActivityOverview } from '@/services/teamActivityService';
import styles from './TeamActivity.module.css';

/** People, how many were active, how well customer email was answered, follow-ups done, revenue won. */
export function TeamSummaryStrip({ overview }: { overview: TeamActivityOverview }) {
  const { summary, totals } = overview;
  const items: { value: string; label: string; title?: string }[] = [
    { value: String(summary.employees), label: 'People', title: 'Active logins of the businesses shown (the Main Account’s own records in sub-accounts aside).' },
    { value: String(summary.activeEmployees), label: 'Active in the period', title: 'People who created a deal, sent or answered an email, made a call or finished a follow-up.' },
    {
      value: summary.responseRatePct === null ? '—' : `${summary.responseRatePct}%`,
      label: 'Email response rate',
      title: 'Of the customer emails owed a reply: answered ÷ (answered + still waiting + missed).',
    },
    {
      value: summary.followUpCompletionPct === null ? '—' : `${summary.followUpCompletionPct}%`,
      label: 'Follow-ups completed',
      title: 'Follow-ups done in the period ÷ (done + still pending).',
    },
    {
      value: summary.currency ? formatAmountIn(totals.wonValue, summary.currency) : '—',
      label: `Revenue won (${totals.dealsWon} deal${totals.dealsWon === 1 ? '' : 's'})`,
      title: summary.currency ? 'Deals won in the period, by deal value.' : 'Businesses in different currencies are not added up — pick one business.',
    },
  ];
  return (
    <div className={styles.summaryStrip}>
      {items.map((item) => (
        <div key={item.label} className={styles.summaryItem} title={item.title}>
          <span className={styles.summaryValue}>{item.value}</span>
          <span className={styles.summaryLabel}>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

/** The Main Account owner's view of every business side by side; a row narrows the page to that business. */
export function BusinessesTable({ businesses, onSelect }: { businesses: TeamActivityBusiness[]; onSelect: (id: string) => void }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Business</th>
            <th className={styles.num}>People</th>
            <th className={styles.num}>Deals created</th>
            <th className={styles.num}>Won</th>
            <th className={styles.num}>Pipeline</th>
            <th className={styles.num}>Emails sent</th>
            <th className={styles.num}>Missed</th>
            <th className={styles.num}>Calls</th>
            <th className={styles.num}>Talk time</th>
            <th className={styles.num}>Score</th>
            <th aria-hidden className={styles.chevronCol} />
          </tr>
        </thead>
        <tbody>
          {businesses.map((b) => (
            <tr
              key={b.id}
              className={styles.row}
              tabIndex={0}
              onClick={() => onSelect(b.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(b.id);
                }
              }}
              aria-label={`Show only ${b.name}`}
            >
              <td>
                <span className={styles.personText}>
                  <span className={styles.businessName}>{b.name}</span>
                  <span className={styles.personSub}>{b.isMain ? 'Main Account' : 'Sub-account'}</span>
                </span>
              </td>
              <td className={styles.num}>
                {b.activeEmployees}/{b.employees}
              </td>
              <td className={styles.num}>{b.totals.dealsCreated}</td>
              <td className={styles.num}>{b.totals.dealsWon}</td>
              <td className={styles.num}>{formatAmountIn(b.totals.pipelineValue, b.currency)}</td>
              <td className={styles.num}>{b.totals.emailsSent}</td>
              <td className={styles.num}>{b.totals.emailsMissed}</td>
              <td className={styles.num}>{b.totals.calls}</td>
              <td className={styles.num}>{formatTalkTime(b.totals.talkSeconds)}</td>
              <td className={styles.num}>{b.totals.avgCallScore === null ? '—' : `${b.totals.avgCallScore}/10`}</td>
              <td className={styles.chevronCol}>
                <FiChevronRight className={styles.rowChevron} aria-hidden />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
