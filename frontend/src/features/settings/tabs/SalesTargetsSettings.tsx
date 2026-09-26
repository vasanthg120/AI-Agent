import { useEffect, useMemo, useState } from 'react';
import { FiShoppingBag, FiTarget, FiUsers } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { Button, Input } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { dayjs } from '@/utils/date';
import { organizationsService, type Store } from '@/services/organizationsService';
import { usersService, type AdminUser } from '@/services/usersService';
import { salesTargetsService, type SalesTarget, type TargetScope } from '@/services/salesTargetsService';
import { SettingsField, SettingsSection } from '../components/SettingsSection';
import styles from './SalesTargetsSettings.module.css';

type RowKey = string;

function rowKey(scope: TargetScope, id?: string): RowKey {
  return `${scope}:${id ?? ''}`;
}

export function SalesTargetsSettings() {
  const [period, setPeriod] = useState(() => dayjs().format('YYYY-MM'));
  const [stores, setStores] = useState<Store[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [targets, setTargets] = useState<SalesTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<RowKey, string>>({});
  const [saving, setSaving] = useState<Record<RowKey, boolean>>({});

  const load = async (forPeriod: string) => {
    setLoading(true);
    try {
      const [storeList, userList, targetList] = await Promise.all([
        organizationsService.listStores(),
        usersService.list(),
        salesTargetsService.list(forPeriod),
      ]);
      setStores(storeList);
      setUsers(userList);
      setTargets(targetList);

      const nextDrafts: Record<RowKey, string> = {};
      for (const t of targetList) {
        nextDrafts[rowKey(t.scope, t.storeId ?? t.userId)] = String(t.targetAmount);
      }
      setDrafts(nextDrafts);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(period);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  // Managers don't get a personal target here — their dashboard's
  // achievement % is store-scoped (SalesAnalyticsService.getAchievement
  // ('store', ...)), not user-scoped, so a manager never actually reads a
  // 'user'-scope target the way a consultant does. Only consultants are
  // assignable.
  const employees = useMemo(() => users.filter((u) => u.roles.includes('consultant')), [users]);

  const currentValue = (scope: TargetScope, id?: string): string => drafts[rowKey(scope, id)] ?? '';
  const existingTarget = (scope: TargetScope, id?: string): SalesTarget | undefined =>
    targets.find((t) => t.scope === scope && (t.storeId ?? t.userId) === id);

  const handleSave = async (scope: TargetScope, id: string | undefined, storeId?: string) => {
    const key = rowKey(scope, id);
    const raw = drafts[key];
    const amount = Number(raw);
    if (!raw || Number.isNaN(amount) || amount < 0) {
      toast.error('Enter a valid target amount');
      return;
    }

    setSaving((prev) => ({ ...prev, [key]: true }));
    try {
      const saved = await salesTargetsService.upsert({
        scope,
        period,
        targetAmount: amount,
        currency: 'INR',
        storeId: scope === 'store' ? id : storeId,
        userId: scope === 'user' ? id : undefined,
      });
      setTargets((prev) => [...prev.filter((t) => !(t.scope === scope && (t.storeId ?? t.userId) === id)), saved]);
      toast.success('Target saved');
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving((prev) => ({ ...prev, [key]: false }));
    }
  };

  const isDirty = (scope: TargetScope, id?: string): boolean => {
    const existing = existingTarget(scope, id);
    const draft = currentValue(scope, id);
    if (!existing) return draft.trim() !== '';
    return draft !== String(existing.targetAmount);
  };

  return (
    <>
      <SettingsSection icon={<FiTarget />}
        title="Sales Targets"
        description="Set the monthly sales target (in ₹) for each store and each consultant. Dashboards compute achievement % and forecasts against these."
      >
        <SettingsField label="Month">
          <input
            type="month"
            className={styles.monthInput}
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          />
        </SettingsField>
      </SettingsSection>

      {loading ? (
        <SettingsSection title="Loading…">
          <p>Loading targets…</p>
        </SettingsSection>
      ) : (
        <>
          <SettingsSection
            icon={<FiShoppingBag />}
            title="Store Targets"
            description="Target per store for this month."
          >
            {stores.length === 0 ? (
              <p>No stores yet.</p>
            ) : (
              <div className={styles.targetList}>
                {stores.map((s) => (
                  <div key={s._id} className={styles.targetRow}>
                    <span className={styles.targetName}>{s.name}</span>
                    <div className={styles.amountField}>
                      <Input
                        type="number"
                        min={0}
                        leftIcon="₹"
                        value={currentValue('store', s._id)}
                        onChange={(e) =>
                          setDrafts((prev) => ({ ...prev, [rowKey('store', s._id)]: e.target.value }))
                        }
                        placeholder="Target amount"
                      />
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      disabled={saving[rowKey('store', s._id)] || !isDirty('store', s._id)}
                      onClick={() => void handleSave('store', s._id)}
                    >
                      {saving[rowKey('store', s._id)] ? 'Saving…' : 'Save'}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </SettingsSection>

          <SettingsSection icon={<FiUsers />}
            title="Employee Targets"
            description="Target per consultant for this month — this drives their personal dashboard."
          >
            {employees.length === 0 ? (
              <p>No consultants yet — create one from the Users tab first.</p>
            ) : (
              <div className={styles.targetList}>
                {employees.map((u) => (
                  <div key={u.id} className={styles.targetRow}>
                    <span className={styles.targetName}>{u.name}</span>
                    <div className={styles.amountField}>
                      <Input
                        type="number"
                        min={0}
                        leftIcon="₹"
                        value={currentValue('user', u.id)}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [rowKey('user', u.id)]: e.target.value }))}
                        placeholder="Target amount"
                      />
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      disabled={saving[rowKey('user', u.id)] || !isDirty('user', u.id)}
                      onClick={() => void handleSave('user', u.id, u.storeId)}
                    >
                      {saving[rowKey('user', u.id)] ? 'Saving…' : 'Save'}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </SettingsSection>
        </>
      )}
    </>
  );
}
