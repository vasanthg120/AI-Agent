import { useEffect, useState } from 'react';
import { FiPercent, FiRotateCcw } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { Badge, Button, Input, Switch } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { dayjs } from '@/utils/date';
import {
  royaltyRulesService,
  type RoyaltyCapType,
  type RoyaltyRule,
  type RoyaltySlidingTier,
} from '@/services/royaltyRulesService';
import { SettingsField, SettingsSection } from '../components/SettingsSection';
import styles from './RoyaltyRulesSettings.module.css';

const CAP_TYPE_LABEL: Record<RoyaltyCapType, string> = {
  none: 'No cap',
  min: 'Minimum',
  max: 'Maximum',
  sliding: 'Sliding scale',
};

interface DraftTier {
  fromValue: string;
  toValue: string;
  percentage: string;
}

function defaultDraft() {
  return {
    royaltyPercentage: '',
    capType: 'none' as RoyaltyCapType,
    capValue: '',
    slidingTiers: [] as DraftTier[],
    marketingFeeAmount: '',
    otherFeeAmount: '',
    excludeTax: true,
    excludeShipping: true,
    excludeDiscount: false,
    effectiveDate: dayjs().format('YYYY-MM-DD'),
  };
}

// Effective-dated, append-only on the backend (royalty-rules.service.ts) —
// this UI directly reflects that model: "Save as new version" always
// creates a new row rather than editing the live one in place, plus a
// read-only History table below, matching the plan's explicit decision not
// to hide the versioning behind a single-editable-doc illusion.
export function RoyaltyRulesSettings() {
  const [current, setCurrent] = useState<RoyaltyRule | null>(null);
  const [history, setHistory] = useState<RoyaltyRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(defaultDraft());

  const load = async () => {
    setLoading(true);
    try {
      const [currentRule, historyList] = await Promise.all([
        royaltyRulesService.getCurrent(),
        royaltyRulesService.listHistory(),
      ]);
      setCurrent(currentRule);
      setHistory(historyList);
      if (currentRule) {
        setDraft({
          royaltyPercentage: String(currentRule.royaltyPercentage),
          capType: currentRule.capType,
          capValue: currentRule.capValue !== undefined ? String(currentRule.capValue) : '',
          slidingTiers: currentRule.slidingTiers.map((t) => ({
            fromValue: String(t.fromValue),
            toValue: t.toValue !== undefined ? String(t.toValue) : '',
            percentage: String(t.percentage),
          })),
          marketingFeeAmount: currentRule.marketingFeeAmount !== undefined ? String(currentRule.marketingFeeAmount) : '',
          otherFeeAmount: currentRule.otherFeeAmount !== undefined ? String(currentRule.otherFeeAmount) : '',
          excludeTax: currentRule.excludeTax,
          excludeShipping: currentRule.excludeShipping,
          excludeDiscount: currentRule.excludeDiscount,
          effectiveDate: dayjs().format('YYYY-MM-DD'),
        });
      }
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const setTier = (index: number, key: keyof DraftTier, value: string) => {
    setDraft((prev) => ({
      ...prev,
      slidingTiers: prev.slidingTiers.map((t, i) => (i === index ? { ...t, [key]: value } : t)),
    }));
  };
  const addTier = () =>
    setDraft((prev) => ({ ...prev, slidingTiers: [...prev.slidingTiers, { fromValue: '', toValue: '', percentage: '' }] }));
  const removeTier = (index: number) =>
    setDraft((prev) => ({ ...prev, slidingTiers: prev.slidingTiers.filter((_, i) => i !== index) }));

  const handleSave = async () => {
    const royaltyPercentage = Number(draft.royaltyPercentage);
    if (!draft.royaltyPercentage || Number.isNaN(royaltyPercentage) || royaltyPercentage < 0) {
      toast.error('Enter a valid royalty percentage');
      return;
    }
    if (!draft.effectiveDate) {
      toast.error('Choose an effective date');
      return;
    }
    if ((draft.capType === 'min' || draft.capType === 'max') && !draft.capValue) {
      toast.error('Enter a cap value');
      return;
    }
    if (draft.capType === 'sliding' && draft.slidingTiers.length === 0) {
      toast.error('Add at least one sliding tier');
      return;
    }

    setSaving(true);
    try {
      await royaltyRulesService.create({
        royaltyPercentage,
        capType: draft.capType,
        capValue: draft.capValue ? Number(draft.capValue) : undefined,
        slidingTiers:
          draft.capType === 'sliding'
            ? draft.slidingTiers.map<RoyaltySlidingTier>((t) => ({
                fromValue: Number(t.fromValue) || 0,
                toValue: t.toValue ? Number(t.toValue) : undefined,
                percentage: Number(t.percentage) || 0,
              }))
            : undefined,
        marketingFeeAmount: draft.marketingFeeAmount ? Number(draft.marketingFeeAmount) : undefined,
        otherFeeAmount: draft.otherFeeAmount ? Number(draft.otherFeeAmount) : undefined,
        excludeTax: draft.excludeTax,
        excludeShipping: draft.excludeShipping,
        excludeDiscount: draft.excludeDiscount,
        effectiveDate: draft.effectiveDate,
      });
      toast.success('Royalty rule version saved');
      await load();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SettingsSection title="Loading…">
        <p>Loading royalty rules…</p>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection icon={<FiPercent />}
        title="Current Royalty Rule"
        description={
          current
            ? `Currently in effect since ${dayjs(current.effectiveDate).format('MMM D, YYYY')}. Saving below creates a new version — past reports keep using whichever version was active at the time.`
            : 'No royalty rule has been set for this organization yet.'
        }
        footer={
          <Button type="button" loading={saving} onClick={() => void handleSave()}>
            Save as New Version
          </Button>
        }
      >
        <div className={styles.fieldGrid}>
          <SettingsField label="Royalty Percentage">
            <Input
              type="number"
              min={0}
              rightIcon="%"
              value={draft.royaltyPercentage}
              onChange={(e) => setDraft((prev) => ({ ...prev, royaltyPercentage: e.target.value }))}
              placeholder="e.g. 6"
            />
          </SettingsField>
          <SettingsField label="Cap Type">
            <select
              className={styles.select}
              value={draft.capType}
              onChange={(e) => setDraft((prev) => ({ ...prev, capType: e.target.value as RoyaltyCapType }))}
            >
              {(Object.keys(CAP_TYPE_LABEL) as RoyaltyCapType[]).map((t) => (
                <option key={t} value={t}>
                  {CAP_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </SettingsField>
          {(draft.capType === 'min' || draft.capType === 'max') && (
            <SettingsField label={draft.capType === 'min' ? 'Minimum Cap Value' : 'Maximum Cap Value'}>
              <Input
                type="number"
                min={0}
                leftIcon="₹"
                value={draft.capValue}
                onChange={(e) => setDraft((prev) => ({ ...prev, capValue: e.target.value }))}
              />
            </SettingsField>
          )}
          <SettingsField label="Effective Date">
            <input
              type="date"
              className={styles.dateInput}
              value={draft.effectiveDate}
              onChange={(e) => setDraft((prev) => ({ ...prev, effectiveDate: e.target.value }))}
            />
          </SettingsField>
        </div>

        {draft.capType === 'sliding' && (
          <SettingsField label="Sliding Tiers">
            <div className={styles.tierList}>
              {draft.slidingTiers.map((tier, i) => (
                <div key={i} className={styles.tierRow}>
                  <div className={styles.tierField}>
                    <Input
                      type="number"
                      min={0}
                      leftIcon="₹"
                      placeholder="From"
                      value={tier.fromValue}
                      onChange={(e) => setTier(i, 'fromValue', e.target.value)}
                    />
                  </div>
                  <div className={styles.tierField}>
                    <Input
                      type="number"
                      min={0}
                      leftIcon="₹"
                      placeholder="To (blank = no limit)"
                      value={tier.toValue}
                      onChange={(e) => setTier(i, 'toValue', e.target.value)}
                    />
                  </div>
                  <div className={styles.tierField}>
                    <Input
                      type="number"
                      min={0}
                      rightIcon="%"
                      placeholder="Rate"
                      value={tier.percentage}
                      onChange={(e) => setTier(i, 'percentage', e.target.value)}
                    />
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => removeTier(i)}>
                    Remove
                  </Button>
                </div>
              ))}
              <Button type="button" variant="ghost" size="sm" onClick={addTier}>
                + Add Tier
              </Button>
            </div>
          </SettingsField>
        )}

        <div className={styles.fieldGrid}>
          <SettingsField label="Marketing Fee">
            <Input
              type="number"
              min={0}
              leftIcon="₹"
              value={draft.marketingFeeAmount}
              onChange={(e) => setDraft((prev) => ({ ...prev, marketingFeeAmount: e.target.value }))}
            />
          </SettingsField>
          <SettingsField label="Other Fee">
            <Input
              type="number"
              min={0}
              leftIcon="₹"
              value={draft.otherFeeAmount}
              onChange={(e) => setDraft((prev) => ({ ...prev, otherFeeAmount: e.target.value }))}
            />
          </SettingsField>
        </div>

        <SettingsField label="Excluded from Eligible Value">
          <div className={styles.switchGroup}>
            <Switch
              label="Exclude tax"
              checked={draft.excludeTax}
              onChange={(v) => setDraft((prev) => ({ ...prev, excludeTax: v }))}
            />
            <Switch
              label="Exclude shipping"
              checked={draft.excludeShipping}
              onChange={(v) => setDraft((prev) => ({ ...prev, excludeShipping: v }))}
            />
            <Switch
              label="Exclude discount"
              checked={draft.excludeDiscount}
              onChange={(v) => setDraft((prev) => ({ ...prev, excludeDiscount: v }))}
            />
          </div>
        </SettingsField>
      </SettingsSection>

      <SettingsSection
        icon={<FiRotateCcw />}
        title="Version History"
        description="Every royalty rule version ever saved, most recent first."
      >
        {history.length === 0 ? (
          <div className={styles.emptyState}>No versions saved yet.</div>
        ) : (
          <table className={styles.historyTable}>
            <thead>
              <tr>
                <th>Effective</th>
                <th>Royalty %</th>
                <th>Cap</th>
                <th>Status</th>
                <th>Saved</th>
              </tr>
            </thead>
            <tbody>
              {history.map((rule) => (
                <tr key={rule._id}>
                  <td>{dayjs(rule.effectiveDate).format('MMM D, YYYY')}</td>
                  <td>{rule.royaltyPercentage}%</td>
                  <td>{CAP_TYPE_LABEL[rule.capType]}</td>
                  <td>
                    {rule._id === current?._id ? (
                      <Badge variant="success">Current</Badge>
                    ) : dayjs(rule.effectiveDate).isAfter(dayjs()) ? (
                      <Badge variant="info">Upcoming</Badge>
                    ) : (
                      <Badge variant="neutral">Superseded</Badge>
                    )}
                  </td>
                  <td>{dayjs(rule.createdAt).format('MMM D, YYYY')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SettingsSection>
    </>
  );
}
