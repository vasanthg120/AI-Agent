import { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FiArrowDownLeft,
  FiArrowRight,
  FiArrowUpRight,
  FiChevronDown,
  FiCpu,
  FiPhone,
  FiPhoneMissed,
  FiRefreshCw,
  FiUser,
} from 'react-icons/fi';
import { Badge, Skeleton, Spinner } from '@/components/ui';
import type { BadgeVariant } from '@/components/ui';
import { dayjs } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import {
  customerSnapshotService,
  type CustomerSnapshot,
  type SnapshotAi,
  type SnapshotDetails,
  type SnapshotRef,
} from '@/services/customerSnapshotService';
import styles from './CustomerSnapshotCard.module.css';

const money = (amount: number, currency: string) => {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-AU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount).toLocaleString()}`;
  }
};
const day = (iso?: string) => (iso ? dayjs(iso).format('D MMM YYYY') : '');
const minutes = (seconds?: number) => (seconds ? `${Math.max(1, Math.round(seconds / 60))} min` : '');
// Whole days, the way the labels' reasons count them ("9 days ago", never rounded up to 10).
const daysAgo = (iso: string) => {
  const n = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
  return n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
};
const words = (value?: string) => (value ? value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const INTENT_LABEL = { very_high: 'Very high', high: 'High', medium: 'Medium', low: 'Low', unknown: 'Not enough data' };
const INTENT_TONE: Record<string, BadgeVariant> = { very_high: 'success', high: 'success', medium: 'info', low: 'warning', unknown: 'neutral' };
const TONE_OF = (sentiment?: string): BadgeVariant =>
  !sentiment ? 'neutral' : /neg/i.test(sentiment) ? 'danger' : /pos/i.test(sentiment) ? 'success' : /mix/i.test(sentiment) ? 'warning' : 'neutral';
const EMAILS_FOLDED = 5;

const keyOf = (ref: SnapshotRef) => ['customer-snapshot', ref.dealId ?? '', ref.phone ?? '', ref.sessionId ?? ''];

/** The snapshot for a call's deal, the number dialled, or a recorded call — shared by the card and the call report's Customer tab. */
export function useCustomerSnapshot({ dealId, phone, sessionId }: SnapshotRef) {
  const digits = (phone ?? '').replace(/\D/g, '');
  const ref: SnapshotRef = { dealId: dealId || undefined, phone: digits.length >= 10 ? digits : undefined, sessionId: sessionId || undefined };
  const enabled = !!ref.dealId || !!ref.phone || !!ref.sessionId;
  const query = useQuery({
    queryKey: keyOf(ref),
    queryFn: () => customerSnapshotService.get(ref),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
  return { ...query, enabled, ref };
}

// Who you are talking to: a few lines up front — new or repeat, what they bought,
// what is open, when you last spoke, the next one or two things to do — and behind
// "Show more" the whole picture: the AI's profile of them (written on its own the
// first time anyone opens it, then kept until something new happens), every email
// with the AI's reading of it, their CRM enquiry and history, calls, quotations, deals.
export function CustomerSnapshotCard({ dealId, phone, sessionId, defaultExpanded = false }: SnapshotRef & { defaultExpanded?: boolean }) {
  const { data, isLoading, isError, enabled, ref } = useCustomerSnapshot({ dealId, phone, sessionId });
  const [expanded, setExpanded] = useState(defaultExpanded);
  const customerId = data?.found && !data.restricted ? data.customer.id : undefined;
  // A different customer starts folded again (unless asked to open).
  useEffect(() => setExpanded(defaultExpanded), [customerId, defaultExpanded]);

  if (!enabled || isError) return null;
  if (isLoading) return <Skeleton height={64} />;
  if (!data) return null;
  if (!data.found) return <p className={styles.note}>No history with this customer yet — a new contact.</p>;
  if (data.restricted) return <p className={styles.note}>An existing customer, but not one of yours — their history isn’t shown.</p>;

  const facts = [
    `${plural(data.orders, 'order')}${data.revenue > 0 ? ` · ${money(data.revenue, data.currency)}` : ''}`,
    data.openQuotes > 0 ? `${plural(data.openQuotes, 'open quote')} · ${money(data.openQuoteValue, data.currency)}` : null,
    data.lastContactAt ? `Last contact ${daysAgo(data.lastContactAt)}` : null,
    data.unansweredEmails > 0 ? `${plural(data.unansweredEmails, 'email')} waiting for a reply` : null,
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
      {!expanded && data.ai.status !== 'none' && data.ai.report?.summary && (
        <p className={styles.line}>
          <FiCpu aria-hidden />
          <span className={styles.clamp} title={data.ai.report.summary}>
            {data.ai.report.summary}
          </span>
        </p>
      )}
      {!expanded && data.lastCall?.summary && (
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
              <span className={clsx(!expanded && styles.clamp)} title={step}>
                {step}
              </span>
            </li>
          ))}
        </ul>
      )}
      {expanded && (
        <>
          <AiProfile snapshotRef={ref} ai={data.ai} customerId={data.customer.id} />
          <Details details={data.details} currency={data.currency} />
        </>
      )}
      <button type="button" className={styles.toggle} aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
        {expanded ? 'Show less' : 'Show more — AI profile, emails, CRM, calls'}
        <FiChevronDown className={clsx(styles.chevron, expanded && styles.chevronOpen)} aria-hidden />
      </button>
    </section>
  );
}

// ---- the AI's profile ------------------------------------------------------------------------

// Written on its own the first time someone opens the details (and again only when
// something new happened with the customer): the AI reads every email, call, the CRM
// enquiry and history, and says where the customer stands and what to do. Each
// statement is tied to the records it rests on.
function AiProfile({ snapshotRef, ai, customerId }: { snapshotRef: SnapshotRef; ai: SnapshotAi; customerId: string }) {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tried = useRef<string | null>(null);

  const run = async (refresh: boolean) => {
    setRunning(true);
    setError(null);
    try {
      const next = await customerSnapshotService.analyze(snapshotRef, refresh);
      queryClient.setQueryData<CustomerSnapshot>(keyOf(snapshotRef), next);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  // Autonomous: no report yet, or something new happened since — write it now, once per customer per visit.
  useEffect(() => {
    if (ai.status === 'ready' || !ai.canRun || tried.current === customerId) return;
    tried.current = customerId;
    void run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, ai.status, ai.canRun]);

  const reads = `${plural(ai.reads.emails, 'email')}, ${plural(ai.reads.calls, 'call')}, ${plural(ai.reads.quotations, 'quotation')} and ${plural(ai.reads.crm, 'CRM record')}`;
  const report = ai.report;
  const cite = (ids: string[]) => {
    const labels = ids.map((id) => ai.sources[id]).filter(Boolean);
    return labels.length ? <span className={styles.cite}>From: {labels.slice(0, 3).join(' · ')}</span> : null;
  };

  return (
    <div className={styles.ai}>
      <div className={styles.aiHead}>
        <span className={styles.aiTitle}>
          <FiCpu aria-hidden /> AI profile
        </span>
        {running ? (
          <span className={styles.aiMeta}>
            <Spinner size={14} /> Reading {reads}…
          </span>
        ) : report ? (
          <span className={styles.aiMeta}>
            {ai.status === 'outdated' ? 'Something new since this was written · ' : ''}
            {ai.generatedAt ? `Written ${dayjs(ai.generatedAt).fromNow()}` : ''}
            {ai.canRun && (
              <button type="button" className={styles.link} onClick={() => void run(true)}>
                <FiRefreshCw aria-hidden /> Refresh
              </button>
            )}
          </span>
        ) : null}
      </div>

      {error && (
        <p className={styles.aiError} role="alert">
          The AI profile couldn’t be written: {error}{' '}
          <button type="button" className={styles.link} onClick={() => void run(false)}>
            Try again
          </button>
        </p>
      )}
      {!report && !running && !error && (
        <p className={styles.note}>{ai.canRun ? 'The AI will read their records here.' : 'AI access is off for your account, or there is nothing about them to read yet.'}</p>
      )}

      {report && (
        <>
          <p className={styles.aiSummary}>{report.summary || 'The AI found too little to sum them up.'}</p>
          <div className={styles.aiChips}>
            <span className={styles.aiChip} title={report.buyingIntent.reason}>
              Buying intent <Badge variant={INTENT_TONE[report.buyingIntent.level]}>{INTENT_LABEL[report.buyingIntent.level]}</Badge>
            </span>
            <span className={styles.aiChip} title={report.sentiment.reason}>
              Mood{' '}
              <Badge variant={TONE_OF(report.sentiment.overall)}>
                {report.sentiment.overall === 'unknown' ? 'Not enough data' : words(report.sentiment.overall)}
                {report.sentiment.trend && report.sentiment.trend !== 'unknown' ? ` · ${report.sentiment.trend}` : ''}
              </Badge>
            </span>
            {report.behaviours.map((b) => (
              <span key={b.trait} className={styles.aiChip} title={b.explanation}>
                {words(b.trait)}
              </span>
            ))}
          </div>
          <div className={styles.aiGrid}>
            {report.insights.length > 0 && (
              <Block title="What the AI sees">
                {report.insights.map((i) => (
                  <li key={i.text}>
                    <span className={styles.tag}>{i.basis === 'fact' ? 'Fact' : 'AI view'}</span> {i.text} {cite(i.evidence)}
                  </li>
                ))}
              </Block>
            )}
            {report.recommendations.length > 0 && (
              <Block title="What to do">
                {report.recommendations.map((r) => (
                  <li key={r.action}>
                    <strong>{r.action}</strong>{' '}
                    <span className={styles.itemMeta}>
                      · {words(r.priority)} · {r.deadline}
                    </span>
                    <br />
                    {r.reason} {cite(r.evidence)}
                  </li>
                ))}
              </Block>
            )}
            {(report.preferences.length > 0 || report.painPoints.length > 0) && (
              <Block title="Wants and worries">
                {report.preferences.map((p) => (
                  <li key={`p-${p.text}`}>
                    <strong>{words(p.kind)}:</strong> {p.text}
                  </li>
                ))}
                {report.painPoints.map((p) => (
                  <li key={`w-${p.text}`}>
                    <strong>Worry:</strong> {p.text}
                  </li>
                ))}
              </Block>
            )}
            {report.competitors.length > 0 && (
              <Block title="Competitors they mentioned">
                {report.competitors.map((c) => (
                  <li key={c.name}>
                    <strong>{c.name}:</strong> {c.context}
                    {c.pricing ? ` (${c.pricing})` : ''} — <em>{c.response}</em>
                  </li>
                ))}
              </Block>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---- the records ---------------------------------------------------------------------------------

function Details({ details: x, currency }: { details: SnapshotDetails; currency: string }) {
  const [allEmails, setAllEmails] = useState(false);
  const contact = [x.contact.phone, x.contact.email, x.contact.owner ? `Handled by ${x.contact.owner}` : null].filter(Boolean).join('  ·  ');
  const emails = allEmails ? x.emails : x.emails.slice(0, EMAILS_FOLDED);
  return (
    <div className={styles.details}>
      {contact && <p className={styles.contact}>{contact}</p>}

      <Block title={`Emails${x.emails.length ? ` (${x.emails.length})` : ''}`} empty="No email with them in the connected mailboxes.">
        {emails.map((e) => (
          <li key={e.id} className={styles.item}>
            <span className={styles.itemMain}>
              {e.direction === 'received' ? <FiArrowDownLeft aria-label="From them" /> : <FiArrowUpRight aria-label="From us" />} {e.subject || '(no subject)'}
            </span>
            {(e.aiSummary || e.preview) && (
              <span className={styles.itemText}>
                {e.aiSummary ? (
                  <>
                    <FiCpu aria-label="AI reading" /> {e.aiSummary}
                  </>
                ) : (
                  e.preview
                )}
              </span>
            )}
            <span className={styles.itemMeta}>
              {day(e.at)}
              {e.mailbox ? ` · ${e.mailbox}` : ''}
              {e.intent ? ` · ${words(e.intent)}` : ''}
              {e.sentiment ? ` · ${e.sentiment}` : ''}
              {e.needsReply ? ' · waiting for our reply' : ''}
            </span>
          </li>
        ))}
        {x.emails.length > EMAILS_FOLDED && (
          <li>
            <button type="button" className={styles.link} onClick={() => setAllEmails((all) => !all)}>
              {allEmails ? 'Show fewer emails' : `Show all ${x.emails.length} emails`}
            </button>
          </li>
        )}
      </Block>

      <Block title="CRM" empty="Nothing recorded in a connected CRM.">
        {x.crm.enquiry && (
          <li className={styles.item}>
            <span className={styles.itemMain}>
              Their enquiry · {x.crm.enquiry.source}
              {x.crm.enquiry.at ? ` · ${day(x.crm.enquiry.at)}` : ''}
            </span>
            {x.crm.enquiry.lines.slice(0, 6).map((line) => (
              <span key={line} className={styles.itemText}>
                {line}
              </span>
            ))}
          </li>
        )}
        {x.crm.history.map((h) => (
          <li key={`${h.at}-${h.text}`} className={styles.item}>
            <span className={styles.itemText}>{h.text}</span>
            <span className={styles.itemMeta}>{day(h.at)}</span>
          </li>
        ))}
      </Block>

      <Block title="Past calls" empty="No other call with them.">
        {x.calls.map((c) => (
          <li key={c.id} className={styles.item}>
            <span className={styles.itemMain}>
              {c.missed ? <FiPhoneMissed aria-label="Missed" /> : c.direction === 'inbound' ? <FiArrowDownLeft aria-label="Incoming" /> : <FiArrowUpRight aria-label="Outgoing" />}{' '}
              {c.summary ?? (c.missed ? 'Missed call' : c.connected ? 'Call' : 'Not connected')}
            </span>
            <span className={styles.itemMeta}>
              {day(c.at)}
              {c.connected && c.durationSeconds ? ` · ${minutes(c.durationSeconds)}` : ''}
              {c.employee ? ` · ${c.employee}` : ''}
              {typeof c.score === 'number' ? ` · score ${c.score}/10` : ''}
            </span>
          </li>
        ))}
      </Block>

      {(x.needs.length > 0 || x.concerns.length > 0) && (
        <Block title="From their calls">
          {x.needs.map((n) => (
            <li key={`n-${n}`}>
              <strong>Asked for:</strong> {n}
            </li>
          ))}
          {x.concerns.map((c) => (
            <li key={`c-${c}`}>
              <strong>Concern:</strong> {c}
            </li>
          ))}
        </Block>
      )}

      <Block title="Quotations" empty="No quotation yet.">
        {x.quotes.map((q) => (
          <li key={q.id} className={styles.item}>
            <span className={styles.itemMain}>
              {q.number ?? q.name ?? 'Quotation'} · {money(q.amount, currency)}
            </span>
            <span className={styles.itemMeta}>
              {q.state}
              {q.date ? ` · ${day(q.date)}` : ''}
            </span>
          </li>
        ))}
      </Block>

      <Block title="Deals" empty="No deal recorded.">
        {x.deals.map((d) => (
          <li key={d.id} className={styles.item}>
            <span className={styles.itemMain}>{d.name ?? 'Deal'}</span>
            <span className={styles.itemMeta}>
              {d.status === 'open' ? 'Open' : d.status === 'won' ? 'Won' : 'Lost'}
              {d.value ? ` · ${money(d.value, currency)}` : ''}
            </span>
          </li>
        ))}
      </Block>

      <Block title="Why these labels">
        {x.why.map((w) => (
          <li key={w.label}>
            <strong>{w.label}:</strong> {w.reasons.join(' ')}
          </li>
        ))}
      </Block>
    </div>
  );
}

function Block({ title, empty, children }: { title: string; empty?: string; children: ReactNode[] | ReactNode }) {
  const items = (Array.isArray(children) ? children : [children]).flat().filter(Boolean);
  if (items.length === 0 && !empty) return null;
  return (
    <div className={styles.block}>
      <span className={styles.blockTitle}>{title}</span>
      {items.length ? <ul className={styles.blockList}>{items}</ul> : <span className={styles.note}>{empty}</span>}
    </div>
  );
}
