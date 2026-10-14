import { useState } from 'react';
import toast from 'react-hot-toast';
import { useQueryClient } from '@tanstack/react-query';
import { FiArrowLeft, FiChevronRight, FiInfo, FiLayers } from 'react-icons/fi';
import clsx from 'clsx';
import { Badge, Button } from '@/components/ui';
import { customerJobsService } from '@/services/customerJobsService';
import type { CustomerDetail, CustomerDocument } from '@/services/customersService';
import { extractErrorMessage } from '@/utils/errors';
import { formatDate, formatMoney } from '../format';
import { JobTag } from '../jobs/JobTag';
import { StageChip } from '../StageChip';
import { INVOICE_VARIANT, QUOTE_VARIANT } from '../status';
import detailStyles from '../customer-detail.module.css';
import { JourneyStepCard } from './DetailsTab';
import styles from './panel.module.css';

const dash = '—';

// Every quotation and invoice of the customer. One click opens a document in
// full — who it was prepared for, its lines when they are recorded, what was
// paid — with the records before and after it one click away. A quotation the
// team decides to produce becomes a job from here.
export function DocumentsTab({
  detail,
  documentId,
  onOpen,
  onGoTo,
  onOpenJob,
}: {
  detail: CustomerDetail;
  documentId: string | null;
  onOpen: (id: string | null) => void;
  onGoTo: (tab: string) => void;
  onOpenJob?: (jobId: string, number?: string) => void;
}) {
  const money = (amount: number) => formatMoney(amount, detail.currency);
  const known = (value: number | null) => (value === null ? 'Not recorded' : money(value));
  const open = documentId ? detail.documents.find((d) => d.id === documentId) : undefined;
  if (open)
    return (
      <DocumentView
        customerId={detail.id}
        document={open}
        currency={detail.currency}
        onOpen={onOpen}
        onGoTo={onGoTo}
        onOpenJob={onOpenJob}
      />
    );
  const jobOf = (quotationId: string) => detail.documents.find((d) => d.id === quotationId)?.job;

  // Only what the document list holds can be opened (a long history is capped).
  const canOpen = (id: string) => detail.documents.some((d) => d.id === id);
  const rowProps = (id: string, label: string) =>
    canOpen(id)
      ? {
          className: styles.docRow,
          tabIndex: 0,
          role: 'button' as const,
          'aria-label': `Open ${label}`,
          onClick: () => onOpen(id),
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpen(id);
            }
          },
        }
      : {};
  return (
    <>
      <section className={detailStyles.section}>
        <h3>
          Quotations <span className={detailStyles.sectionCount}>{detail.quotes.count} · click one to open it</span>
        </h3>
        {detail.quotations.length === 0 ? (
          <p className={detailStyles.muted}>No quotation has been made for this customer.</p>
        ) : (
          <div className={detailStyles.docWrap}>
            <table className={clsx(detailStyles.docTable, detailStyles.stackTable)}>
              <thead>
                <tr>
                  <th scope="col">Quote</th>
                  <th scope="col">Date</th>
                  <th scope="col" className={detailStyles.num}>
                    Amount
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Valid until</th>
                  <th scope="col" aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {detail.quotations.map((q) => (
                  <tr key={q.id} {...rowProps(q.id, q.number ? `quotation ${q.number}` : 'quotation')}>
                    <td>
                      <strong>{q.number ?? 'Quotation'}</strong>
                      {q.name && <div className={detailStyles.cellSub}>{q.name}</div>}
                      {jobOf(q.id) && (
                        <div className={styles.docJob}>
                          <JobTag job={jobOf(q.id)!} onOpen={onOpenJob} />
                        </div>
                      )}
                    </td>
                    <td data-label="Date">{q.date ? formatDate(q.date) : dash}</td>
                    <td data-label="Amount" className={detailStyles.num}>
                      {money(q.amount)}
                    </td>
                    <td data-label="Status">
                      <Badge variant={QUOTE_VARIANT[q.state]}>{q.stateLabel}</Badge>
                    </td>
                    <td data-label="Valid until">{q.expiresAt ? formatDate(q.expiresAt) : dash}</td>
                    <td className={clsx(styles.docOpen, detailStyles.stackOpen)}>
                      {canOpen(q.id) && <FiChevronRight aria-hidden />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={detailStyles.section}>
        <h3>
          Orders and invoices <span className={detailStyles.sectionCount}>{detail.invoices.count}</span>
        </h3>
        {detail.invoiceList.length === 0 ? (
          <p className={detailStyles.muted}>No invoice has been raised for this customer.</p>
        ) : (
          <div className={detailStyles.docWrap}>
            <table className={clsx(detailStyles.docTable, detailStyles.stackTable, detailStyles.denseTable)}>
              <thead>
                <tr>
                  <th scope="col">Invoice</th>
                  <th scope="col">Date</th>
                  <th scope="col" className={detailStyles.num}>
                    Amount
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col" className={detailStyles.num}>
                    Paid
                  </th>
                  <th scope="col" className={detailStyles.num}>
                    Outstanding
                  </th>
                  <th scope="col">Due</th>
                  <th scope="col" className={detailStyles.num}>
                    Margin
                  </th>
                  <th scope="col" aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {detail.invoiceList.map((invoice) => (
                  <tr
                    key={invoice.id}
                    {...rowProps(invoice.id, invoice.number ? `invoice ${invoice.number}` : 'invoice')}
                  >
                    <td>
                      <strong>{invoice.number ?? 'Invoice'}</strong>
                      {invoice.quotationNumber && (
                        <div className={detailStyles.cellSub}>from {invoice.quotationNumber}</div>
                      )}
                    </td>
                    <td data-label="Date">{invoice.date ? formatDate(invoice.date) : dash}</td>
                    <td data-label="Amount" className={detailStyles.num}>
                      {money(invoice.amount)}
                    </td>
                    <td data-label="Status">
                      <Badge variant={invoice.overdue ? 'danger' : INVOICE_VARIANT[invoice.status]}>
                        {invoice.overdue ? 'Overdue' : invoice.statusLabel}
                      </Badge>
                    </td>
                    <td data-label="Paid" className={detailStyles.num}>
                      {known(invoice.paid)}
                    </td>
                    <td data-label="Outstanding" className={detailStyles.num}>
                      {known(invoice.outstanding)}
                    </td>
                    <td data-label="Due">{invoice.dueDate ? formatDate(invoice.dueDate) : 'Not recorded'}</td>
                    <td data-label="Margin" className={detailStyles.num}>
                      {invoice.marginPct === null ? 'Not recorded' : `${invoice.marginPct}%`}
                    </td>
                    <td className={clsx(styles.docOpen, detailStyles.stackOpen)}>
                      {canOpen(invoice.id) && <FiChevronRight aria-hidden />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// One quotation or invoice, laid out as a document: what it is, who it is for,
// what is on it, what was paid — and the records it is connected to.
function DocumentView({
  customerId,
  document,
  currency,
  onOpen,
  onGoTo,
  onOpenJob,
}: {
  customerId: string;
  document: CustomerDocument;
  currency: string;
  onOpen: (id: string | null) => void;
  onGoTo: (tab: string) => void;
  onOpenJob?: (jobId: string, number?: string) => void;
}) {
  const queryClient = useQueryClient();
  const [converting, setConverting] = useState(false);
  const money = (amount: number) => formatMoney(amount, currency);
  const isQuotation = document.kind === 'quotation';
  const what = isQuotation ? 'Quotation' : 'Invoice';
  const party = document.preparedFor;
  const hasParty = Object.values(party).some(Boolean);
  // The quotation becomes a job: saved in HaiVE, with the quotation's customer, amount and items copied.
  const convert = async () => {
    setConverting(true);
    try {
      const { job, created } = await customerJobsService.convert(customerId, document.id);
      toast.success(created ? `Job ${job.number} created` : `This quotation is already job ${job.number}`);
      // The customer's row gets its job tag, this quotation its "Open job", and the Job board its new row.
      await queryClient.invalidateQueries({ queryKey: ['customers'], exact: false, refetchType: 'active' });
      void queryClient.invalidateQueries({ queryKey: ['customer-jobs'], exact: false });
      onOpenJob?.(job.id, job.number);
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setConverting(false);
    }
  };
  return (
    <>
      <div className={styles.documentBar}>
        <button type="button" className={styles.backLink} onClick={() => onOpen(null)}>
          <FiArrowLeft aria-hidden /> All quotes and orders
        </button>
        {isQuotation &&
          (document.job ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              leftIcon={<FiLayers />}
              onClick={() => onOpenJob?.(document.job!.id, document.job!.number)}
            >
              Open job {document.job.number}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              leftIcon={<FiLayers />}
              loading={converting}
              title="Start producing this quotation: it becomes a job on the Job board. Saved in HaiVE — your CRM is not changed."
              onClick={() => void convert()}
            >
              Convert to job
            </Button>
          ))}
      </div>

      <article className={styles.document}>
        <header className={styles.documentHead}>
          <div>
            <span className={styles.documentKind}>{what}</span>
            <h3 className={styles.documentNumber}>{document.number ?? `${what} without a number`}</h3>
            {document.title && <p className={styles.documentTitle}>{document.title}</p>}
          </div>
          <div className={styles.documentAmount}>
            <strong>{money(document.amount)}</strong>
            {/* The document's own status, as its system records it — not the customer's Quote step, which can be set by hand. */}
            <StageChip stage={{ title: what, label: document.status, tone: document.tone }} showDetail={false} />
          </div>
        </header>

        <dl className={styles.documentMeta}>
          <div>
            <dt>{isQuotation ? 'Created' : 'Invoice date'}</dt>
            <dd>{document.date ? formatDate(document.date) : dash}</dd>
          </div>
          <div>
            <dt>{isQuotation ? 'Valid until' : 'Payment due'}</dt>
            <dd>
              {isQuotation
                ? document.validUntil
                  ? formatDate(document.validUntil)
                  : dash
                : document.dueDate
                  ? formatDate(document.dueDate)
                  : 'Not recorded'}
            </dd>
          </div>
          <div>
            <dt>Owner</dt>
            <dd>{document.owner ?? dash}</dd>
          </div>
          <div>
            <dt>Held in</dt>
            <dd>{document.source ?? dash}</dd>
          </div>
        </dl>

        <section className={styles.documentBlock}>
          <h4>Prepared for</h4>
          {hasParty ? (
            <div className={styles.party}>
              {party.company && <strong>{party.company}</strong>}
              {party.contact && <span>{party.contact}</span>}
              {party.phone && <a href={`tel:${party.phone.replace(/[^+\d]/g, '')}`}>{party.phone}</a>}
              {party.email && <a href={`mailto:${party.email}`}>{party.email}</a>}
            </div>
          ) : (
            <p className={detailStyles.muted}>No customer details are recorded on this {what.toLowerCase()}.</p>
          )}
        </section>

        <section className={styles.documentBlock}>
          <h4>
            Items
            {/* Some CRMs keep the lines on the deal, not on the quotation raised from it. */}
            {document.lines.length > 0 && document.linesFrom === 'deal' && (
              <span className={styles.blockNote}>from the deal{document.source ? ` in ${document.source}` : ''}</span>
            )}
          </h4>
          {document.lines.length > 0 ? (
            <div className={detailStyles.docWrap}>
              <table className={clsx(detailStyles.docTable, detailStyles.stackTable, detailStyles.stackThree)}>
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col" className={detailStyles.num}>
                      Quantity
                    </th>
                    <th scope="col" className={detailStyles.num}>
                      Rate
                    </th>
                    <th scope="col" className={detailStyles.num}>
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {document.lines.map((line, n) => (
                    <tr key={`${line.description}-${n}`}>
                      <td>
                        <strong>{line.description}</strong>
                        {line.detail && (
                          <div className={clsx(detailStyles.cellSub, styles.lineDetail)} title={line.detail}>
                            {line.detail}
                          </div>
                        )}
                      </td>
                      <td data-label="Quantity" className={detailStyles.num}>
                        {line.quantity.toLocaleString()}
                      </td>
                      <td data-label="Rate" className={detailStyles.num}>
                        {money(line.unitPrice)}
                      </td>
                      <td data-label="Total" className={detailStyles.num}>
                        {money(line.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className={detailStyles.muted}>
              The items aren’t recorded{document.source ? ` in ${document.source}` : ''} for this {what.toLowerCase()} —
              only its total.
            </p>
          )}
          {document.linesNote && (
            <p className={styles.linesNote} role="note">
              <FiInfo aria-hidden /> <span>{document.linesNote}</span>
            </p>
          )}
          <dl className={styles.totals}>
            {/* The items, then what is added to them — shown when there is something to add up. */}
            {document.subtotal !== null && (document.charges.length > 0 || document.linesNote) && (
              <>
                <div>
                  <dt>Items</dt>
                  <dd>{money(document.subtotal)}</dd>
                </div>
                {document.charges.map((charge, n) => (
                  <div key={`${charge.name}-${n}`}>
                    <dt>{charge.name}</dt>
                    <dd>{money(charge.amount)}</dd>
                  </div>
                ))}
              </>
            )}
            <div className={styles.totalMain}>
              <dt>{what} total</dt>
              <dd>{money(document.amount)}</dd>
            </div>
            {!isQuotation && (
              <>
                <div>
                  <dt>Paid</dt>
                  <dd>{document.paid === null ? 'Not recorded' : money(document.paid)}</dd>
                </div>
                <div>
                  <dt>Outstanding</dt>
                  <dd>{document.outstanding === null ? 'Not recorded' : money(document.outstanding)}</dd>
                </div>
              </>
            )}
          </dl>
          {document.payments.length > 0 && (
            <ul className={styles.payments}>
              {document.payments.map((payment, n) => (
                <li key={`${payment.date}-${n}`}>
                  <span>Payment received {formatDate(payment.date)}</span>
                  <strong>{money(payment.amount)}</strong>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.documentBlock}>
          <h4>Connected to</h4>
          {document.links.length === 0 ? (
            <p className={detailStyles.muted}>
              Nothing else is linked to this {what.toLowerCase()}
              {isQuotation ? ' yet: no deal, invoice or inquiry.' : '.'}
            </p>
          ) : (
            <ol className={clsx(styles.journey, styles.journeyStacked)}>
              {document.links.map((step, index) => (
                <li key={`${step.kind}-${index}`} className={styles.journeyItem}>
                  <JourneyStepCard step={step} onOpenDocument={(id) => onOpen(id)} onOpenJob={onOpenJob} />
                </li>
              ))}
            </ol>
          )}
          <p className={styles.documentFoot}>
            The emails about it are under{' '}
            <button type="button" className={styles.textButton} onClick={() => onGoTo('mail')}>
              Emails
            </button>
            , and everything in order under{' '}
            <button type="button" className={styles.textButton} onClick={() => onGoTo('activity')}>
              Activity
            </button>
            .
          </p>
        </section>
      </article>
    </>
  );
}
