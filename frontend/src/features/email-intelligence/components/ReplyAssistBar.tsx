import { useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FiCpu } from 'react-icons/fi';
import { Button, Spinner, Switch } from '@/components/ui';
import {
  emailIntelligenceService,
  type EmailDraftSummary,
  type EmailInboxSettings,
} from '@/services/emailIntelligenceService';
import { extractErrorMessage } from '@/utils/errors';
import styles from '../email-intelligence.module.css';

export const DRAFT_SUMMARY_KEY = ['email-intelligence-draft-summary'];
// How many emails one press of "Draft with AI" works through.
const DRAFT_BATCH = 10;

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

// The reply assistant, in one strip above the queue: how many waiting emails
// already have a draft, a button to have the AI write the rest, and the two
// choices that are the mailbox owner's to make —
//   Auto-draft: the AI writes drafts for waiting mail without being asked;
//   Send when I approve: approving a reply sends it (one step), or only saves it.
// Nothing here ever sends an email: a draft is a draft until it is approved.
export function ReplyAssistBar({ onDrafted }: { onDrafted: () => void }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: DRAFT_SUMMARY_KEY,
    queryFn: () => emailIntelligenceService.getDraftSummary(),
    // While drafts are being written the numbers move: follow them closely.
    refetchInterval: (query) => (query.state.data?.running ? 3_000 : 60_000),
  });

  // When a run ends, say what it did and show the new drafts in the list.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (!data) return;
    if (wasRunning.current && !data.running) {
      const last = data.last;
      if (last?.error) toast.error(`Drafting stopped: ${last.error}`, { duration: 9_000 });
      if (last && last.drafted + last.noDraft > 0) {
        toast.success(
          [
            last.drafted ? `${plural(last.drafted, 'draft')} written` : '',
            last.noDraft ? `${plural(last.noDraft, 'email')} needed no drafted reply` : '',
          ]
            .filter(Boolean)
            .join(' · '),
          { duration: 7_000 },
        );
      }
      onDrafted();
    }
    wasRunning.current = data.running;
  }, [data, onDrafted]);

  if (!data) return null;

  const patch = (next: Partial<EmailDraftSummary>) =>
    queryClient.setQueryData<EmailDraftSummary>(DRAFT_SUMMARY_KEY, (old) => (old ? { ...old, ...next } : old));

  const change = async (setting: Partial<EmailInboxSettings>) => {
    const before = data.settings;
    patch({ settings: { ...before, ...setting } }); // the switch moves at once
    try {
      const settings = await emailIntelligenceService.updateInboxSettings(setting);
      patch({ settings });
      if (setting.autoDraft === true) {
        toast.success(
          data.recentWithoutDraft > 0
            ? `Auto-draft is on — the AI is starting on the emails from the last ${data.autoDraftWindowDays} days.`
            : 'Auto-draft is on — new emails that need a reply will arrive with a draft.',
          { duration: 7_000 },
        );
        void queryClient.invalidateQueries({ queryKey: DRAFT_SUMMARY_KEY });
      }
      if (setting.autoDraft === false) toast.success('Auto-draft is off — drafts are written only when you ask.');
      if (setting.sendOnApprove === true) toast.success('Approving a reply now sends it straight away.');
      if (setting.sendOnApprove === false)
        toast.success('Approving a reply now only saves it — you send it as a second step.');
    } catch (err) {
      patch({ settings: before });
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    }
  };

  const draftNow = async () => {
    try {
      await emailIntelligenceService.runDrafts(DRAFT_BATCH);
      patch({ running: true });
      void queryClient.invalidateQueries({ queryKey: DRAFT_SUMMARY_KEY });
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    }
  };

  const { waiting, withDraft, withoutDraft, settings, running, last } = data;
  const next = Math.min(DRAFT_BATCH, withoutDraft);
  const headline = running
    ? `Writing drafts… ${last ? last.drafted + last.noDraft : 0} done so far`
    : waiting === 0
      ? 'Nothing is waiting for a reply'
      : `${withDraft.toLocaleString()} of ${plural(waiting, 'waiting email')} ${withDraft === 1 ? 'has' : 'have'} a draft ready`;
  const detail = running
    ? 'You can keep working — new drafts appear in the list as they are written.'
    : withoutDraft > 0
      ? `${plural(withoutDraft, 'email')} ${withoutDraft === 1 ? 'has' : 'have'} not been read by the AI yet. Each draft uses AI credits, and nothing is sent until you approve it.`
      : waiting > 0
        ? 'Open an email, check the reply and approve it.'
        : 'New emails that need a reply will show up here.';

  return (
    <section className={styles.assistBar} aria-label="Reply assistant">
      <div className={styles.assistMain}>
        <span className={styles.assistIcon} aria-hidden>
          {running ? <Spinner size={16} /> : <FiCpu />}
        </span>
        <div className={styles.assistText} aria-live="polite">
          <strong>{headline}</strong>
          <span>{detail}</span>
        </div>
        {withoutDraft > 0 && !running && (
          <Button type="button" variant="secondary" size="sm" leftIcon={<FiCpu />} onClick={() => void draftNow()}>
            Draft {next === withoutDraft ? (next === 1 ? 'it' : `all ${next}`) : `next ${next}`} with AI
          </Button>
        )}
      </div>
      <div className={styles.assistSettings}>
        <label
          className={styles.assistSetting}
          title={`The AI writes a draft for every email waiting for a reply from the last ${data.autoDraftWindowDays} days — without being asked. Uses AI credits. Nothing is sent until you approve it.`}
        >
          <Switch
            checked={settings.autoDraft}
            ariaLabel="Auto-draft replies"
            onChange={(autoDraft) => void change({ autoDraft })}
          />
          <span>
            <strong>Auto-draft</strong>
            <span>AI writes replies for you to check</span>
          </span>
        </label>
        <label
          className={styles.assistSetting}
          title="On: “Approve & send” sends the reply in one step. Off: approving only saves it, and sending is a second step with a confirmation."
        >
          <Switch
            checked={settings.sendOnApprove}
            ariaLabel="Send when I approve"
            onChange={(sendOnApprove) => void change({ sendOnApprove })}
          />
          <span>
            <strong>Send when I approve</strong>
            <span>{settings.sendOnApprove ? 'One step: approve and it goes' : 'Two steps: approve, then send'}</span>
          </span>
        </label>
      </div>
    </section>
  );
}
