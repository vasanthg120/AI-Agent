import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import dayjs from 'dayjs';
import toast from 'react-hot-toast';
import { FiBell, FiCheckSquare, FiEdit3, FiMail, FiSend } from 'react-icons/fi';
import { Button } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { copyText } from '@/utils/clipboard';
import { dealInsightService, type DealActionType, type DealBrief, type DealOverview } from '@/services/dealInsightService';
import styles from './DealInsightDrawer.module.css';

const newKey = () => `deal-action:${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

interface Draft {
  type: DealActionType;
  key: string;
  title: string;
  dueDate: string;
  text: string;
  subject: string;
}

const ACTIONS: { type: DealActionType; label: string; icon: typeof FiMail; hint: string }[] = [
  { type: 'create_task', label: 'Create follow-up task', icon: FiCheckSquare, hint: 'A task for the deal’s owner, with a due date.' },
  { type: 'draft_email', label: 'Draft email', icon: FiMail, hint: 'Opens in your own email app — you send it.' },
  { type: 'add_note', label: 'Add note', icon: FiEdit3, hint: 'Saved on the deal in HaiVE (your CRM itself isn’t changed).' },
  { type: 'notify_owner', label: 'Notify owner', icon: FiBell, hint: 'A notification to the deal’s owner in HaiVE.' },
];

/** What a proposed action starts from: the AI's next step, plan and message when there is a brief. */
function prefill(type: DealActionType, data: DealOverview, brief: DealBrief | null, title?: string): Draft {
  const next = brief?.nextBestAction;
  const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');
  return {
    type,
    key: newKey(),
    title: title ?? next?.action ?? brief?.nextAction ?? '',
    dueDate: next?.urgency === 'now' || next?.urgency === 'today' ? dayjs().format('YYYY-MM-DD') : tomorrow,
    text:
      type === 'draft_email'
        ? (brief?.suggestedMessage ?? '')
        : type === 'add_note'
          ? [brief?.summary, next ? `Next: ${next.action} (${next.deadline})` : brief?.nextAction ? `Next: ${brief.nextAction}` : ''].filter(Boolean).join('\n')
          : type === 'notify_owner'
            ? [next ? `${next.action} — ${next.why}` : brief?.nextAction, brief?.risks?.[0] ? `Risk: ${brief.risks[0]}` : ''].filter(Boolean).join('\n')
            : '',
    subject: `${data.deal.name}`,
  };
}

// The agent's actions on a deal, each run only when a person approves it here:
// the AI proposes (from its brief), the person edits and confirms. Nothing goes
// to the customer from HaiVE — an email is opened in the person's own mail app.
// Every approved action is recorded (with who and when) and a repeated click
// runs it once.
export function DealAgentActions({ data, brief, preset, onPresetUsed }: { data: DealOverview; brief: DealBrief | null; preset?: { type: DealActionType; title?: string } | null; onPresetUsed?: () => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const dealId = data.deal.id;

  // A recommendation's "Do this" arrives as a preset: it opens that action, filled in.
  useEffect(() => {
    if (!preset) return;
    setDraft(prefill(preset.type, data, brief, preset.title));
    onPresetUsed?.();
    // Only when a new preset arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  const run = useMutation({
    mutationFn: (d: Draft) =>
      dealInsightService.runAction(dealId, {
        type: d.type,
        idempotencyKey: d.key,
        ...(d.type === 'create_task' ? { title: d.title, dueDate: d.dueDate || undefined } : {}),
        ...(d.type === 'draft_email' ? { subject: d.subject, text: d.text } : {}),
        ...(d.type === 'add_note' || d.type === 'notify_owner' ? { text: d.text } : {}),
      }),
    onSuccess: (action) => {
      if (action.status === 'duplicate') toast(action.summary);
      else if (action.status === 'failed') toast.error(action.error ?? 'That didn’t work.');
      else toast.success(action.summary);
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: ['deal-insight', dealId] });
      void queryClient.invalidateQueries({ queryKey: ['team-activity'] });
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  });

  const sendFromMyEmail = async (d: Draft) => {
    const to = data.customer.email ?? '';
    const href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.text)}`;
    // Recorded as drafted (who, when); the person sends it from their own email.
    run.mutate(d);
    if (href.length < 1900) window.location.href = href;
    else if (await copyText(d.text)) toast('The message is long — it’s copied; paste it into your email.');
  };

  return (
    <div className={styles.actions}>
      <div className={styles.actionButtons}>
        {ACTIONS.map((a) => {
          const Icon = a.icon;
          const blocked = a.type === 'notify_owner' && !data.deal.ownerName;
          return (
            <button
              key={a.type}
              type="button"
              className={clsx(styles.actionButton, draft?.type === a.type && styles.actionButtonActive)}
              onClick={() => setDraft(draft?.type === a.type ? null : prefill(a.type, data, brief))}
              disabled={blocked}
              title={blocked ? 'This deal has no owner in HaiVE — assign it first.' : a.hint}
            >
              <Icon aria-hidden /> {a.label}
            </button>
          );
        })}
      </div>

      <AnimatePresence initial={false}>
        {draft && (
          <motion.div
            key={draft.type}
            className={styles.composer}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className={styles.composerInner}>
              <span className={styles.composerHint}>{ACTIONS.find((a) => a.type === draft.type)?.hint} Check it, then approve.</span>
              {draft.type === 'create_task' && (
                <div className={styles.composerRow}>
                  <input className={styles.field} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="What needs doing" aria-label="Task" maxLength={200} />
                  <input className={styles.field} type="date" value={draft.dueDate} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })} aria-label="Due date" />
                </div>
              )}
              {draft.type === 'draft_email' && (
                <>
                  <input className={styles.field} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} placeholder="Subject" aria-label="Subject" maxLength={200} />
                  <span className={styles.composerHint}>To: {data.customer.email ?? 'no email address recorded for this customer'}</span>
                </>
              )}
              {draft.type !== 'create_task' && (
                <textarea
                  className={clsx(styles.field, styles.textarea)}
                  value={draft.text}
                  onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                  rows={draft.type === 'draft_email' ? 7 : 4}
                  aria-label={draft.type === 'draft_email' ? 'Message' : 'Text'}
                  maxLength={5000}
                />
              )}
              <div className={styles.composerFoot}>
                <button type="button" className={styles.linkButton} onClick={() => setDraft(null)}>
                  Cancel
                </button>
                {draft.type === 'draft_email' ? (
                  <Button type="button" size="sm" leftIcon={<FiSend />} loading={run.isPending} disabled={!draft.text.trim()} onClick={() => void sendFromMyEmail(draft)}>
                    Open in my email
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    loading={run.isPending}
                    disabled={draft.type === 'create_task' ? !draft.title.trim() : !draft.text.trim()}
                    onClick={() => run.mutate(draft)}
                  >
                    Approve
                  </Button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
