import { useEffect, useState } from 'react';
import { FiPieChart } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { Button, Input } from '@/components/ui';
import { grossMarginReportService, type ReportingSettings } from '@/services/grossMarginReportService';
import { dayjs } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import { SettingsField, SettingsSection } from '../components/SettingsSection';
import styles from './RoyaltyRulesSettings.module.css';

// The gross margin the organization works to: one percentage, set once. No cost
// is recorded for what is sold — not in the CRM, not in HaiVE — so the Gross
// Margin report applies this percentage to sales excluding tax and calls the
// result an estimate. Left empty, the report shows sales with no margin.
export function GrossMarginSetting() {
  const [saved, setSaved] = useState<ReportingSettings | null>(null);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    grossMarginReportService
      .getSettings()
      .then((settings) => {
        setSaved(settings);
        setValue(settings.grossMarginPct === null ? '' : String(settings.grossMarginPct));
      })
      .catch((err) => toast.error(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  const entered = value.trim();
  const unchanged = entered === (saved?.grossMarginPct === null || !saved ? '' : String(saved.grossMarginPct));

  const save = async () => {
    const pct = entered === '' ? null : Number(entered);
    if (pct !== null && (Number.isNaN(pct) || pct < 0 || pct > 100)) {
      toast.error('Enter a percentage between 0 and 100');
      return;
    }
    setSaving(true);
    try {
      const next = await grossMarginReportService.setGrossMarginPct(pct);
      setSaved(next);
      setValue(next.grossMarginPct === null ? '' : String(next.grossMarginPct));
      toast.success(
        next.grossMarginPct === null
          ? 'Gross margin percentage cleared'
          : `Gross margin set to ${next.grossMarginPct}%`,
      );
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      icon={<FiPieChart />}
      title="Gross Margin"
      description={
        saved?.grossMarginPct !== null && saved?.updatedAt
          ? `Set to ${saved.grossMarginPct}%${saved.updatedByName ? ` by ${saved.updatedByName}` : ''} on ${dayjs(saved.updatedAt).format('MMM D, YYYY')}. The Gross Margin report applies it to sales excluding tax, for every period.`
          : 'The share of your sales (excluding tax) that you keep as gross margin. The Gross Margin report applies this one percentage to every period.'
      }
      footer={
        <Button type="button" loading={saving} disabled={loading || unchanged} onClick={() => void save()}>
          Save
        </Button>
      }
    >
      <div className={styles.fieldGrid}>
        <SettingsField label="Gross Margin Percentage">
          <Input
            type="number"
            min={0}
            max={100}
            step="0.1"
            rightIcon="%"
            aria-label="Gross margin percentage"
            value={value}
            disabled={loading}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. 40"
          />
        </SettingsField>
      </div>
      <p className={styles.hint}>
        This is your own estimate: no cost is recorded for what you sell, so the report cannot measure a margin. Leave
        it empty and the report shows sales with no margin.
      </p>
    </SettingsSection>
  );
}
