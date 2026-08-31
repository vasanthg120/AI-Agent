import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiChevronDown, FiSearch } from 'react-icons/fi';
import { Badge, Button, Dropdown, Input, Skeleton } from '@/components/ui';
import { billingAdminService, type AdminInvoice } from '@/services/billingAdminService';
import { extractErrorMessage } from '@/utils/errors';
import { formatFullDate } from '@/utils/date';
import shared from '../adminShared.module.css';

export function AdminInvoicesPage() {
  const [organizationId, setOrganizationId] = useState('');
  const [invoices, setInvoices] = useState<AdminInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [voidingId, setVoidingId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    billingAdminService
      .listInvoices({ organizationId: organizationId || undefined, limit: 100 })
      .then(setInvoices)
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const timeout = setTimeout(load, 250);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);

  const handleDownload = async (invoice: AdminInvoice, format: 'pdf' | 'csv') => {
    try {
      await billingAdminService.downloadInvoice(invoice._id, invoice.invoiceNumber, format);
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  const handleVoid = async (invoice: AdminInvoice) => {
    if (!window.confirm(`Void invoice ${invoice.invoiceNumber}? This only flags it as void — it does not refund the payment.`)) return;
    setVoidingId(invoice._id);
    try {
      await billingAdminService.voidInvoice(invoice._id);
      toast.success('Invoice voided.');
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setVoidingId(null);
    }
  };

  return (
    <div className={shared.page}>
      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>Invoices</h1>
          <p className={shared.pageSubtitle}>One invoice per captured payment — purchase, subscription checkout, or renewal.</p>
        </div>
      </div>

      <Input
        className={shared.searchInput}
        placeholder="Filter by organization id..."
        leftIcon={<FiSearch />}
        value={organizationId}
        onChange={(event) => setOrganizationId(event.target.value)}
      />

      <div className={shared.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <th>Invoice #</th>
              <th>Organization</th>
              <th>Type</th>
              <th>Issued</th>
              <th>Subtotal</th>
              <th>Discount</th>
              <th>Tax</th>
              <th>Total</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={10}>
                  <Skeleton height={20} />
                </td>
              </tr>
            )}
            {!loading && invoices.length === 0 && (
              <tr>
                <td colSpan={10} className={shared.emptyState}>
                  No invoices match this filter.
                </td>
              </tr>
            )}
            {!loading &&
              invoices.map((inv) => (
                <tr key={inv._id}>
                  <td className={shared.mono}>{inv.invoiceNumber}</td>
                  <td className={shared.mono}>{inv.organizationId}</td>
                  <td>{inv.type}</td>
                  <td>{formatFullDate(inv.issuedAt)}</td>
                  <td>{inv.subtotal} {inv.currencyCode}</td>
                  <td>{inv.discountAmount} {inv.currencyCode}</td>
                  <td>{inv.taxAmount} {inv.currencyCode}</td>
                  <td>
                    <strong>
                      {inv.total} {inv.currencyCode}
                    </strong>
                  </td>
                  <td>
                    <Badge variant={inv.status === 'paid' ? 'success' : 'neutral'}>{inv.status}</Badge>
                  </td>
                  <td style={{ display: 'flex', gap: 8 }}>
                    <Dropdown
                      align="right"
                      trigger={
                        <Button size="sm" variant="secondary" rightIcon={<FiChevronDown size={12} />}>
                          Download
                        </Button>
                      }
                      items={[
                        { id: 'pdf', label: 'PDF', onSelect: () => handleDownload(inv, 'pdf') },
                        { id: 'csv', label: 'CSV', onSelect: () => handleDownload(inv, 'csv') },
                      ]}
                    />
                    {inv.status === 'paid' && (
                      <Button size="sm" variant="danger" loading={voidingId === inv._id} onClick={() => handleVoid(inv)}>
                        Void
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
