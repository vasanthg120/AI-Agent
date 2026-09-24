import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiCpu, FiDatabase, FiDollarSign, FiRefreshCw, FiSearch, FiZap } from 'react-icons/fi';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, Button, Dropdown, Input, Modal, SectionCard, Skeleton, StatTile } from '@/components/ui';
import {
  aiUsageAdminService,
  type AnthropicModelBreakdownRow,
  type AnthropicOrganizationBreakdownRow,
  type AnthropicUsageRequestRow,
  type AnthropicUsageSummary,
  type AnthropicUsageTimeseriesPoint,
} from '@/services/aiUsageAdminService';
import { extractErrorMessage } from '@/utils/errors';
import { formatNumber } from '@/utils/format';
import { formatFullDate } from '@/utils/date';
import { AdminRangeControl } from './AdminRangeControl';
import { AdminPagination } from './components/AdminPagination';
import shared from './adminShared.module.css';
import styles from './AdminAiUsagePage.module.css';

const money = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(2)}`);

function FilterDropdown({ label, value, options, onChange }: { label: string; value?: string; options: { id: string; label: string }[]; onChange: (v?: string) => void }) {
  return (
    <Dropdown
      trigger={
        <button type="button" className={styles.filterTrigger}>
          {options.find((o) => o.id === value)?.label ?? label}
        </button>
      }
      items={[{ id: 'all', label: `All ${label.toLowerCase()}`, onSelect: () => onChange(undefined) }, ...options.map((o) => ({ id: o.id, label: o.label, onSelect: () => onChange(o.id) }))]}
    />
  );
}

// Two-series (input/output) area chart — AdminLineChart.tsx only supports one
// series (date/value), so this is a small sibling rather than a change to
// that shared component's contract. Same recharts library, same visual
// recipe (gradient fill, CartesianGrid, tooltip styling) as AdminLineChart.
function TokenUsageChart({ data }: { data: AnthropicUsageTimeseriesPoint[] }) {
  if (data.length === 0) {
    return <div className={styles.chartEmpty}>No data in this range yet.</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id="fill-input-tokens" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#5b8def" stopOpacity={0.35} />
            <stop offset="95%" stopColor="#5b8def" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="fill-output-tokens" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#fbbf24" stopOpacity={0.35} />
            <stop offset="95%" stopColor="#fbbf24" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis dataKey="date" stroke="var(--color-text-muted)" fontSize={11} />
        <YAxis stroke="var(--color-text-muted)" fontSize={11} tickFormatter={(v: number) => formatNumber(v)} />
        <Tooltip
          formatter={(value: number, name: string) => [formatNumber(value), name === 'inputTokens' ? 'Input' : 'Output']}
          contentStyle={{ background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)' }}
          labelStyle={{ color: 'var(--color-text-primary)' }}
        />
        <Area type="monotone" dataKey="inputTokens" name="inputTokens" stroke="#5b8def" strokeWidth={2} fill="url(#fill-input-tokens)" />
        <Area type="monotone" dataKey="outputTokens" name="outputTokens" stroke="#fbbf24" strokeWidth={2} fill="url(#fill-output-tokens)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function CostOverTimeChart({ data }: { data: AnthropicUsageTimeseriesPoint[] }) {
  if (data.length === 0) {
    return <div className={styles.chartEmpty}>No data in this range yet.</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id="fill-cost" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#5b8def" stopOpacity={0.35} />
            <stop offset="95%" stopColor="#5b8def" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis dataKey="date" stroke="var(--color-text-muted)" fontSize={11} />
        <YAxis stroke="var(--color-text-muted)" fontSize={11} tickFormatter={(v: number) => `$${v.toFixed(0)}`} />
        <Tooltip
          formatter={(value: number) => [`$${value.toFixed(2)}`, 'Cost']}
          contentStyle={{ background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)' }}
          labelStyle={{ color: 'var(--color-text-primary)' }}
        />
        <Area type="monotone" dataKey="cost" stroke="#5b8def" strokeWidth={2} fill="url(#fill-cost)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function SetBudgetModal({ open, onClose, current, onSaved }: { open: boolean; onClose: () => void; current: AnthropicUsageSummary['budget']; onSaved: () => void }) {
  const [amount, setAmount] = useState(current?.amount?.toString() ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setAmount(current?.amount?.toString() ?? '');
  }, [open, current]);

  const save = async () => {
    const value = Number.parseFloat(amount);
    if (!Number.isFinite(value) || value < 0) {
      toast.error('Enter a valid budget amount.');
      return;
    }
    setSaving(true);
    try {
      await aiUsageAdminService.setBudget(value, 'monthly');
      toast.success('Anthropic budget updated');
      onSaved();
      onClose();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Set Anthropic budget" description="Haive's own spend target for this credential — not an authoritative Anthropic account balance.">
      <Input label="Monthly budget (USD)" type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-5)' }}>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button loading={saving} onClick={save}>
          Save
        </Button>
      </div>
    </Modal>
  );
}

const STATUS_OPTIONS = [
  { id: 'success', label: 'Success' },
  { id: 'failed', label: 'Failed' },
];

export function AdminAiUsagePage() {
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<AnthropicUsageSummary | null>(null);
  const [timeseries, setTimeseries] = useState<AnthropicUsageTimeseriesPoint[]>([]);
  const [models, setModels] = useState<AnthropicModelBreakdownRow[]>([]);
  const [orgs, setOrgs] = useState<AnthropicOrganizationBreakdownRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [budgetModalOpen, setBudgetModalOpen] = useState(false);

  const [requestRows, setRequestRows] = useState<AnthropicUsageRequestRow[]>([]);
  const [requestTotal, setRequestTotal] = useState(0);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [modelFilter, setModelFilter] = useState<string | undefined>(undefined);
  const [orgFilter, setOrgFilter] = useState<string | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState('');
  const pageSize = 25;

  const loadOverview = () => {
    setLoading(true);
    Promise.all([
      aiUsageAdminService.getSummary(days),
      aiUsageAdminService.getTimeseries(days),
      aiUsageAdminService.getModelBreakdown(days),
      aiUsageAdminService.getOrganizationBreakdown(days),
    ])
      .then(([s, ts, m, o]) => {
        setSummary(s);
        setTimeseries(ts);
        setModels(m);
        setOrgs(o);
      })
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(loadOverview, [days]);

  useEffect(() => {
    setPage(1);
  }, [days, modelFilter, orgFilter, statusFilter, search]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setRequestsLoading(true);
      aiUsageAdminService
        .getRequests({
          days,
          page,
          pageSize,
          model: modelFilter,
          organizationId: orgFilter,
          status: statusFilter as 'success' | 'failed' | undefined,
          search: search || undefined,
        })
        .then((res) => {
          setRequestRows(res.items);
          setRequestTotal(res.total);
        })
        .catch((error) => toast.error(extractErrorMessage(error)))
        .finally(() => setRequestsLoading(false));
    }, 250);
    return () => clearTimeout(timeout);
  }, [days, page, modelFilter, orgFilter, statusFilter, search]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const s = await aiUsageAdminService.refresh(days);
      setSummary(s);
      toast.success('Usage refreshed');
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setRefreshing(false);
    }
  };

  const lastSynced = summary?.sync.lastSyncedAt ? formatFullDate(summary.sync.lastSyncedAt) : 'No usage recorded yet';

  return (
    <div className={shared.page}>
      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>AI Usage</h1>
          <p className={shared.pageSubtitle}>Anthropic Claude API token, cost, and budget monitoring across every organization.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <AdminRangeControl days={days} onChange={setDays} />
          <Button variant="secondary" size="sm" leftIcon={<FiRefreshCw />} loading={refreshing} onClick={handleRefresh}>
            Refresh
          </Button>
        </div>
      </div>

      {!loading && summary && !summary.connected && (
        <div className={styles.disconnectedBanner}>
          <Badge variant="danger" dot>
            Disconnected
          </Badge>
          Anthropic is not connected. Connect it in Settings → AI Provider to start tracking usage.
        </div>
      )}

      {!loading && summary?.connected && !summary.sync.providerReconciliationAvailable && (
        <div className={styles.reconciliationBanner}>Provider-level reconciliation unavailable for this API credential — showing Haive's internally recorded usage.</div>
      )}

      {loading || !summary ? (
        <div className={styles.statsGrid}>{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} height={92} />)}</div>
      ) : (
        <div className={styles.statsGrid}>
          <StatTile glass icon={FiDollarSign} value={summary.budget ? money(summary.budget.amount) : 'Not set'} label="Budget" />
          <StatTile glass icon={FiDollarSign} value={money(summary.usage.cost)} label="Consumed" />
          <StatTile glass icon={FiDollarSign} value={summary.usage.remaining != null ? money(summary.usage.remaining) : '—'} label="Remaining" />
          <StatTile
            glass
            icon={FiZap}
            value={summary.usage.percentage != null ? `${summary.usage.percentage}%` : '—'}
            label="Usage"
          />
          <StatTile glass icon={FiCpu} value={formatNumber(summary.tokens.input)} label="Input Tokens" />
          <StatTile glass icon={FiCpu} value={formatNumber(summary.tokens.output)} label="Output Tokens" />
          <StatTile glass icon={FiDatabase} value={formatNumber(summary.tokens.total)} label="Total Tokens" />
          <StatTile glass icon={FiZap} value={summary.requests.total.toLocaleString()} label="Total Requests" />
        </div>
      )}

      {!loading && summary && (
        <div className={styles.metaRow}>
          <span>Last recorded usage: {lastSynced}</span>
          <span>
            Successful: {summary.requests.successful.toLocaleString()} · Failed: {summary.requests.failed.toLocaleString()} · Cache read:{' '}
            {formatNumber(summary.tokens.cacheRead)} · Cache write: {formatNumber(summary.tokens.cacheCreation)}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setBudgetModalOpen(true)}>
            {summary.budget ? 'Edit budget' : 'Set budget'}
          </Button>
        </div>
      )}

      <div className={styles.chartsGrid}>
        <SectionCard glass title="Claude Cost Over Time" icon={FiDollarSign}>
          {loading ? <Skeleton height={220} /> : <CostOverTimeChart data={timeseries} />}
        </SectionCard>
        <SectionCard glass title="Token Usage Over Time" icon={FiCpu}>
          {loading ? <Skeleton height={220} /> : <TokenUsageChart data={timeseries} />}
        </SectionCard>
      </div>

      <SectionCard glass title="Model Breakdown" icon={FiCpu}>
        <div className={shared.tableWrap}>
          <table className={shared.table}>
            <thead>
              <tr>
                <th>Model</th>
                <th>Requests</th>
                <th>Input</th>
                <th>Output</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {loading &&
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={5}>
                      <Skeleton height={20} />
                    </td>
                  </tr>
                ))}
              {!loading && models.length === 0 && (
                <tr>
                  <td colSpan={5} className={shared.emptyState}>
                    No Claude usage recorded in this range yet.
                  </td>
                </tr>
              )}
              {!loading &&
                models.map((m) => (
                  <tr key={m.model}>
                    <td>{m.model}</td>
                    <td>{m.requests.toLocaleString()}</td>
                    <td>{formatNumber(m.inputTokens)}</td>
                    <td>{formatNumber(m.outputTokens)}</td>
                    <td>{money(m.cost)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard glass title="Organization Breakdown" icon={FiDatabase}>
        <div className={shared.tableWrap}>
          <table className={shared.table}>
            <thead>
              <tr>
                <th>Organization</th>
                <th>Requests</th>
                <th>Input</th>
                <th>Output</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {loading &&
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={5}>
                      <Skeleton height={20} />
                    </td>
                  </tr>
                ))}
              {!loading && orgs.length === 0 && (
                <tr>
                  <td colSpan={5} className={shared.emptyState}>
                    No Claude usage recorded in this range yet.
                  </td>
                </tr>
              )}
              {!loading &&
                orgs.map((o) => (
                  <tr key={o.organizationId}>
                    <td>{o.organizationName}</td>
                    <td>{o.requests.toLocaleString()}</td>
                    <td>{formatNumber(o.inputTokens)}</td>
                    <td>{formatNumber(o.outputTokens)}</td>
                    <td>{money(o.cost)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard glass title="Request History" icon={FiZap}>
        <div className={shared.toolbar}>
          <Input
            className={shared.searchInput}
            placeholder="Search by request or organization id..."
            leftIcon={<FiSearch />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <FilterDropdown label="Model" value={modelFilter} options={models.map((m) => ({ id: m.model, label: m.model }))} onChange={setModelFilter} />
          <FilterDropdown label="Organization" value={orgFilter} options={orgs.map((o) => ({ id: o.organizationId, label: o.organizationName }))} onChange={setOrgFilter} />
          <FilterDropdown label="Status" value={statusFilter} options={STATUS_OPTIONS} onChange={setStatusFilter} />
        </div>

        <div className={shared.tableWrap}>
          <table className={shared.table}>
            <thead>
              <tr>
                <th>Date/Time</th>
                <th>Organization</th>
                <th>User</th>
                <th>Model</th>
                <th>Input</th>
                <th>Output</th>
                <th>Total</th>
                <th>Cost</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {requestsLoading &&
                Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={9}>
                      <Skeleton height={20} />
                    </td>
                  </tr>
                ))}
              {!requestsLoading && requestRows.length === 0 && (
                <tr>
                  <td colSpan={9} className={shared.emptyState}>
                    No requests match these filters.
                  </td>
                </tr>
              )}
              {!requestsLoading &&
                requestRows.map((r) => (
                  <tr key={r.id}>
                    <td>{formatFullDate(r.occurredAt)}</td>
                    <td>{r.organizationName ?? '—'}</td>
                    <td>{r.userName ?? '—'}</td>
                    <td>{r.model}</td>
                    <td>{r.inputTokens.toLocaleString()}</td>
                    <td>{r.outputTokens.toLocaleString()}</td>
                    <td>{r.totalTokens.toLocaleString()}</td>
                    <td>{money(r.cost)}</td>
                    <td>
                      <Badge variant={r.status === 'success' ? 'success' : 'danger'}>{r.status}</Badge>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <AdminPagination page={page} limit={pageSize} total={requestTotal} onChange={setPage} />
      </SectionCard>

      <SetBudgetModal open={budgetModalOpen} onClose={() => setBudgetModalOpen(false)} current={summary?.budget ?? null} onSaved={loadOverview} />
    </div>
  );
}
