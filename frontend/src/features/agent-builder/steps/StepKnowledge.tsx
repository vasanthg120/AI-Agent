import { useState } from 'react';
import toast from 'react-hot-toast';
import { FiCheckCircle, FiUploadCloud } from 'react-icons/fi';
import { Badge, SectionCard } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { businessKnowledgeDocumentsService, type BusinessKnowledgeDocument } from '@/services/businessKnowledgeDocumentsService';
import type { FormState } from '../formState';
import styles from './steps.module.css';

const SUPPORTED_TYPES: { label: string; hint: string }[] = [
  { label: 'PDFs & Word documents', hint: 'Policies, SOPs, brochures, agreements' },
  { label: 'Excel & CSV files', hint: 'Price lists, product catalogs, data exports' },
  { label: 'Company policies & manuals', hint: 'So the agent answers questions consistently' },
  { label: 'Product & service documentation', hint: 'Sales decks, brand guidelines, terms' },
];

export function StepKnowledge({ form }: { form: FormState }) {
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState<BusinessKnowledgeDocument[]>([]);

  const handleUpload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const doc = await businessKnowledgeDocumentsService.upload(file);
      setUploaded((prev) => [...prev, doc]);
      toast.success(`${file.name} uploaded — it will be searchable once processing finishes.`);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className={styles.stepBody}>
      <SectionCard title="Already available to every agent" icon={FiCheckCircle}>
        <p className={styles.stepIntro}>
          Your agents can already search your organization's Business Profile, CRM records, and any documents uploaded
          before — no setup needed here.
        </p>
      </SectionCard>

      <SectionCard title="Add documents for this agent" icon={FiUploadCloud}>
        <p className={styles.stepIntro}>
          Upload anything specific to this agent's role. <strong>These join your organization's shared knowledge base</strong> —
          every agent can search them, there isn't a way yet to keep documents private to one agent.
        </p>
        <div className={styles.knowledgeGrid}>
          {SUPPORTED_TYPES.map((type) => (
            <div key={type.label} className={styles.knowledgeItem}>
              <span className={styles.knowledgeItemTitle}>{type.label}</span>
              <span className={styles.knowledgeItemHint}>{type.hint}</span>
            </div>
          ))}
        </div>
        <input
          type="file"
          accept=".pdf,.docx,.doc,.xlsx,.xls,.csv,.pptx,.txt,.md,.html"
          disabled={uploading}
          onChange={(e) => void handleUpload(e.target.files?.[0])}
          className={styles.fileInput}
        />
        {uploaded.length > 0 && (
          <div className={styles.uploadedList}>
            {uploaded.map((doc) => (
              <div key={doc._id} className={styles.uploadedRow}>
                <Badge variant="success">Uploaded</Badge>
                {doc.originalFilename}
              </div>
            ))}
          </div>
        )}
        {form.sourceDocumentName && (
          <p className={styles.helperText}>This agent was originally generated from: {form.sourceDocumentName}</p>
        )}
      </SectionCard>

      <SectionCard title="Web access" icon={FiUploadCloud}>
        <p className={styles.stepIntro}>
          To let this agent search the live web instead of (or alongside) your documents, enable{' '}
          <strong>Web Search</strong> in the Tools & Capabilities step.
        </p>
      </SectionCard>
    </div>
  );
}
