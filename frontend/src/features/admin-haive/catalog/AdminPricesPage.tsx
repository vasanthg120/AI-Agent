import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiPlus } from 'react-icons/fi';
import { Badge, Button, Input, Modal, Skeleton, Switch } from '@/components/ui';
import { billingCatalogAdminService, type AdminCurrency } from '@/services/billingCatalogAdminService';
import { extractErrorMessage } from '@/utils/errors';
import shared from '../adminShared.module.css';

const emptyForm = { code: '', name: '', symbol: '', usdToCurrencyRate: '', isDefault: false };

// Per-plan prices are managed inline from the Plans page (each plan's
// "Manage" modal has its own Prices section, addPrice/removePrice) — a
// price only ever makes sense in the context of its plan. This page is the
// platform-wide currency catalog those prices are denominated in.
export function AdminPricesPage() {
  const [currencies, setCurrencies] = useState<AdminCurrency[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    setLoading(true);
    billingCatalogAdminService
      .listCurrencies()
      .then(setCurrencies)
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const submit = async () => {
    if (!form.code.trim() || !form.name.trim() || !form.symbol.trim() || !form.usdToCurrencyRate) {
      toast.error('Code, name, symbol, and rate are required.');
      return;
    }
    setSubmitting(true);
    try {
      await billingCatalogAdminService.createCurrency({
        code: form.code.trim().toUpperCase(),
        name: form.name,
        symbol: form.symbol,
        usdToCurrencyRate: Number.parseFloat(form.usdToCurrencyRate),
        isDefault: form.isDefault,
      });
      toast.success('Currency added.');
      setModalOpen(false);
      setForm(emptyForm);
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const toggleActive = async (currency: AdminCurrency) => {
    try {
      if (currency.active) await billingCatalogAdminService.deactivateCurrency(currency._id);
      else await billingCatalogAdminService.activateCurrency(currency._id);
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  const makeDefault = async (currency: AdminCurrency) => {
    try {
      await billingCatalogAdminService.updateCurrency(currency._id, { isDefault: true });
      toast.success(`${currency.code} is now the default currency.`);
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };

  return (
    <div className={shared.page}>
      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>Prices &amp; Currencies</h1>
          <p className={shared.pageSubtitle}>
            Currencies plan prices are denominated in. To add or edit a plan's actual price, open that plan from the <strong>Plans</strong> page.
          </p>
        </div>
        <Button leftIcon={<FiPlus />} onClick={() => setModalOpen(true)}>
          New Currency
        </Button>
      </div>

      <div className={shared.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Symbol</th>
              <th>1 USD =</th>
              <th>Default</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7}>
                  <Skeleton height={20} />
                </td>
              </tr>
            )}
            {!loading &&
              currencies.map((c) => (
                <tr key={c._id}>
                  <td className={shared.mono}>{c.code}</td>
                  <td>{c.name}</td>
                  <td>{c.symbol}</td>
                  <td>{c.usdToCurrencyRate}</td>
                  <td>{c.isDefault ? <Badge variant="accent">Default</Badge> : <Button size="sm" variant="ghost" onClick={() => makeDefault(c)}>Set default</Button>}</td>
                  <td>
                    <Badge variant={c.active ? 'success' : 'neutral'}>{c.active ? 'active' : 'inactive'}</Badge>
                  </td>
                  <td>
                    <Button size="sm" variant="secondary" onClick={() => toggleActive(c)}>
                      {c.active ? 'Deactivate' : 'Activate'}
                    </Button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New Currency">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <Input label="Code (ISO 4217)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="EUR" />
          <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Euro" />
          <Input label="Symbol" value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} placeholder="€" />
          <Input label="1 USD = this many units" type="number" value={form.usdToCurrencyRate} onChange={(e) => setForm({ ...form, usdToCurrencyRate: e.target.value })} placeholder="0.92" />
          <Switch checked={form.isDefault} onChange={(isDefault) => setForm({ ...form, isDefault })} label="Set as platform default" />
          <Button fullWidth loading={submitting} onClick={submit}>
            Create Currency
          </Button>
        </div>
      </Modal>
    </div>
  );
}
