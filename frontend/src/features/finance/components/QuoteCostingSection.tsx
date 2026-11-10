import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { FiExternalLink, FiFileText, FiLink, FiPercent, FiSearch, FiX } from 'react-icons/fi';
import { Badge, Button, EmptyState, Input, SectionCard, Skeleton, type BadgeVariant } from '@/components/ui';
import { FileDropUpload } from '@/components/common/FileDropUpload';
import {
  financeDocumentsService,
  type CostingExclusion,
  type CustomerQuoteMatch,
  type FinanceDocument,
  type QuoteCostingLine,
} from '@/services/financeDocumentsService';
import { formatAmountIn } from '@/utils/currency';
import { extractErrorMessage } from '@/utils/errors';
import { FINANCE_DOCUMENT_EXTENSIONS } from './FinanceDocumentUpload';
import styles from './QuoteCostingSection.module.css';

export interface QuoteCostingSectionProps {
  /** finance:create — may upload documents into the quote. */
  canUpload: boolean;
  /** finance:edit — may add already-uploaded documents to the quote and remove them from it. */
  canEdit: boolean;
  onOpenDocument: (doc: FinanceDocument) => void;
  /** A document was added to or removed from a quote: the page's own figures refresh. */
  onDocumentsChanged: () => void;
}

const costingKey = (quoteId: string) => ['finance-quote-costing', quoteId];

function excludedLabel(line: QuoteCostingLine, quoteCurrency: string): string {
  const reasons: Record<CostingExclusion, string> = {
    processing: 'Still being read — not counted yet',
    extraction_failed: 'Couldn’t be read — open it to retry or type the amount in',
    cancelled: 'Cancelled — not counted',
    currency_mismatch: `In ${line.document.currency}, the quote is in ${quoteCurrency} — not counted`,
    duplicate: 'Same bill uploaded twice — counted once',
  };
  return line.excludedReason ? reasons[line.excludedReason] : '';
}

const PAYMENT_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  paid: { label: 'Paid', variant: 'success' },
  partially_paid: { label: 'Part paid', variant: 'info' },
  pending: { label: 'Pending', variant: 'neutral' },
  overdue: { label: 'Overdue', variant: 'danger' },
  cancelled: { label: 'Cancelled', variant: 'neutral' },
};

function approvalVariant(status: string): BadgeVariant {
  if (status === 'approved' || status === 'accepted') return 'success';
  if (status === 'rejected' || status === 'declined') return 'danger';
  return 'neutral';
}

function formatDate(ymd?: string): string | undefined {
  if (!ymd) return undefined;
  const date = new Date(`${ymd}T00:00:00`);
  return Number.isNaN(date.getTime()) ? ymd : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const pct = (value: number | null) => (value === null ? '—' : `${value}%`);

// Finance AI quote costing: pick a customer quote, add every vendor document
// for it (drop several at once, or pick ones already uploaded), and see what
// the quote earns once they are paid. Amounts are compared as written, GST
// included (quotes carry only a total) — backend finance/quote-costing.ts.
export function QuoteCostingSection(props: QuoteCostingSectionProps) {
  const [quote, setQuote] = useState<CustomerQuoteMatch | null>(null);

  return (
    <SectionCard
      title="Quote Costing"
      icon={FiPercent}
      info="Pick a customer quote, add all the vendor documents for it — invoices, receipts, shipping bills — and see the profit and margin on that quote. Amounts are compared as written, GST included."
    >
      {quote ? (
        <QuoteCostingDetail {...props} quote={quote} onChangeQuote={() => setQuote(null)} />
      ) : (
        <QuotePicker onPick={setQuote} />
      )}
    </SectionCard>
  );
}

function QuotePicker({ onPick }: { onPick: (quote: CustomerQuoteMatch) => void }) {
  const [input, setInput] = useState('');
  const [matches, setMatches] = useState<CustomerQuoteMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const quoteNumber = input.trim();
    if (!quoteNumber) return;
    setSearching(true);
    setError(null);
    setMatches(null);
    try {
      const results = await financeDocumentsService.searchCustomerQuote(quoteNumber);
      // Picking a quote only shows its costing (nothing is saved), so one match opens straight away.
      if (results.length === 1) onPick(results[0]);
      else setMatches(results);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className={styles.picker}>
      <form className={styles.searchRow} onSubmit={(e) => void search(e)}>
        <Input
          label="Customer quote no."
          placeholder="e.g. 118"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setMatches(null);
            setError(null);
          }}
        />
        <Button type="submit" variant="secondary" loading={searching} disabled={!input.trim()} leftIcon={<FiSearch size={14} />}>
          Find quote
        </Button>
      </form>
      {error && <p className={styles.notice}>{error}</p>}
      {matches && matches.length === 0 && <p className={styles.notice}>No customer quote has the number “{input.trim()}”.</p>}
      {matches && matches.length > 1 && (
        <div className={styles.matchList}>
          <span className={styles.muted}>More than one quote has this number — pick the right one:</span>
          {matches.map((m) => (
            <button key={m.quoteId} type="button" className={styles.matchItem} onClick={() => onPick(m)}>
              <strong>{m.quoteNumber}</strong>
              <span>{m.customerName ?? 'Unknown customer'}</span>
              <span className={styles.matchAmount}>{formatAmountIn(m.quoteAmount, m.currency)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function QuoteCostingDetail({
  quote,
  onChangeQuote,
  canUpload,
  canEdit,
  onOpenDocument,
  onDocumentsChanged,
}: QuoteCostingSectionProps & { quote: CustomerQuoteMatch; onChangeQuote: () => void }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: costingKey(quote.quoteId),
    queryFn: () => financeDocumentsService.getQuoteCosting(quote.quoteId),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: costingKey(quote.quoteId) });
    onDocumentsChanged();
  };

  const unlink = useMutation({
    mutationFn: (id: string) => financeDocumentsService.unlinkCustomerQuote(id),
    onSuccess: (doc) => {
      toast.success(`${doc.vendorName ?? doc.originalFilename} removed from quote ${quote.quoteNumber ?? ''}`.trim());
      refresh();
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  });

  const shown = data?.quote ?? quote;
  const money = (value: number | null) => formatAmountIn(value, shown.currency);

  return (
    <div className={styles.detail}>
      <div className={styles.quoteHeader}>
        <div className={styles.quoteTitle}>
          <span className={styles.quoteNumber}>Quote {shown.quoteNumber ?? '—'}</span>
          <span className={styles.customer}>{shown.customerName ?? 'Unknown customer'}</span>
          <Badge variant={approvalVariant(shown.clientApprovalStatus)}>{shown.clientApprovalStatus}</Badge>
        </div>
        <Button type="button" variant="ghost" size="sm" leftIcon={<FiSearch size={14} />} onClick={onChangeQuote}>
          Another quote
        </Button>
      </div>

      {error ? (
        <p className={styles.notice}>{extractErrorMessage(error)}</p>
      ) : isLoading || !data ? (
        <Skeleton height={96} />
      ) : (
        <>
          <div className={styles.totals} aria-label="Quote costing totals">
            <Total label="Quote amount" value={money(data.totals.quoteAmount)} />
            <Total
              label="Vendor costs"
              value={money(data.totals.vendorCost)}
              note={`${data.totals.includedCount} document${data.totals.includedCount === 1 ? '' : 's'}`}
            />
            <Total label="Profit" value={money(data.totals.profit)} tone={data.totals.profit < 0 ? 'bad' : 'good'} strong />
            <Total
              label="Margin"
              value={pct(data.totals.marginPct)}
              note="profit ÷ quote"
              tone={data.totals.marginPct === null ? undefined : data.totals.marginPct < 0 ? 'bad' : data.totals.marginPct < 5 ? 'warn' : 'good'}
            />
            <Total label="Markup" value={pct(data.totals.markupPct)} note="profit ÷ costs" />
          </div>
          <p className={styles.muted}>
            Compared as written on each document, GST included
            {data.totals.vendorTax > 0 && <> · GST on the counted vendor documents: {money(data.totals.vendorTax)}</>}
            {data.totals.excludedCount > 0 && (
              <> · {data.totals.excludedCount} document{data.totals.excludedCount === 1 ? ' is' : 's are'} not counted (see below)</>
            )}
          </p>

          {data.documents.length === 0 ? (
            <EmptyState
              compact
              icon={FiFileText}
              title="No vendor documents on this quote yet"
              description={canUpload ? 'Drop the invoices, receipts and shipping bills for this quote below.' : undefined}
            />
          ) : (
            <ul className={styles.docList}>
              {data.documents.map((line) => (
                <DocumentRow
                  key={line.documentId}
                  line={line}
                  quoteCurrency={shown.currency}
                  canEdit={canEdit}
                  removing={unlink.isPending && unlink.variables === line.documentId}
                  onOpen={() => onOpenDocument(line.document)}
                  onRemove={() => unlink.mutate(line.documentId)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {canUpload && (
        <FileDropUpload
          accept={FINANCE_DOCUMENT_EXTENSIONS}
          hint={`Vendor invoices, receipts and shipping bills for quote ${shown.quoteNumber ?? ''} — drop several at once. The AI reads each one and adds it to this quote.`}
          upload={(file) => financeDocumentsService.upload(file, quote.quoteId)}
          onUploaded={refresh}
          successMessage={(file, doc) =>
            doc.extractionStatus === 'completed' ? `${file.name} added to the quote` : `${file.name} added — but it couldn’t be read`
          }
        />
      )}

      {canEdit &&
        (adding ? (
          <AddExistingDocuments
            quote={shown}
            onClose={() => setAdding(false)}
            onAdded={() => {
              setAdding(false);
              refresh();
            }}
          />
        ) : (
          <div>
            <Button type="button" variant="ghost" size="sm" leftIcon={<FiLink size={14} />} onClick={() => setAdding(true)}>
              Add documents already uploaded
            </Button>
          </div>
        ))}
    </div>
  );
}

function Total({ label, value, note, tone, strong }: { label: string; value: string; note?: string; tone?: 'good' | 'warn' | 'bad'; strong?: boolean }) {
  return (
    <div className={clsx(styles.total, strong && styles.totalStrong)}>
      <span className={styles.totalLabel}>{label}</span>
      <span className={clsx(styles.totalValue, tone && styles[tone])}>{value}</span>
      {note && <span className={styles.totalNote}>{note}</span>}
    </div>
  );
}

function DocumentRow({
  line,
  quoteCurrency,
  canEdit,
  removing,
  onOpen,
  onRemove,
}: {
  line: QuoteCostingLine;
  quoteCurrency: string;
  canEdit: boolean;
  removing: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const doc = line.document;
  const status = PAYMENT_STATUS[doc.paymentStatus] ?? { label: doc.paymentStatus, variant: 'neutral' as BadgeVariant };
  const details = [doc.invoiceNumber && `Invoice ${doc.invoiceNumber}`, formatDate(doc.invoiceDate)].filter(Boolean).join(' · ');

  return (
    <li className={clsx(styles.docRow, !line.included && styles.docExcluded)}>
      <div className={styles.docMain}>
        <span className={styles.docVendor}>{doc.vendorName ?? doc.originalFilename}</span>
        <span className={styles.muted}>{details || doc.originalFilename}</span>
        {!line.included && <span className={styles.excluded}>{excludedLabel(line, quoteCurrency)}</span>}
      </div>
      <div className={styles.docAmounts}>
        <span className={clsx(styles.docAmount, !line.included && styles.struck)}>{formatAmountIn(doc.paymentAmount ?? 0, doc.currency)}</span>
        {doc.taxAmount > 0 && <span className={styles.muted}>GST {formatAmountIn(doc.taxAmount, doc.currency)}</span>}
      </div>
      <div className={styles.docBadges}>
        <Badge variant={status.variant}>{status.label}</Badge>
        {doc.reviewStatus === 'needs_review' && doc.extractionStatus === 'completed' && <Badge variant="warning">Check</Badge>}
      </div>
      <div className={styles.docActions}>
        <Button type="button" variant="ghost" size="sm" leftIcon={<FiExternalLink size={14} />} onClick={onOpen}>
          Open
        </Button>
        {canEdit && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={removing}
            leftIcon={<FiX size={14} />}
            onClick={onRemove}
            aria-label={`Remove ${doc.vendorName ?? doc.originalFilename} from this quote`}
          >
            Remove
          </Button>
        )}
      </div>
    </li>
  );
}

function AddExistingDocuments({ quote, onClose, onAdded }: { quote: CustomerQuoteMatch; onClose: () => void; onAdded: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['finance-documents-unlinked'],
    queryFn: () => financeDocumentsService.listFiltered({ quoteLink: 'unlinked' }, 1, 50),
  });
  const docs = data?.items ?? [];

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // One at a time, so a refusal names the document it is about and the rest still go through.
  const addSelected = async () => {
    setSaving(true);
    let added = 0;
    for (const id of selected) {
      try {
        await financeDocumentsService.linkCustomerQuote(id, quote.quoteId);
        added += 1;
      } catch (err) {
        const doc = docs.find((d) => d._id === id);
        toast.error(`${doc?.vendorName ?? doc?.originalFilename ?? 'A document'}: ${extractErrorMessage(err)}`);
      }
    }
    setSaving(false);
    if (added > 0) toast.success(`${added} document${added === 1 ? '' : 's'} added to quote ${quote.quoteNumber ?? ''}`.trim());
    onAdded();
  };

  return (
    <div className={styles.addPanel}>
      <div className={styles.addHeader}>
        <strong>Documents not linked to any quote</strong>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {isLoading ? (
        <Skeleton height={80} />
      ) : docs.length === 0 ? (
        <p className={styles.muted}>Every uploaded document is already linked to a quote.</p>
      ) : (
        <>
          <ul className={styles.addList}>
            {docs.map((d) => (
              <li key={d._id}>
                <label className={styles.addItem}>
                  <input type="checkbox" checked={selected.has(d._id)} onChange={() => toggle(d._id)} />
                  <span className={styles.addItemText}>
                    <span className={styles.docVendor}>{d.vendorName ?? d.originalFilename}</span>
                    <span className={styles.muted}>
                      {[d.invoiceNumber && `Invoice ${d.invoiceNumber}`, formatDate(d.invoiceDate), d.originalFilename].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className={styles.docAmount}>{formatAmountIn(d.paymentAmount ?? 0, d.currency)}</span>
                </label>
              </li>
            ))}
          </ul>
          <div>
            <Button type="button" loading={saving} disabled={selected.size === 0} onClick={() => void addSelected()}>
              {selected.size > 0 ? `Add ${selected.size} to quote ${quote.quoteNumber ?? ''}`.trim() : 'Select documents to add'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
