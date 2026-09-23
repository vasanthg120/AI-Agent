import { useState } from 'react';
import { FiBookOpen, FiShield } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { Button, Input, SectionCard, Skeleton, StringListEditor } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { businessProfileService, type BusinessProfile, type UpsertBusinessProfilePayload } from '@/services/businessProfileService';
import { TermsAndConditionsPolicy } from './TermsAndConditionsPolicy';
import styles from '../business-knowledge.module.css';

function TextAreaField({ label, value, onChange }: { label: string; value?: string; onChange: (value: string) => void }) {
  return (
    <div>
      <span className={styles.fieldLabel}>{label}</span>
      <textarea className={styles.textarea} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
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

  return (
    <div className={styles.tabContent}>
      <div className={styles.completenessRow}>
        <span>Profile completeness: {working.completenessPct}%</span>
        <div className={styles.completenessTrack}>
          <div className={styles.completenessFill} style={{ width: `${working.completenessPct}%` }} />
        </div>
      </div>

      <SectionCard title="Identity" icon={FiBookOpen}>
        <div className={styles.formGrid}>
          <div className={styles.twoColumn}>
            <Input label="Business Name" value={working.businessName ?? ''} disabled={!canEdit} onChange={(e) => set('businessName', e.target.value)} />
            <Input label="Industry" value={working.industry ?? ''} disabled={!canEdit} onChange={(e) => set('industry', e.target.value)} />
          </div>
          <Input label="Website" value={working.website ?? ''} disabled={!canEdit} onChange={(e) => set('website', e.target.value)} />
          <TextAreaField label="Description" value={working.description} onChange={(v) => set('description', v)} />
          <StringListEditor label="Branches / Locations" items={working.branches} onChange={(v) => set('branches', v)} addLabel="Add branch" />
        </div>
      </SectionCard>

      <SectionCard title="Policies" icon={FiShield}>
        <div className={styles.formGrid}>
          <TermsAndConditionsPolicy canEdit={canEdit} />
        </div>
      </SectionCard>

      {canEdit && (
        <div>
          <Button type="button" disabled={saving} onClick={() => void handleSave()}>
            {saving ? 'Saving…' : 'Save Business Profile'}
          </Button>
        </div>
      )}
    </div>
  );
}
