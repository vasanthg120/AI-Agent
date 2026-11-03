import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FiAlertCircle } from 'react-icons/fi';
import { Button, Drawer, Skeleton, Tabs as TabStrip } from '@/components/ui';
import { ActivityTimeline, CommentSection, FilePreview, StatusBadge, TaskList } from '@/components/board';
import { quotesService, type Quote, type QuotePayment } from '@/services/quotesService';
import { statusDefinitionsService } from '@/services/statusDefinitionsService';
import { extractErrorMessage } from '@/utils/errors';
import styles from './quote-detail-drawer.module.css';

export type QuotePanelTab = 'detail' | 'files' | 'comments' | 'tasks' | 'backtrack' | 'activity';

const TABS: { id: QuotePanelTab; label: string }[] = [
  { id: 'detail', label: 'Sale Detail' },
  { id: 'files', label: 'Files' },
  { id: 'comments', label: 'Comments' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'backtrack', label: 'BackTrack' },
  { id: 'activity', label: 'Activity' },
];

// Only Sale Detail has a real backing record for a bare CRM quote — Files/
// Comments/Tasks/Activity already exist for real, but only once a quote is
// converted to a Job (see features/customers/jobs). BackTrack has no HaiVE
// equivalent at all. Each other tab says so plainly instead of pretending
// there's data, and points at the Job board, where a converted quote's
// files/comments/tasks/activity genuinely live.
const NOT_ON_QUOTE = "This isn't tracked on the quote itself in HaiVE.";

export function QuoteDetailDrawer({
  quoteId,
  onClose,
  onGoToJobBoard,
}: {
  quoteId: string | null;
  onClose: () => void;
  onGoToJobBoard: () => void;
}) {
  const [tab, setTab] = useState<QuotePanelTab>('detail');

  const quoteQuery = useQuery({ queryKey: ['quote', quoteId], queryFn: () => quotesService.getOne(quoteId!), enabled: !!quoteId });
  const paymentsQuery = useQuery({
    queryKey: ['quote', quoteId, 'payments'],
    queryFn: () => quotesService.listPayments(quoteId!),
    enabled: !!quoteId,
  });
  const approvalDefs = useQuery({
    queryKey: ['status-definitions', 'quote.clientApprovalStatus'],
    queryFn: () => statusDefinitionsService.list('quote.clientApprovalStatus'),
    enabled: !!quoteId,
  });
  const statusDefs = useQuery({
    queryKey: ['status-definitions', 'quote.quoteStatus'],
    queryFn: () => statusDefinitionsService.list('quote.quoteStatus'),
    enabled: !!quoteId,
  });

  const data = quoteQuery.data;
  const goToJobBoard = (
    <Button type="button" variant="secondary" size="sm" onClick={onGoToJobBoard}>
      Go to Job board
    </Button>
  );

  return (
    <Drawer
      open={!!quoteId}
      onClose={onClose}
      title={data?.quoteNumber ?? data?.quoteName ?? 'Quote'}
      width={820}
      scrollKey={`${quoteId}:${tab}`}
      description={data?.clientDetails?.companyName ?? data?.quoteName}
      header={
        data ? (
          <div className={styles.badges}>
            <StatusBadge status={data.quoteStatus} definitions={statusDefs.data} />
            <StatusBadge status={data.clientApprovalStatus} definitions={approvalDefs.data} />
          </div>
        ) : undefined
      }
      tabs={
        !quoteQuery.isError ? (
          <TabStrip items={TABS} activeId={tab} onChange={(id) => setTab(id as QuotePanelTab)} />
        ) : undefined
      }
    >
      {quoteQuery.isLoading ? (
        <Skeleton height={320} />
      ) : quoteQuery.isError || !data ? (
        <p className={styles.error}>
          <FiAlertCircle aria-hidden /> {extractErrorMessage(quoteQuery.error) || 'Quote not found.'}
        </p>
      ) : (
        <>
          {tab === 'detail' && <SaleDetailTab quote={data} payments={paymentsQuery.data} />}
          {tab === 'files' && <FilePreview notConnectedMessage={NOT_ON_QUOTE} notConnectedAction={goToJobBoard} />}
          {tab === 'comments' && <CommentSection notConnectedMessage={NOT_ON_QUOTE} notConnectedAction={goToJobBoard} />}
          {tab === 'tasks' && <TaskList notConnectedMessage={NOT_ON_QUOTE} notConnectedAction={goToJobBoard} />}
          {tab === 'backtrack' && <ActivityTimeline notConnectedMessage="BackTrack has no equivalent in HaiVE yet." />}
          {tab === 'activity' && <ActivityTimeline notConnectedMessage={NOT_ON_QUOTE} notConnectedAction={goToJobBoard} />}
        </>
      )}
    </Drawer>
  );
}

function SaleDetailTab({ quote, payments }: { quote: Quote; payments?: QuotePayment[] }) {
  const money = (amount: number) => `${quote.currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  return (
    <div className={styles.detailSections}>
      <section className={styles.section}>
        <h3>Client</h3>
        <dl className={styles.grid}>
          <div>
            <dt>Company</dt>
            <dd>{quote.clientDetails?.companyName ?? '—'}</dd>
          </div>
          <div>
            <dt>Contact</dt>
            <dd>{quote.clientDetails?.contactName ?? '—'}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{quote.clientDetails?.email ?? '—'}</dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd>{quote.clientDetails?.phone ?? '—'}</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>{quote.expirationDate ?? '—'}</dd>
          </div>
          <div>
            <dt>Due</dt>
            <dd>{quote.dueDate ?? '—'}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.section}>
        <h3>Items</h3>
        {quote.items.length === 0 ? (
          <p className={styles.muted}>This quote has no line items — only its total, {money(quote.quoteAmount)}.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" className={styles.num}>
                    Qty
                  </th>
                  <th scope="col" className={styles.num}>
                    Rate
                  </th>
                  <th scope="col" className={styles.num}>
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {quote.items.map((item, i) => (
                  <tr key={i}>
                    <td>{item.description}</td>
                    <td className={styles.num}>{item.quantity.toLocaleString()}</td>
                    <td className={styles.num}>{money(item.unitPrice)}</td>
                    <td className={styles.num}>{money(item.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <dl className={styles.totals}>
          <div>
            <dt>Subtotal</dt>
            <dd>{money(quote.subtotal)}</dd>
          </div>
          <div>
            <dt>Discount</dt>
            <dd>{money(quote.discountAmount)}</dd>
          </div>
          <div>
            <dt>Tax</dt>
            <dd>{money(quote.taxAmount)}</dd>
          </div>
          <div className={styles.totalMain}>
            <dt>Total</dt>
            <dd>{money(quote.quoteAmount)}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.section}>
        <h3>Payments</h3>
        {!payments || payments.length === 0 ? (
          <p className={styles.muted}>No payments recorded yet. Paid so far: {money(quote.paidAmount)}.</p>
        ) : (
          <ul className={styles.paymentsList}>
            {payments.map((p) => (
              <li key={p._id} className={p.voided ? styles.voided : undefined}>
                <strong>{money(p.amount)}</strong>
                <span>
                  {new Date(p.paymentDate).toLocaleDateString()}
                  {p.paymentMethod ? ` · ${p.paymentMethod}` : ''}
                  {p.voided ? ' · voided' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
