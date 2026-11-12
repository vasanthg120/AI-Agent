import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import toast from 'react-hot-toast';
import {
  FiAlertTriangle,
  FiArrowDownLeft,
  FiArrowUpRight,
  FiCheckCircle,
  FiCheckSquare,
  FiCircle,
  FiShield,
  FiClock,
  FiCopy,
  FiCpu,
  FiFileText,
  FiInfo,
  FiMail,
  FiMessageSquare,
  FiPhone,
  FiRefreshCw,
  FiTarget,
  FiUser,
  FiUserCheck,
  FiZap,
} from 'react-icons/fi';
import { Button, Drawer, EmptyState, Skeleton, Tabs } from '@/components/ui';
import { formatAmountIn } from '@/utils/currency';
import { extractErrorMessage } from '@/utils/errors';
import { copyText } from '@/utils/clipboard';
import { dealInsightService, type DealActionType, type DealBrief, type DealHealth, type DealOverview, type LeadStatus } from '@/services/dealInsightService';
import { DealAgentActions } from './DealAgentActions';
import { useDealDrawerStore } from '@/stores/dealDrawerStore';
import { CallSessionViewer } from '@/features/call-copilot/components/CallSessionViewer';
import styles from './DealInsightDrawer.module.css';

dayjs.extend(relativeTime);

type TabId = 'activity' | 'emails' | 'calls' | 'notes' | 'tasks' | 'details';

const HEALTH: Record<DealBrief['health'], { label: string; tone: string }> = {
  on_track: { label: 'On track', tone: 'success' },
  needs_attention: { label: 'Needs attention', tone: 'warning' },
  at_risk: { label: 'At risk', tone: 'danger' },
  won: { label: 'Won', tone: 'success' },
  lost: { label: 'Lost', tone: 'neutral' },
};

const LIKELIHOOD: Record<DealBrief['winLikelihood'], string> = {
  high: 'High chance to win',
  medium: 'Medium chance to win',
  low: 'Low chance to win',
  closed: 'Closed',
};

const WAITING: Record<DealBrief['waitingOn'], string> = {
  us: 'Waiting on us',
  customer: 'Waiting on the customer',
  nobody: 'Nothing pending',
  unknown: 'Unclear whose move it is',
};

const LEAD_STATUS: Record<LeadStatus, string> = {
  new_lead: 'New lead',
  contacted: 'Contacted',
  interested: 'Interested',
  negotiation: 'Negotiation',
  quote_sent: 'Quote sent',
  awaiting_response: 'Awaiting response',
  follow_up_required: 'Follow-up required',
  payment_pending: 'Payment pending',
  won: 'Won',
  lost: 'Lost',
};

const URGENCY: Record<string, string> = { now: 'Now', today: 'Today', this_week: 'This week', later: 'Later' };

const HEALTH_BAND: Record<DealHealth['band'], { label: string; tone: string }> = {
  healthy: { label: 'Healthy', tone: 'success' },
  watch: { label: 'Watch', tone: 'warning' },
  at_risk: { label: 'At risk', tone: 'danger' },
  closed: { label: 'Closed', tone: 'neutral' },
};

const OWNER_LABEL: Record<DealBrief['plan'][number]['owner'], string> = {
  salesperson: 'Salesperson',
  manager: 'Manager',
  customer: 'Customer',
};

const STATUS_TONE: Record<DealOverview['deal']['status'], string> = { open: 'info', won: 'success', lost: 'neutral' };
const HISTORY_LABEL: Record<string, string> = {
  created: 'created',
  won: 'won',
  lost: 'lost',
  reopened: 'reopened',
  sent: 'sent',
  accepted: 'accepted',
  rejected: 'rejected',
};

const when = (iso?: string) => (iso ? dayjs(iso).format('D MMM YYYY, h:mm a') : '');
const ago = (iso?: string) => (iso ? dayjs(iso).fromNow() : '');
const minutes = (seconds?: number) => (seconds ? (seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds}s`) : undefined);

interface TimelineEntry {
  id: string;
  at: string;
  icon: ReactNode;
  tone: 'in' | 'out' | 'call' | 'note' | 'quote' | 'change' | 'task';
  title: string;
  meta?: string;
  body?: string;
  flag?: string;
  action?: { label: string; onClick: () => void };
}

// The deal panel: opened from any list of deals (the Dashboard's Revenue,
// Pipeline and Won-deals lists, Agent Activity). It shows everything recorded
// about the deal straight away — no AI — and, when someone asks ("Analyse"),
// the AI's brief: where the lead stands, whose move it is, the risks, a plan
// and a message ready to send. The brief is billed, so it is never written on
// its own (decided 2026-11-12); once written it stays, marked when something
// new has arrived since.
export function DealInsightDrawer() {
  const dealId = useDealDrawerStore((s) => s.dealId);
  const close = useDealDrawerStore((s) => s.close);
  const [tab, setTab] = useState<TabId>('activity');
  const [openCall, setOpenCall] = useState<string | null>(null);
  const [preset, setPreset] = useState<{ type: DealActionType; title?: string } | null>(null);
  const queryClient = useQueryClient();

  const toggleTask = useMutation({
    mutationFn: ({ taskId, done }: { taskId: string; done: boolean }) => dealInsightService.setTaskDone(dealId!, taskId, done),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['deal-insight', dealId] });
      void queryClient.invalidateQueries({ queryKey: ['team-activity'] });
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['deal-insight', dealId],
    queryFn: () => dealInsightService.overview(dealId!),
    enabled: !!dealId,
  });

  const analyse = useMutation({
    mutationFn: () => dealInsightService.analyse(dealId!),
    onSuccess: (brief) => {
      queryClient.setQueryData<DealOverview>(['deal-insight', dealId], (prev) => (prev ? { ...prev, brief } : prev));
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  });

  const timeline = useMemo(() => (data ? buildTimeline(data, setOpenCall) : []), [data]);

  const onClose = () => {
    close();
    setTab('activity');
  };

  const deal = data?.deal;
  const tabs = data
    ? [
        { id: 'activity', label: `Activity (${timeline.length})` },
        { id: 'emails', label: `Emails (${data.emails.length})` },
        { id: 'calls', label: `Calls (${data.calls.length})` },
        { id: 'notes', label: `Notes & quotes (${data.notes.length + data.quotes.length})` },
        { id: 'tasks', label: `Tasks & actions (${data.tasks.filter((t) => t.status === 'open').length})` },
        { id: 'details', label: 'Details' },
      ]
    : [];

  return (
    <>
      <Drawer
        open={!!dealId}
        onClose={onClose}
        width={720}
        title={deal?.name ?? 'Deal'}
        description={deal ? [data?.customer.company ?? data?.customer.name, deal.businessName].filter(Boolean).join(' · ') : undefined}
        scrollKey={tab}
        header={
          isLoading ? (
            <div className={styles.loading}>
              <Skeleton height={64} />
              <Skeleton height={140} />
            </div>
          ) : isError || !data ? (
            <EmptyState compact icon={FiAlertTriangle} title="This deal couldn’t be opened" description={extractErrorMessage(error)} />
          ) : (
            <div className={styles.head}>
              <DealFacts data={data} />
              <HealthCard health={data.health} />
              <BriefCard
                brief={data.brief}
                busy={analyse.isPending}
                onAnalyse={() => analyse.mutate()}
                onDo={(type, title) => {
                  setPreset({ type, title });
                  setTab('tasks');
                }}
              />
              <section className={styles.agentBox} aria-label="Agent actions">
                <span className={styles.agentTitle}>
                  <FiShield aria-hidden /> Agent actions — nothing happens until you approve it
                </span>
                <DealAgentActions data={data} brief={data.brief} preset={preset} onPresetUsed={() => setPreset(null)} />
              </section>
            </div>
          )
        }
        tabs={data ? <Tabs items={tabs} activeId={tab} onChange={(id) => setTab(id as TabId)} /> : undefined}
      >
        {data && (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
              {tab === 'activity' && <Timeline entries={timeline} empty="Nothing has been recorded for this deal yet." />}
              {tab === 'emails' && <Timeline entries={timeline.filter((e) => e.tone === 'in' || e.tone === 'out')} empty="No emails with this customer were found." />}
              {tab === 'calls' && <Timeline entries={timeline.filter((e) => e.tone === 'call')} empty="No calls with this customer were found." />}
              {tab === 'notes' && <Timeline entries={timeline.filter((e) => e.tone === 'note' || e.tone === 'quote')} empty="No CRM notes or quotations yet." />}
              {tab === 'tasks' && <TasksAndActions data={data} onToggle={(taskId, done) => toggleTask.mutate({ taskId, done })} busy={toggleTask.isPending} />}
              {tab === 'details' && <Details data={data} />}
            </motion.div>
          </AnimatePresence>
        )}
      </Drawer>
      <CallSessionViewer sessionId={openCall} onClose={() => setOpenCall(null)} />
    </>
  );
}

function DealFacts({ data }: { data: DealOverview }) {
  const { deal, stats } = data;
  const silent = stats.daysSinceLastContact !== undefined && stats.daysSinceLastContact >= 7 && deal.status === 'open';
  return (
    <div className={styles.facts}>
      <div className={styles.factsTop}>
        <span className={clsx(styles.statusChip, styles[`tone_${STATUS_TONE[deal.status]}`])}>{deal.status === 'open' ? 'Open' : deal.status === 'won' ? 'Won' : 'Lost'}</span>
        {deal.stage && <span className={styles.stage}>{deal.stage.replace(/_/g, ' ').toLowerCase()}</span>}
        <strong className={styles.value}>{formatAmountIn(deal.value, deal.currency)}</strong>
      </div>
      <div className={styles.factGrid}>
        <Fact icon={<FiUser />} label="Owner" value={deal.ownerName ?? (deal.crmOwner ? `${deal.crmOwner} (CRM)` : 'Nobody yet')} />
        <Fact
          icon={<FiTarget />}
          label={deal.status === 'open' ? 'Expected to close' : 'Closed'}
          value={deal.status === 'open' ? (deal.expectedClosingDate ? dayjs(deal.expectedClosingDate).format('D MMM YYYY') : 'Not set') : deal.closedAt ? dayjs(deal.closedAt).format('D MMM YYYY') : (deal.expectedClosingDate ?? '—')}
        />
        <Fact
          icon={<FiClock />}
          label="Last contact"
          value={stats.lastContactAt ? ago(stats.lastContactAt) : 'None recorded'}
          tone={silent ? 'warning' : undefined}
        />
        <Fact
          icon={<FiMail />}
          label="Emails"
          value={`${stats.emailsIn} in · ${stats.emailsOut} out`}
          note={stats.waitingForReply > 0 ? `${stats.waitingForReply} waiting for a reply` : undefined}
          tone={stats.waitingForReply > 0 ? 'warning' : undefined}
        />
      </div>
    </div>
  );
}

function Fact({ icon, label, value, note, tone }: { icon: ReactNode; label: string; value: string; note?: string; tone?: 'warning' }) {
  return (
    <div className={clsx(styles.fact, tone && styles.factWarning)}>
      <span className={styles.factIcon} aria-hidden>
        {icon}
      </span>
      <span className={styles.factText}>
        <span className={styles.factLabel}>{label}</span>
        <span className={styles.factValue}>{value}</span>
        {note && <span className={styles.factNote}>{note}</span>}
      </span>
    </div>
  );
}

function BriefCard({ brief, busy, onAnalyse, onDo }: { brief: DealBrief | null; busy: boolean; onAnalyse: () => void; onDo: (type: DealActionType, title?: string) => void }) {
  if (busy) {
    return (
      <div className={clsx(styles.brief, styles.briefBusy)} role="status" aria-live="polite">
        <span className={styles.briefOrb} aria-hidden>
          <FiCpu />
        </span>
        <div>
          <strong>Reading the emails, CRM notes, quotes and calls…</strong>
          <span className={styles.muted}>This takes about half a minute.</span>
        </div>
      </div>
    );
  }
  if (!brief) {
    return (
      <div className={clsx(styles.brief, styles.briefEmpty)}>
        <span className={styles.briefOrb} aria-hidden>
          <FiZap />
        </span>
        <div className={styles.briefEmptyText}>
          <strong>Where does this lead stand?</strong>
          <span className={styles.muted}>
            The AI reads everything below — emails, CRM notes, quotations and calls — and tells you whose move it is, the risks, and the next step,
            with a message ready to send. Uses AI credits.
          </span>
        </div>
        <Button type="button" leftIcon={<FiZap />} onClick={onAnalyse}>
          Analyse
        </Button>
      </div>
    );
  }

  const health = HEALTH[brief.health];
  return (
    <motion.section className={styles.brief} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
      <div className={styles.briefTop}>
        <div className={styles.briefTitle}>
          <span className={styles.aiTag}>
            <FiCpu aria-hidden /> AI brief
          </span>
          <h3>{brief.statusLabel}</h3>
        </div>
        <div className={styles.briefChips}>
          <span className={clsx(styles.chip, styles[`tone_${health.tone}`])}>{health.label}</span>
          {brief.leadStatus && (
            <span className={clsx(styles.chip, styles.tone_info)} title={brief.leadStatusReason}>
              {LEAD_STATUS[brief.leadStatus]}
            </span>
          )}
          <span className={styles.chip}>{LIKELIHOOD[brief.winLikelihood]}</span>
          <span className={clsx(styles.chip, brief.waitingOn === 'us' && styles.tone_warning)}>{WAITING[brief.waitingOn]}</span>
        </div>
      </div>

      {brief.stale && (
        <div className={styles.stale}>
          <FiInfo aria-hidden /> Something new has come in since this was written.
          <button type="button" onClick={onAnalyse}>
            Analyse again
          </button>
        </div>
      )}

      <p className={styles.summary}>{brief.summary}</p>
      {brief.lastContact && (
        <p className={styles.lastContact}>
          <FiClock aria-hidden /> {brief.lastContact}
        </p>
      )}

      {brief.nextBestAction ? (
        <div className={styles.nextAction}>
          <span className={styles.nextLabel}>
            Next best action · {URGENCY[brief.nextBestAction.urgency] ?? brief.nextBestAction.urgency} · {brief.nextBestAction.deadline}
          </span>
          <strong>{brief.nextBestAction.action}</strong>
          <span className={styles.why}>{brief.nextBestAction.why}</span>
          <span className={styles.doRow}>
            <button type="button" className={styles.linkButton} onClick={() => onDo('create_task', brief.nextBestAction!.action)}>
              <FiCheckSquare aria-hidden /> Make it a task
            </button>
            {brief.suggestedMessage && (
              <button type="button" className={styles.linkButton} onClick={() => onDo('draft_email')}>
                <FiMessageSquare aria-hidden /> Draft the email
              </button>
            )}
          </span>
        </div>
      ) : (
        brief.nextAction && (
          <div className={styles.nextAction}>
            <span className={styles.nextLabel}>Next step</span>
            <strong>{brief.nextAction}</strong>
          </div>
        )
      )}

      {(brief.observedFacts?.length || brief.inferences?.length) && (
        <div className={styles.briefColumns}>
          {brief.observedFacts && brief.observedFacts.length > 0 && <BriefList icon={<FiFileText />} title="What the records show" items={brief.observedFacts} />}
          {brief.inferences && brief.inferences.length > 0 && <BriefList icon={<FiCpu />} title="What the AI concludes" items={brief.inferences} />}
        </div>
      )}

      {(brief.emailSummary || brief.crmOverview) && (
        <div className={styles.briefColumns}>
          {brief.emailSummary && (
            <div className={styles.briefList}>
              <span className={styles.briefListTitle}>
                <FiMail /> Email conversation
              </span>
              <p className={styles.briefText}>{brief.emailSummary}</p>
            </div>
          )}
          {brief.crmOverview && (
            <div className={styles.briefList}>
              <span className={styles.briefListTitle}>
                <FiTarget /> CRM
              </span>
              <p className={styles.briefText}>{brief.crmOverview}</p>
            </div>
          )}
        </div>
      )}

      {brief.emailInsights && (
        <div className={styles.briefColumns}>
          {brief.emailInsights.questions.length > 0 && <BriefList icon={<FiInfo />} title="Customer questions" items={brief.emailInsights.questions} />}
          {brief.emailInsights.commitments.length > 0 && <BriefList icon={<FiCheckCircle />} title="Commitments" items={brief.emailInsights.commitments} />}
          {brief.emailInsights.pricing.length > 0 && <BriefList icon={<FiTarget />} title="Pricing" items={brief.emailInsights.pricing} />}
          {brief.emailInsights.objections.length > 0 && <BriefList icon={<FiAlertTriangle />} title="Objections" items={brief.emailInsights.objections} tone="danger" />}
          {brief.emailInsights.competitors.length > 0 && <BriefList icon={<FiAlertTriangle />} title="Competitors mentioned" items={brief.emailInsights.competitors} tone="danger" />}
        </div>
      )}

      {brief.recommendations && brief.recommendations.length > 0 && (
        <ol className={styles.plan}>
          {brief.recommendations.map((r, i) => (
            <li key={i}>
              <span className={styles.planIndex}>{i + 1}</span>
              <span className={styles.planStep}>
                {r.action} <span className={clsx(styles.chip, r.urgency === 'now' || r.urgency === 'today' ? styles.tone_warning : undefined)}>{URGENCY[r.urgency] ?? r.urgency}</span>
              </span>
              <span className={styles.planMeta}>
                {r.why}{' '}
                <button type="button" className={styles.linkButton} onClick={() => onDo('create_task', r.action)}>
                  Make it a task
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}

      {!brief.recommendations?.length && brief.plan.length > 0 && (
        <ol className={styles.plan}>
          {brief.plan.map((p, i) => (
            <li key={i}>
              <span className={styles.planIndex}>{i + 1}</span>
              <span className={styles.planStep}>{p.step}</span>
              <span className={styles.planMeta}>
                {OWNER_LABEL[p.owner]} · {p.when}
              </span>
            </li>
          ))}
        </ol>
      )}

      <div className={styles.briefColumns}>
        {brief.customerNeeds.length > 0 && <BriefList icon={<FiCheckCircle />} title="What the customer wants" items={brief.customerNeeds} />}
        {brief.risks.length > 0 && <BriefList icon={<FiAlertTriangle />} title="Risks" items={brief.risks} tone="danger" />}
        {brief.missingInfo.length > 0 && <BriefList icon={<FiInfo />} title="Not recorded" items={brief.missingInfo} />}
      </div>

      {brief.suggestedMessage && (
        <div className={styles.message}>
          <div className={styles.messageHead}>
            <span>
              <FiMessageSquare aria-hidden /> Suggested message
            </span>
            <button
              type="button"
              onClick={async () => {
                if (await copyText(brief.suggestedMessage)) toast.success('Message copied');
                else toast.error('Couldn’t copy — select the text instead.');
              }}
            >
              <FiCopy aria-hidden /> Copy
            </button>
          </div>
          <p>{brief.suggestedMessage}</p>
        </div>
      )}

      <div className={styles.briefFoot}>
        <span className={styles.muted}>
          {brief.winLikelihoodReason} · Written {ago(brief.generatedAt)}
        </span>
        {!brief.stale && (
          <button type="button" className={styles.linkButton} onClick={onAnalyse}>
            <FiRefreshCw aria-hidden /> Analyse again
          </button>
        )}
      </div>
    </motion.section>
  );
}

function HealthCard({ health }: { health: DealHealth }) {
  const [open, setOpen] = useState(false);
  if (health.score === null) return null;
  const band = HEALTH_BAND[health.band];
  return (
    <section className={styles.health} aria-label="Deal health">
      <button type="button" className={styles.healthTop} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={clsx(styles.healthScore, styles[`tone_${band.tone}`])}>{health.score}</span>
        <span className={styles.healthText}>
          <strong>
            Deal health · {band.label}
          </strong>
          <span className={styles.muted}>
            From the records, not the AI — how well the deal is being worked. {health.risks[0] ?? 'Nothing pressing.'}
          </span>
        </span>
        <span className={styles.linkButton}>{open ? 'Hide' : 'Why?'}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className={styles.healthBody}>
            <ul className={styles.factors}>
              {health.factors.map((f) => (
                <li key={f.key}>
                  <span className={styles.factorHead}>
                    <span>{f.label}</span>
                    <span className={styles.factorPoints}>
                      {f.points}/{f.max}
                    </span>
                  </span>
                  <span className={styles.factorTrack}>
                    <span className={styles.factorFill} style={{ width: `${(f.points / f.max) * 100}%` }} />
                  </span>
                  <span className={styles.muted}>{f.detail}</span>
                </li>
              ))}
            </ul>
            {health.improvements.length > 0 && <BriefList icon={<FiZap />} title="To improve it" items={health.improvements} />}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function TasksAndActions({ data, onToggle, busy }: { data: DealOverview; onToggle: (taskId: string, done: boolean) => void; busy: boolean }) {
  return (
    <div className={styles.tasksTab}>
      <h4 className={styles.subhead}>Tasks</h4>
      {data.tasks.length === 0 ? (
        <p className={styles.muted}>No tasks on this deal yet. Use “Create follow-up task” above.</p>
      ) : (
        <ul className={styles.taskList}>
          {data.tasks.map((t) => (
            <li key={t.id} className={clsx(styles.task, t.status === 'done' && styles.taskDone)}>
              <button type="button" className={styles.taskCheck} onClick={() => onToggle(t.id, t.status !== 'done')} disabled={busy} aria-label={t.status === 'done' ? `Reopen ${t.title}` : `Mark ${t.title} done`}>
                {t.status === 'done' ? <FiCheckSquare /> : <FiCircle />}
              </button>
              <span className={styles.taskText}>
                <span className={styles.entryTitle}>{t.title}</span>
                <span className={styles.entryMeta}>
                  {[t.assignee, t.dueDate ? `due ${dayjs(t.dueDate).format('D MMM YYYY')}` : 'no due date', t.byAi ? 'from the AI' : undefined].filter(Boolean).join(' · ')}
                </span>
              </span>
              {t.overdue && <span className={styles.entryFlag}>Overdue</span>}
            </li>
          ))}
        </ul>
      )}
      <h4 className={styles.subhead}>What the agent has done here</h4>
      {data.actions.length === 0 ? (
        <p className={styles.muted}>Nothing yet. Every action approved in this panel is listed here, with who approved it.</p>
      ) : (
        <ul className={styles.taskList}>
          {data.actions.map((a) => (
            <li key={a.id} className={styles.task}>
              <span className={clsx(styles.statusChip, a.status === 'failed' ? styles.tone_danger : a.status === 'duplicate' ? styles.tone_neutral : styles.tone_success)}>
                {a.status === 'done' ? 'Done' : a.status === 'duplicate' ? 'Already done' : 'Failed'}
              </span>
              <span className={styles.taskText}>
                <span className={styles.entryTitle}>{a.summary}</span>
                <span className={styles.entryMeta}>{[a.by ? `approved by ${a.by}` : undefined, when(a.at), a.error].filter(Boolean).join(' · ')}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BriefList({ icon, title, items, tone }: { icon: ReactNode; title: string; items: string[]; tone?: 'danger' }) {
  return (
    <div className={clsx(styles.briefList, tone === 'danger' && styles.briefListDanger)}>
      <span className={styles.briefListTitle}>
        {icon} {title}
      </span>
      <ul>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function buildTimeline(data: DealOverview, openCall: (sessionId: string) => void): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const e of data.emails) {
    entries.push({
      id: `email-${e.id}`,
      at: e.at,
      icon: e.direction === 'in' ? <FiArrowDownLeft /> : <FiArrowUpRight />,
      tone: e.direction,
      title: e.subject,
      meta: e.direction === 'in' ? `From ${e.from ?? 'the customer'}${e.mailboxOwner ? ` · to ${e.mailboxOwner}` : ''}` : `Sent${e.mailboxOwner ? ` by ${e.mailboxOwner}` : ''} to ${e.to ?? 'the customer'}`,
      body: e.summary ?? e.preview,
      flag: e.waitingForReply ? 'Waiting for a reply' : undefined,
    });
  }
  for (const c of data.calls) {
    const parts = [c.personName, c.kind === 'phone' ? (c.connected ? 'Phone call' : 'Not answered') : c.kind === 'live' ? 'Recorded call' : 'Uploaded recording', minutes(c.durationSeconds)];
    entries.push({
      id: `call-${c.id}`,
      at: c.at,
      icon: <FiPhone />,
      tone: 'call',
      title: c.headline ?? (c.connected ? 'Call' : 'Call not answered'),
      meta: [...parts, c.score ? `Coach score ${c.score}/10` : undefined].filter(Boolean).join(' · '),
      body: [...c.summaryPoints, ...c.followUps.map((f) => `To do: ${f}`)].join('\n') || undefined,
      action: c.sessionId ? { label: 'Open call', onClick: () => openCall(c.sessionId!) } : undefined,
    });
  }
  for (const n of data.notes) {
    entries.push({ id: `note-${n.id}`, at: n.at ?? '', icon: <FiFileText />, tone: 'note', title: 'CRM note', meta: n.by, body: n.body });
  }
  for (const q of data.quotes) {
    entries.push({
      id: `quote-${q.id}`,
      at: q.createdAt ?? '',
      icon: <FiTarget />,
      tone: 'quote',
      title: `Quotation ${q.number ?? q.name ?? ''} · ${formatAmountIn(q.amount, q.currency)}`,
      meta: [q.status, q.approval && q.approval !== 'pending' ? q.approval : undefined, q.owner].filter(Boolean).join(' · '),
    });
  }
  for (const h of data.history) {
    if (h.entity !== 'deal') continue;
    entries.push({
      id: `change-${h.at}-${h.kind}`,
      at: h.at,
      icon: <FiRefreshCw />,
      tone: 'change',
      title: `Deal ${HISTORY_LABEL[h.kind] ?? h.kind}${h.from && h.to ? ` (${h.from} → ${h.to})` : ''}`,
      meta: [h.by, h.byAi ? 'by the AI' : undefined].filter(Boolean).join(' · ') || undefined,
    });
  }
  for (const a of data.assignments) {
    entries.push({
      id: `owner-${a.at}`,
      at: a.at,
      icon: <FiUserCheck />,
      tone: 'change',
      title: a.to ? `Assigned to ${a.to}${a.from ? ` (was ${a.from})` : ''}` : `Owner removed${a.from ? ` (was ${a.from})` : ''}`,
      meta: [a.by ? `by ${a.by}` : undefined].filter(Boolean).join(' · ') || undefined,
      body: a.reason,
    });
  }
  for (const t of data.tasks) {
    entries.push({
      id: `task-${t.id}`,
      at: t.status === 'done' ? (t.completedAt ?? t.createdAt ?? '') : (t.createdAt ?? ''),
      icon: <FiCheckSquare />,
      tone: 'task',
      title: `${t.status === 'done' ? 'Task done' : 'Task'}: ${t.title}`,
      meta: [t.assignee, t.dueDate ? `due ${dayjs(t.dueDate).format('D MMM')}` : undefined, t.byAi ? 'from the AI' : undefined].filter(Boolean).join(' · ') || undefined,
      flag: t.overdue ? 'Overdue' : undefined,
    });
  }
  return entries.filter((e) => e.at).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

function Timeline({ entries, empty }: { entries: TimelineEntry[]; empty: string }) {
  if (entries.length === 0) return <EmptyState compact icon={FiClock} title={empty} />;
  return (
    <ol className={styles.timeline}>
      {entries.map((e, i) => (
        <motion.li
          key={e.id}
          className={styles.entry}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, delay: Math.min(i, 10) * 0.02 }}
        >
          <span className={clsx(styles.entryIcon, styles[`entry_${e.tone}`])} aria-hidden>
            {e.icon}
          </span>
          <div className={styles.entryMain}>
            <div className={styles.entryHead}>
              <span className={styles.entryTitle}>{e.title}</span>
              <time className={styles.entryTime} dateTime={e.at} title={when(e.at)}>
                {ago(e.at)}
              </time>
            </div>
            {e.meta && <span className={styles.entryMeta}>{e.meta}</span>}
            {e.flag && <span className={styles.entryFlag}>{e.flag}</span>}
            {e.body && <p className={styles.entryBody}>{e.body}</p>}
            {e.action && (
              <button type="button" className={styles.linkButton} onClick={e.action.onClick}>
                {e.action.label}
              </button>
            )}
          </div>
        </motion.li>
      ))}
    </ol>
  );
}

function Details({ data }: { data: DealOverview }) {
  const { deal, customer } = data;
  const rows: [string, string | undefined][] = [
    ['Customer', customer.company],
    ['Contact', customer.name],
    ['Email', customer.email],
    ['Phone', customer.phone],
    ['Value', formatAmountIn(deal.value, deal.currency)],
    ['Status', deal.status],
    ['Stage', deal.stage?.replace(/_/g, ' ').toLowerCase()],
    ['Expected to close', deal.expectedClosingDate],
    ['Created', deal.createdAt ? when(deal.createdAt) : undefined],
    ['Owner in HaiVE', deal.ownerName],
    ['Salesperson in the CRM', deal.crmOwner],
    ['Lead source', deal.leadSource],
    ['Product', deal.product],
    ['Lost because', deal.lostReason],
    ['From', deal.provider],
    ['Business', deal.businessName],
  ];
  return (
    <dl className={styles.details}>
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label} className={styles.detailRow}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}
