import { useState } from 'react';
import toast from 'react-hot-toast';
import {
  FiAlertCircle,
  FiArrowRight,
  FiBriefcase,
  FiCheckCircle,
  FiCopy,
  FiCpu,
  FiCreditCard,
  FiFileText,
  FiInbox,
  FiLayers,
  FiMail,
  FiPhone,
  FiRefreshCw,
  FiShoppingBag,
} from 'react-icons/fi';
import type { IconType } from 'react-icons';
import clsx from 'clsx';
import { Badge, Button } from '@/components/ui';
import type {
  CustomerAnalysis,
  CustomerDetail,
  Journey,
  JourneyStep,
  OrderComparison,
  RecordKind,
} from '@/services/customersService';
import { formatRelativeTime } from '@/utils/date';
import { formatDate, formatMoney } from '../format';
import { CRM_VARIANT, FLAG_LABEL, FLAG_VARIANT, MAIL_VARIANT, PAYMENT_VARIANT, TYPE_VARIANT } from '../status';
import detailStyles from '../customer-detail.module.css';
import styles from './panel.module.css';

export const RECORD_ICON: Record<RecordKind, IconType> = {
  inquiry: FiInbox,
  deal: FiBriefcase,
  quotation: FiFileText,
  job: FiLayers,
  invoice: FiShoppingBag,
  payment: FiCreditCard,
};

const copy = (value: string, what: string) =>
  void navigator.clipboard.writeText(value).then(() => toast.success(`${what} copied`));
const dash = '—';

// The first tab: what to do now, who the customer is, how their records hang
// together, what they asked, and the figures at a glance.
export function DetailsTab({
  detail,
  analyzing,
  onAnalyze,
  onOpenDocument,
  onOpenJob,
}: {
  detail: CustomerDetail;
  analyzing: boolean;
  onAnalyze: (refresh: boolean) => void;
  onOpenDocument: (id: string) => void;
  onOpenJob?: (jobId: string, number?: string) => void;
}) {
  const money = (amount: number) => formatMoney(amount, detail.currency);
  const { orders, quotes, invoices, payment, mail, inquiry } = detail;
  const notRecorded = <span className={detailStyles.unknown}>Not recorded</span>;
  return (
    <>
      <div
        className={clsx(detailStyles.actionBanner, detailStyles[`action_${detail.nextAction.urgency}`])}
        role="status"
      >
        {detail.nextAction.urgency === 'none' ? <FiCheckCircle aria-hidden /> : <FiAlertCircle aria-hidden />}
        <div className={detailStyles.actionText}>
          <strong>{detail.nextAction.title}</strong>
          <div>{detail.nextAction.detail}</div>
        </div>
      </div>

      <div className={detailStyles.badges}>
        <Badge variant={TYPE_VARIANT[detail.type]}>{detail.typeLabel} customer</Badge>
        <Badge variant={detail.active ? 'success' : 'neutral'}>{detail.active ? 'Active' : 'Inactive'}</Badge>
        <Badge variant={CRM_VARIANT[detail.crm.status]}>{detail.crm.label}</Badge>
        {detail.flags.map((flag) => (
          <Badge key={flag} variant={FLAG_VARIANT[flag]}>
            {FLAG_LABEL[flag]}
          </Badge>
        ))}
      </div>

      <CustomerInformation detail={detail} />

      <Journeys journeys={detail.journeys} onOpenDocument={onOpenDocument} onOpenJob={onOpenJob} />

      <AnalysisPanel detail={detail} busy={analyzing} onRun={onAnalyze} />

      <dl className={detailStyles.summaryGrid}>
        <div className={detailStyles.summaryCell}>
          <dt>Orders</dt>
          <dd>{orders.count > 0 ? money(orders.totalValue) : 'None yet'}</dd>
          <span className={detailStyles.summaryNote}>
            {orders.count > 0
              ? `${orders.count} order${orders.count === 1 ? '' : 's'}${orders.lastOrderAt ? ` · last ${formatDate(orders.lastOrderAt)}` : ''}`
              : detail.typeReason}
          </span>
        </div>
        <div className={detailStyles.summaryCell}>
          <dt>Open quotes</dt>
          <dd>{quotes.openCount > 0 ? money(quotes.openValue) : 'None'}</dd>
          <span className={detailStyles.summaryNote}>
            {quotes.count} quotation{quotes.count === 1 ? '' : 's'} in total
          </span>
        </div>
        <div className={detailStyles.summaryCell}>
          <dt>Invoiced</dt>
          <dd>{invoices.count > 0 ? money(invoices.total) : 'Nothing yet'}</dd>
          <span className={detailStyles.summaryNote}>
            {invoices.count} invoice{invoices.count === 1 ? '' : 's'}
          </span>
        </div>
        <div className={detailStyles.summaryCell}>
          <dt>Paid</dt>
          <dd>{payment.status === 'nothing_due' ? dash : payment.paid === null ? notRecorded : money(payment.paid)}</dd>
          <span className={detailStyles.summaryNote}>
            {payment.status === 'nothing_due' ? 'Nothing billed' : `of ${money(payment.billed)} billed`}
          </span>
        </div>
        <div className={detailStyles.summaryCell}>
          <dt>Outstanding</dt>
          <dd>
            {payment.status === 'nothing_due'
              ? dash
              : payment.outstanding === null
                ? notRecorded
                : money(payment.outstanding)}
          </dd>
          <span className={detailStyles.summaryNote}>
            {payment.status === 'nothing_due' ? (
              'Nothing due'
            ) : (
              <Badge variant={PAYMENT_VARIANT[payment.status]}>{payment.label}</Badge>
            )}
          </span>
        </div>
        <div className={detailStyles.summaryCell}>
          <dt>Email</dt>
          <dd>
            <Badge variant={MAIL_VARIANT[mail.status]}>{mail.label}</Badge>
          </dd>
          <span className={detailStyles.summaryNote}>
            {mail.received} received · {mail.sent} sent
          </span>
        </div>
      </dl>

      {inquiry && (
        <section className={detailStyles.section}>
          <h3>
            Current inquiry
            <span className={detailStyles.sectionCount}>
              {inquiry.receivedAt ? `Received ${formatDate(inquiry.receivedAt)}` : ''}
              {detail.inquiries.count > 1 ? ` · ${detail.inquiries.count} inquiries in all` : ''}
            </span>
          </h3>
          {inquiry.fields.length > 0 ? (
            <dl className={detailStyles.named}>
              {inquiry.fields.map((item, n) => (
                <div key={`${item.name}-${n}`}>
                  {/* A lone "Message" needs no label. */}
                  {inquiry.fields.length > 1 && <dt>{item.name}</dt>}
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className={detailStyles.muted}>They didn’t write a message.</p>
          )}
          <div className={detailStyles.chips}>
            {[inquiry.location, inquiry.channel, inquiry.form, `via ${inquiry.source}`]
              .filter((value): value is string => !!value)
              .map((value) => (
                <span key={value} className={detailStyles.chip}>
                  {value}
                </span>
              ))}
          </div>
        </section>
      )}

      {detail.comparison && <Comparison comparison={detail.comparison} money={money} />}

      {detail.gaps.length > 0 && (
        <section className={detailStyles.section}>
          <h3>Missing or conflicting information</h3>
          <ul className={detailStyles.insightList}>
            {detail.gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

// Who they are and how to reach them — every person their records name, one click each.
function CustomerInformation({ detail }: { detail: CustomerDetail }) {
  const people = detail.people.filter((p) => p.name || p.email || p.phone);
  return (
    <section className={detailStyles.section}>
      <h3>Customer information</h3>
      <div className={styles.infoCard}>
        <dl className={styles.infoGrid}>
          <div>
            <dt>Company</dt>
            <dd>{detail.company ?? dash}</dd>
          </div>
          <div>
            <dt>Owner</dt>
            <dd>{detail.owner ?? dash}</dd>
          </div>
          <div>
            <dt>Known to</dt>
            <dd>{detail.sources.join(' + ') || dash}</dd>
          </div>
          {detail.address && (
            <div className={styles.infoWide}>
              <dt>Address</dt>
              <dd>{detail.address}</dd>
            </div>
          )}
        </dl>
        {people.length === 0 ? (
          <p className={detailStyles.muted}>No contact person, email address or phone number is on record.</p>
        ) : (
          <ul className={styles.people} aria-label="Contact people">
            {people.map((person, n) => (
              <li key={`${person.email ?? person.phone ?? person.name}-${n}`}>
                <span className={styles.personName}>{person.name ?? 'Name not recorded'}</span>
                <span className={styles.personReach}>
                  {person.email && (
                    <>
                      <a className={detailStyles.contactLink} href={`mailto:${person.email}`}>
                        <FiMail aria-hidden /> {person.email}
                      </a>
                      <button
                        type="button"
                        className={styles.iconLink}
                        aria-label={`Copy ${person.email}`}
                        title="Copy email"
                        onClick={() => copy(person.email!, 'Email')}
                      >
                        <FiCopy aria-hidden />
                      </button>
                    </>
                  )}
                  {person.phone && (
                    <a className={detailStyles.contactLink} href={`tel:${person.phone.replace(/[^+\d]/g, '')}`}>
                      <FiPhone aria-hidden /> {person.phone}
                    </a>
                  )}
                  {!person.email && !person.phone && <span className={detailStyles.muted}>No email or phone</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// How their records hang together: inquiry → deal → quotation → job → invoice → payment,
// one chain per piece of business. A quotation, an invoice or a job opens in full.
function Journeys({
  journeys,
  onOpenDocument,
  onOpenJob,
}: {
  journeys: Journey[];
  onOpenDocument: (id: string) => void;
  onOpenJob?: (jobId: string, number?: string) => void;
}) {
  const [all, setAll] = useState(false);
  if (journeys.length === 0) return null;
  const shown = all ? journeys : journeys.slice(0, 2);
  // The job is named in the heading only once there is one: most customers have none.
  const hasJob = journeys.some((journey) => journey.steps.some((step) => step.kind === 'job'));
  return (
    <section className={detailStyles.section}>
      <h3>
        How their records connect
        <span className={detailStyles.sectionCount}>
          Inquiry → deal → quotation → {hasJob ? 'job → ' : ''}invoice → payment
        </span>
      </h3>
      <div className={styles.journeys}>
        {shown.map((journey, n) => (
          <ol key={n} className={styles.journey}>
            {journey.steps.map((step, index) => (
              <li key={`${step.kind}-${index}`} className={styles.journeyItem}>
                {index > 0 && <FiArrowRight aria-hidden className={styles.journeyArrow} />}
                <JourneyStepCard step={step} onOpenDocument={onOpenDocument} onOpenJob={onOpenJob} />
              </li>
            ))}
          </ol>
        ))}
      </div>
      {journeys.length > 2 && (
        <button type="button" className={styles.textButton} onClick={() => setAll((value) => !value)}>
          {all ? 'Show only the latest' : `Show ${journeys.length - 2} earlier`}
        </button>
      )}
    </section>
  );
}

export function JourneyStepCard({
  step,
  onOpenDocument,
  onOpenJob,
}: {
  step: JourneyStep;
  onOpenDocument?: (id: string) => void;
  onOpenJob?: (jobId: string, number?: string) => void;
}) {
  const Icon = RECORD_ICON[step.kind];
  const open =
    step.documentId && onOpenDocument
      ? () => onOpenDocument(step.documentId!)
      : step.jobId && onOpenJob
        ? () => onOpenJob(step.jobId!, step.title.replace(/^Job\s+/, ''))
        : undefined;
  const body = (
    <>
      <span className={clsx(styles.stepDot, styles[`tone_${step.tone}`])}>
        <Icon aria-hidden />
      </span>
      <span className={styles.stepText}>
        <strong>{step.title}</strong>
        {step.detail && <span>{step.detail}</span>}
        {step.at && (
          <time
            dateTime={step.at}
            title={step.byDate ? 'Placed here by its date: the one before this quotation' : undefined}
          >
            {formatDate(step.at)}
          </time>
        )}
      </span>
    </>
  );
  return open ? (
    <button type="button" className={clsx(styles.step, styles.stepLink)} title={`Open ${step.title}`} onClick={open}>
      {body}
    </button>
  ) : (
    <div className={styles.step}>{body}</div>
  );
}

function Comparison({ comparison, money }: { comparison: OrderComparison; money: (amount: number) => string }) {
  const { previous, current, valueDifference, valueDifferencePct, marginDifference } = comparison;
  const margin = (value: number | null) => (value === null ? 'Not recorded' : `${value}%`);
  const side = (title: string, item: OrderComparison['previous']) => (
    <div>
      <h4>{title}</h4>
      <dl>
        <dt>{item.label}</dt>
        <dd>{item.date ? formatDate(item.date) : dash}</dd>
        <dt>Value</dt>
        <dd>{money(item.value)}</dd>
        <dt>Margin</dt>
        <dd>{margin(item.marginPct)}</dd>
      </dl>
    </div>
  );
  return (
    <section className={detailStyles.section}>
      <h3>Previous order against {current.isQuotation ? 'the current quotation' : 'the latest order'}</h3>
      <div className={detailStyles.compare}>
        {side('Previous order', previous)}
        {side(current.isQuotation ? 'Current quotation' : 'Latest order', current)}
        <p>
          <strong>
            {valueDifference === 0
              ? 'Same value.'
              : `${money(Math.abs(valueDifference))} ${valueDifference > 0 ? 'higher' : 'lower'}${
                  valueDifferencePct !== null ? ` (${Math.abs(valueDifferencePct)}%)` : ''
                }.`}
          </strong>{' '}
          {marginDifference !== null && marginDifference !== 0
            ? `Margin ${Math.abs(marginDifference)} points ${marginDifference > 0 ? 'up' : 'down'}. `
            : ''}
          {comparison.note}
        </p>
      </div>
    </section>
  );
}

function AnalysisPanel({
  detail,
  busy,
  onRun,
}: {
  detail: CustomerDetail;
  busy: boolean;
  onRun: (refresh: boolean) => void;
}) {
  const analysis: CustomerAnalysis | null = detail.analysis;
  if (!analysis) {
    return (
      <section className={detailStyles.analysis}>
        <div className={detailStyles.analysisFoot}>
          <h3>
            <FiCpu aria-hidden /> Summary
          </h3>
          <Button type="button" size="sm" leftIcon={<FiCpu />} loading={busy} onClick={() => onRun(false)}>
            Analyze with AI
          </Button>
        </div>
        <p>{detail.insight}</p>
      </section>
    );
  }
  return (
    <section className={detailStyles.analysis}>
      <div className={detailStyles.analysisFoot}>
        <h3>
          <FiCpu aria-hidden /> AI analysis
        </h3>
        {analysis.statusLabel && <Badge variant="accent">{analysis.statusLabel}</Badge>}
      </div>
      <p>{analysis.summary}</p>
      {analysis.nextAction && (
        <p>
          <strong>Next step:</strong> {analysis.nextAction}
        </p>
      )}
      {analysis.recommendations.length > 0 && (
        <ul className={detailStyles.insightList}>
          {analysis.recommendations.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      {analysis.pricingAdvice && (
        <p>
          <strong>Pricing:</strong> {analysis.pricingAdvice}
        </p>
      )}
      {analysis.issues.length > 0 && (
        <>
          <strong className={detailStyles.subhead}>Check these</strong>
          <ul className={detailStyles.insightList}>
            {analysis.issues.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      )}
      {analysis.suggestedMessage && (
        <div className={detailStyles.suggestion}>
          <div className={detailStyles.suggestionHead}>
            <strong>Message draft</strong>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              leftIcon={<FiCopy />}
              onClick={() => copy(analysis.suggestedMessage, 'Draft')}
            >
              Copy
            </Button>
          </div>
          <p>{analysis.suggestedMessage}</p>
        </div>
      )}
      <div className={detailStyles.analysisFoot}>
        <span className={detailStyles.sub}>
          Written {formatRelativeTime(analysis.generatedAt)}
          {analysis.stale ? ' · there has been new activity since' : ''}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          leftIcon={<FiRefreshCw />}
          loading={busy}
          onClick={() => onRun(true)}
        >
          {analysis.stale ? 'Update' : 'Analyze again'}
        </Button>
      </div>
    </section>
  );
}
