import { axiosClient } from '@/api/axiosClient';

// Haive's voice assistant: the spoken business briefing (backend/src/assistant).

export interface BriefingPoint {
  text: string;
  // actual = a recorded figure; estimate; forecast = a projection; recommendation = advice.
  kind: 'actual' | 'estimate' | 'forecast' | 'recommendation';
  severity: 'critical' | 'warning' | 'good' | 'info';
  business: string;
}

/** Something Haive offers to do — done only on the person's yes. */
export interface BriefingAction {
  id: string;
  type: 'give_task';
  label: string;
  title: string;
  personName: string;
  due: 'today' | 'tomorrow';
  status: 'suggested' | 'running' | 'done' | 'dismissed';
  // "Task given to Abishake — due today." once done.
  result?: string;
  // Why it didn't work last time.
  error?: string;
}

export interface Briefing {
  spoken: string;
  headline: string;
  points: BriefingPoint[];
  nextAction: { text: string; why: string } | null;
  suggestedQuestions: string[];
  actions: BriefingAction[];
}

export interface BriefingView {
  id: string;
  date: string;
  slot: string;
  // When Haive reached out with it: the schedule's name ("Morning briefing") or "Alert · T.Nagar". Null: today's sign-in briefing.
  label: string | null;
  briefing: Briefing;
  // The chat conversation it opens: follow-up questions continue it.
  conversationId: string;
  generatedAt: string;
  // Spoken on its own now (by the greeting setting; one opened from a notification, until heard).
  shouldSpeak: boolean;
  spokenAt?: string;
}

// ---- AI Conversations settings (backend/src/assistant/conversation-settings.ts) ----

export const METRICS = ['revenue', 'pipeline', 'quotations', 'emails', 'calls', 'tasks', 'team', 'syncHealth'] as const;
export type Metric = (typeof METRICS)[number];
export type Greeting = 'first_of_day' | 'every_login' | 'tap';
export type SpeakingStyle = 'concise' | 'detailed';

export interface ConversationSchedule {
  // Absent on one just added (the server gives it one).
  id?: string;
  label: string;
  // HH:mm in the person's time zone.
  time: string;
  // 1 = Monday … 7 = Sunday.
  days: number[];
  enabled: boolean;
}

export interface AiConversationSettings {
  voiceEnabled: boolean;
  greeting: Greeting;
  language: string;
  style: SpeakingStyle;
  briefingEnabled: boolean;
  // Null = the business's own.
  timeZone: string | null;
  schedules: ConversationSchedule[];
  questions: { text: string; enabled: boolean }[];
  metrics: Record<Metric, boolean>;
  alerts: boolean;
  notify: { bell: boolean; phone: boolean };
  quietHours: { enabled: boolean; start: string; end: string };
  maxPerDay: number;
}

export interface ConversationSettingsView {
  settings: AiConversationSettings;
  // Their own settings, the company default, or Haive's own defaults.
  source: 'mine' | 'organization' | 'default';
  organization: AiConversationSettings | null;
  organizationUpdatedAt: string | null;
  canSetOrganization: boolean;
  defaults: AiConversationSettings;
}

export const assistantService = {
  /** Today's briefing — or, with a slot from a notification, the one Haive reached out with (written when opened). */
  async getBriefing(refresh = false, slot?: string): Promise<BriefingView> {
    const params = { ...(refresh ? { refresh: 'true' } : {}), ...(slot ? { slot } : {}) };
    const { data } = await axiosClient.get<BriefingView>('/assistant/briefing', { params, timeout: 90_000 });
    return data;
  },

  /** "Do it" — the server does what it stored for this suggestion, and says so only when done. */
  async runAction(briefingId: string, actionId: string): Promise<BriefingAction> {
    const { data } = await axiosClient.post<BriefingAction>(`/assistant/briefing/${briefingId}/actions/${actionId}`);
    return data;
  },

  async dismissAction(briefingId: string, actionId: string): Promise<BriefingAction> {
    const { data } = await axiosClient.post<BriefingAction>(`/assistant/briefing/${briefingId}/actions/${actionId}/dismiss`);
    return data;
  },

  async markSpoken(id: string): Promise<void> {
    await axiosClient.post(`/assistant/briefing/${id}/spoken`);
  },

  async getSettings(): Promise<ConversationSettingsView> {
    const { data } = await axiosClient.get<ConversationSettingsView>('/assistant/settings');
    return data;
  },

  async saveMySettings(patch: Partial<AiConversationSettings>): Promise<ConversationSettingsView> {
    const { data } = await axiosClient.put<ConversationSettingsView>('/assistant/settings/me', patch);
    return data;
  },

  /** Back to the company default. */
  async resetMySettings(): Promise<ConversationSettingsView> {
    const { data } = await axiosClient.delete<ConversationSettingsView>('/assistant/settings/me');
    return data;
  },

  async saveOrganizationSettings(patch: Partial<AiConversationSettings>): Promise<ConversationSettingsView> {
    const { data } = await axiosClient.put<ConversationSettingsView>('/assistant/settings/organization', patch);
    return data;
  },
};
