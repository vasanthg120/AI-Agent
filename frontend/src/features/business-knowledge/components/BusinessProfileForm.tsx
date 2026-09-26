import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FiBookOpen, FiCheck, FiRotateCcw, FiShield } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { Button, Input, SectionCard, Skeleton, StringListEditor } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { businessProfileService, type BusinessProfile, type UpsertBusinessProfilePayload } from '@/services/businessProfileService';
import { TermsAndConditionsPolicy } from './TermsAndConditionsPolicy';
import styles from '../business-knowledge.module.css';

function TextAreaField({
  label,
  value,
  disabled,
  placeholder,
  onChange,
}: {
  label: string;
  value?: string;
  disabled?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span className={styles.fieldLabel}>{label}</span>
      <textarea
        className={styles.textarea}
        value={value ?? ''}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

// Circular progress ring for profile completeness.
function CompletenessRing({ pct }: { pct: number }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  return (
    <svg className={styles.ring} viewBox="0 0 56 56" aria-hidden>
      <circle cx="28" cy="28" r={r} className={styles.ringTrack} />
      <motion.circle
        cx="28"
        cy="28"
        r={r}
        className={styles.ringFill}
        strokeDasharray={c}
        initial={{ strokeDashoffset: c }}
        animate={{ strokeDashoffset: c * (1 - pct / 100) }}
        transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
      />
    </svg>
  );
}

function completenessMessage(pct: number): string {
  if (pct >= 90) return 'Excellent — the AI has a complete picture of your business.';
  if (pct >= 60) return "Good start. A few more details will make the AI's answers noticeably sharper.";
  return 'The more you fill in, the more accurately the AI can talk about your business.';
}

export function BusinessProfileForm({
  profile,
  isLoading,
  canEdit,
  onSaved,
}: {
  profile: BusinessProfile | undefined;
  isLoading: boolean;
  canEdit: boolean;
  onSaved: (profile: BusinessProfile) => void;
}) {
  const [draft, setDraft] = useState<BusinessProfile | null>(null);
  const [saving, setSaving] = useState(false);

  const working = draft ?? profile;

  const set = <K extends keyof BusinessProfile>(key: K, value: BusinessProfile[K]) => {
    if (!working) return;
    setDraft({ ...working, [key]: value });
  };

  const handleSave = async () => {
    if (!working) return;
    setSaving(true);
    try {
      const payload: UpsertBusinessProfilePayload = {
        businessName: working.businessName,
        description: working.description,
        industry: working.industry,
        website: working.website,
        branches: working.branches,
        products: working.products,
        services: working.services,
        brands: working.brands,
        pricingPolicies: working.pricingPolicies,
        salesProcess: working.salesProcess,
        customerJourney: working.customerJourney,
        targetAudience: working.targetAudience,
        vision: working.vision,
        mission: working.mission,
        values: working.values,
        faqs: working.faqs,
        termsAndConditions: working.termsAndConditions,
        warrantyPolicy: working.warrantyPolicy,
        refundPolicy: working.refundPolicy,
        shippingPolicy: working.shippingPolicy,
        businessRules: working.businessRules,
        standardOperatingProcedures: working.standardOperatingProcedures,
        salesGuidelines: working.salesGuidelines,
        marketingGuidelines: working.marketingGuidelines,
        internalPolicies: working.internalPolicies,
      };
      const saved = await businessProfileService.upsert(payload);
      setDraft(null);
      onSaved(saved);
      toast.success('Business profile saved — the AI can use this right away');
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (isLoading || !working) {
    return (
      <div className={styles.tabContent}>
        <Skeleton height={100} />
        <Skeleton height={220} />
      </div>
    );
  }

  const dirty = draft !== null;

  return (
    <div className={styles.tabContent}>
      <div className={styles.completenessCard}>
        <div className={styles.ringWrap}>
          <CompletenessRing pct={working.completenessPct} />
          <span className={styles.ringValue}>{working.completenessPct}%</span>
        </div>
        <div className={styles.completenessText}>
          <span className={styles.completenessTitle}>Profile completeness</span>
          <span className={styles.completenessHint}>{completenessMessage(working.completenessPct)}</span>
        </div>
      </div>

      <SectionCard title="Identity" icon={FiBookOpen}>
        <div className={styles.formGrid}>
          <div className={styles.twoColumn}>
            <Input label="Business Name" value={working.businessName ?? ''} disabled={!canEdit} onChange={(e) => set('businessName', e.target.value)} />
            <Input label="Industry" value={working.industry ?? ''} disabled={!canEdit} onChange={(e) => set('industry', e.target.value)} />
          </div>
          <Input label="Website" value={working.website ?? ''} disabled={!canEdit} onChange={(e) => set('website', e.target.value)} />
          <TextAreaField
            label="Description"
            value={working.description}
            disabled={!canEdit}
            placeholder="What does your business do, and who for? A few sentences is plenty."
            onChange={(v) => set('description', v)}
          />
          <StringListEditor label="Branches / Locations" items={working.branches} onChange={(v) => set('branches', v)} addLabel="Add branch" />
        </div>
      </SectionCard>

      <SectionCard title="Policies" icon={FiShield}>
        <div className={styles.formGrid}>
          <TermsAndConditionsPolicy canEdit={canEdit} />
        </div>
      </SectionCard>

      {/* Only appears once something has actually changed, and stays pinned
          to the bottom of the page so saving never means scrolling back. */}
      <AnimatePresence>
        {canEdit && dirty && (
          <motion.div
            className={styles.saveBar}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          >
            <span className={styles.saveBarText}>
              <span className={styles.saveBarDot} />
              You have unsaved changes
            </span>
            <div className={styles.saveBarActions}>
              <Button type="button" variant="ghost" size="sm" leftIcon={<FiRotateCcw />} disabled={saving} onClick={() => setDraft(null)}>
                Discard
              </Button>
              <Button type="button" size="sm" leftIcon={<FiCheck />} loading={saving} disabled={saving} onClick={() => void handleSave()}>
                {saving ? 'Saving…' : 'Save profile'}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
