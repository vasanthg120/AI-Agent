import { useState } from 'react';
import toast from 'react-hot-toast';
import { FiEdit3, FiFileText, FiGrid, FiUpload } from 'react-icons/fi';
import { Button, Card } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { agentRolesService } from '@/services/agentRolesService';
import { AGENT_TEMPLATES } from '../../settings/tabs/agent-roles/agentTemplates';
import { applyGeneratedRole, type FormState } from '../formState';
import styles from './steps.module.css';

const ACCEPTED_EXTENSIONS = '.pdf,.docx,.xlsx,.xls,.csv,.html,.htm,.txt,.md';

export function StepStart({ onComplete }: { onComplete: (patch: Partial<FormState>) => void }) {
  const [method, setMethod] = useState<'choose' | 'template' | 'documents' | 'describe'>('choose');
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState('');

  const handleDocument = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const role = await agentRolesService.generate(file);
      toast.success('Draft generated — review and adjust anything below.');
      onComplete(applyGeneratedRole(role));
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDescribe = async () => {
    if (description.trim().length < 10) {
      toast.error('Describe the agent in a bit more detail (at least 10 characters).');
      return;
    }
    setBusy(true);
    try {
      const role = await agentRolesService.generateFromDescription(description.trim());
      toast.success('Draft generated — review and adjust anything below.');
      onComplete(applyGeneratedRole(role));
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (method === 'choose') {
    return (
      <div className={styles.stepBody}>
        <p className={styles.stepIntro}>How would you like to start? You can change anything in the next steps either way.</p>
        <div className={styles.methodGrid}>
          <Card interactive className={styles.methodCard} onClick={() => setMethod('template')}>
            <FiGrid size={20} />
            <span className={styles.methodTitle}>Start from a template</span>
            <span className={styles.methodBlurb}>Pick a common role (Sales, Finance, HR…) with sensible defaults already filled in.</span>
          </Card>
          <Card interactive className={styles.methodCard} onClick={() => setMethod('documents')}>
            <FiUpload size={20} />
            <span className={styles.methodTitle}>Generate from a document</span>
            <span className={styles.methodBlurb}>Upload a job description or SOP and let AI draft the configuration.</span>
          </Card>
          <Card interactive className={styles.methodCard} onClick={() => setMethod('describe')}>
            <FiFileText size={20} />
            <span className={styles.methodTitle}>Describe it in plain English</span>
            <span className={styles.methodBlurb}>Write a couple of sentences about what this agent should do.</span>
          </Card>
          <Card interactive className={styles.methodCard} onClick={() => onComplete({})}>
            <FiEdit3 size={20} />
            <span className={styles.methodTitle}>Start from scratch</span>
            <span className={styles.methodBlurb}>Build every step yourself.</span>
          </Card>
        </div>
      </div>
    );
  }

  if (method === 'template') {
    return (
      <div className={styles.stepBody}>
        <Button type="button" variant="ghost" size="sm" onClick={() => setMethod('choose')}>
          ← Back
        </Button>
        <div className={styles.methodGrid}>
          {AGENT_TEMPLATES.map((template) => (
            <Card
              key={template.id}
              interactive
              className={styles.methodCard}
              onClick={() =>
                onComplete({
                  name: template.config.name,
                  department: (template.config.department as FormState['department']) ?? 'custom',
                  description: template.config.description ?? '',
                  systemPrompt: template.config.systemPrompt,
                  allowedTools: template.config.allowedTools ?? [],
                })
              }
            >
              <span className={styles.methodTitle}>{template.label}</span>
              <span className={styles.methodBlurb}>{template.blurb}</span>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (method === 'documents') {
    return (
      <div className={styles.stepBody}>
        <Button type="button" variant="ghost" size="sm" onClick={() => setMethod('choose')}>
          ← Back
        </Button>
        <p className={styles.stepIntro}>
          Upload a job description, SOP, or role brief — AI will draft a name, purpose, and instructions from it.
        </p>
        <input
          type="file"
          accept={ACCEPTED_EXTENSIONS}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className={styles.fileInput}
        />
        {file && <span className={styles.fileName}>{file.name}</span>}
        <Button type="button" disabled={!file} loading={busy} onClick={() => void handleDocument()}>
          Generate Configuration
        </Button>
        {busy && <p className={styles.helperText}>Analyzing document — this can take up to 15 seconds…</p>}
      </div>
    );
  }

  return (
    <div className={styles.stepBody}>
      <Button type="button" variant="ghost" size="sm" onClick={() => setMethod('choose')}>
        ← Back
      </Button>
      <p className={styles.stepIntro}>Describe what this agent should do, in your own words.</p>
      <textarea
        className={styles.textarea}
        rows={5}
        placeholder="e.g. Handles incoming customer support questions using our policy documents, and escalates anything it isn't sure about."
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <Button type="button" loading={busy} onClick={() => void handleDescribe()}>
        Generate Configuration
      </Button>
    </div>
  );
}
