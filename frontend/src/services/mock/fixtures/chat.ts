import dayjs from 'dayjs';
import type { Agent, ChatMessage, Conversation, PromptSuggestion, SlashCommand } from '@/types';

const now = dayjs();

export const mockAgents: Agent[] = [
  {
    id: 'agent_general',
    name: 'General Assistant',
    description: 'A capable, all-purpose assistant for everyday work.',
    avatarColor: '#ed7e2c',
    model: 'gpt-5.4',
    personality: 'Helpful, concise, professional.',
    instructions: 'Answer clearly and cite sources when referencing documents.',
    knowledgeSources: ['Company Handbook', 'Product Docs'],
    connectedTools: ['Web Search', 'Database'],
    status: 'active',
  },
  {
    id: 'agent_sales',
    name: 'Sales Copilot',
    description: 'Drafts outreach, summarizes CRM activity, preps call notes.',
    avatarColor: '#a85a1e',
    model: 'gpt-5.4-mini',
    personality: 'Persuasive, warm, data-driven.',
    instructions: 'Always ground claims in CRM data before making a recommendation.',
    knowledgeSources: ['CRM Records', 'Pricing Sheet'],
    connectedTools: ['CRM', 'Email', 'Calendar'],
    status: 'active',
  },
  {
    id: 'agent_support',
    name: 'Support Agent',
    description: 'Handles tier-1 support questions using the knowledge base.',
    avatarColor: '#60a5fa',
    model: 'gpt-5.4-mini',
    personality: 'Patient, empathetic, precise.',
    instructions: 'Search the knowledge base before answering; escalate if unresolved.',
    knowledgeSources: ['Help Center', 'Troubleshooting Guides'],
    connectedTools: ['Knowledge Search', 'Ticketing'],
    status: 'draft',
  },
];

export const mockSlashCommands: SlashCommand[] = [
  { id: 'cmd_summarize', command: '/summarize', label: 'Summarize', description: 'Summarize the referenced document or thread', icon: 'summarize' },
  { id: 'cmd_translate', command: '/translate', label: 'Translate', description: 'Translate the following text', icon: 'translate' },
  { id: 'cmd_explain', command: '/explain', label: 'Explain code', description: 'Explain a code snippet in plain language', icon: 'code' },
  { id: 'cmd_email', command: '/draft-email', label: 'Draft email', description: 'Draft a professional email', icon: 'mail' },
  { id: 'cmd_meeting', command: '/meeting-notes', label: 'Meeting notes', description: 'Turn a transcript into structured notes', icon: 'notes' },
];

export const mockPromptSuggestions: PromptSuggestion[] = [
  { id: 'sug_1', title: 'Follow up on a deal', prompt: 'Draft a follow-up email to a customer who has not responded in 2 weeks.', icon: 'mail' },
  { id: 'sug_2', title: 'Summarize my pipeline', prompt: 'Summarize my open deals — which ones need attention this week?', icon: 'bar-chart' },
  { id: 'sug_3', title: "Today's business summary", prompt: "Summarize today's CRM and email activity — what needs my attention?", icon: 'file-text' },
  { id: 'sug_4', title: 'Prep for a customer call', prompt: 'Pull together recent deals, quotes, and email history for my next customer call.', icon: 'users' },
];

export const mockConversations: Conversation[] = [
  {
    id: 'conv_1',
    title: 'Q3 roadmap summary',
    createdAt: now.subtract(2, 'hour').toISOString(),
    updatedAt: now.subtract(10, 'minute').toISOString(),
    pinned: true,
    favorite: true,
    archived: false,
    agentId: 'agent_general',
    messageCount: 6,
    preview: 'Here’s a concise summary of the Q3 roadmap doc you shared...',
  },
  {
    id: 'conv_2',
    title: 'Outreach email for Acme Corp',
    createdAt: now.subtract(5, 'hour').toISOString(),
    updatedAt: now.subtract(4, 'hour').toISOString(),
    pinned: false,
    favorite: true,
    archived: false,
    agentId: 'agent_sales',
    messageCount: 4,
    preview: 'Subject: Following up on our proposal...',
  },
  {
    id: 'conv_3',
    title: 'Support ticket trends',
    createdAt: now.subtract(1, 'day').toISOString(),
    updatedAt: now.subtract(1, 'day').toISOString(),
    pinned: false,
    favorite: false,
    archived: false,
    agentId: 'agent_general',
    messageCount: 8,
    preview: 'Ticket volume increased 12% week-over-week, mostly billing...',
  },
  {
    id: 'conv_4',
    title: 'Auth middleware review',
    createdAt: now.subtract(3, 'day').toISOString(),
    updatedAt: now.subtract(3, 'day').toISOString(),
    pinned: false,
    favorite: false,
    archived: false,
    agentId: 'agent_general',
    messageCount: 12,
    preview: 'The middleware validates JWTs against the shared secret...',
  },
  {
    id: 'conv_5',
    title: 'Onboarding checklist draft',
    createdAt: now.subtract(12, 'day').toISOString(),
    updatedAt: now.subtract(12, 'day').toISOString(),
    pinned: false,
    favorite: false,
    archived: true,
    agentId: 'agent_support',
    messageCount: 5,
    preview: 'Here’s a first draft of the customer onboarding checklist...',
  },
];

export const mockMessages: Record<string, ChatMessage[]> = {
  conv_1: [
    {
      id: 'msg_1',
      conversationId: 'conv_1',
      role: 'user',
      content: 'Summarize the key points from the Q3 product roadmap.',
      status: 'complete',
      createdAt: now.subtract(2, 'hour').toISOString(),
    },
    {
      id: 'msg_2',
      conversationId: 'conv_1',
      role: 'assistant',
      content:
        'Here’s a concise summary of the Q3 roadmap doc you shared:\n\n1. **Agent Orchestration** — multi-agent workflows ship in week 3, gated behind a feature flag.\n2. **Knowledge Base v2** — adds versioned documents and per-folder permissions.\n3. **Billing** — usage-based pricing tiers replace flat-rate plans.\n\n```ts\n// Example: reading the feature flag on the client\nconst enabled = useFeatureFlag(\'multi-agent-workflows\');\n```\n\nLet me know if you’d like this broken down by team or by week.',
      status: 'complete',
      createdAt: now.subtract(2, 'hour').add(8, 'second').toISOString(),
      toolsUsed: ['Knowledge Search'],
      feedback: 'up',
      model: 'gpt-5.4',
    },
    {
      id: 'msg_3',
      conversationId: 'conv_1',
      role: 'user',
      content: 'Break it down by team, please.',
      status: 'complete',
      createdAt: now.subtract(2, 'hour').add(2, 'minute').toISOString(),
    },
    {
      id: 'msg_4',
      conversationId: 'conv_1',
      role: 'assistant',
      content:
        '| Team | Deliverable | ETA |\n| --- | --- | --- |\n| Platform | Multi-agent orchestration | Week 3 |\n| Knowledge | Versioned documents + folder ACLs | Week 4 |\n| Billing | Usage-based tiers | Week 6 |\n| Growth | Onboarding revamp | Week 5 |\n\nWant me to turn this into a slide-ready outline?',
      status: 'complete',
      createdAt: now.subtract(2, 'hour').add(2, 'minute').add(6, 'second').toISOString(),
      model: 'gpt-5.4',
    },
  ],
  conv_2: [
    {
      id: 'msg_5',
      conversationId: 'conv_2',
      role: 'user',
      content: 'Draft a follow-up email to Acme Corp — they went quiet after our proposal 2 weeks ago.',
      status: 'complete',
      createdAt: now.subtract(5, 'hour').toISOString(),
    },
    {
      id: 'msg_6',
      conversationId: 'conv_2',
      role: 'assistant',
      content:
        'Subject: Following up on our proposal\n\nHi team,\n\nWanted to check in on the proposal we shared two weeks ago — happy to answer any questions or hop on a quick call if that’s easier.\n\nLooking forward to hearing your thoughts.\n\nBest,\nVasanth',
      status: 'complete',
      createdAt: now.subtract(5, 'hour').add(5, 'second').toISOString(),
      toolsUsed: ['CRM'],
      model: 'gpt-5.4-mini',
    },
  ],
};

export function getMessagesForConversation(conversationId: string): ChatMessage[] {
  return mockMessages[conversationId] ?? [];
}

const CANNED_REPLIES = [
  'Got it — let me work through that.\n\nBased on what you’ve shared, here are the key considerations:\n\n- **Context**: this builds on the existing conversation history.\n- **Approach**: I’d recommend starting small and validating before scaling.\n- **Next step**: let me know if you want a more detailed breakdown.\n\n```js\nfunction nextStep(context) {\n  return context.validated ? \'scale\' : \'iterate\';\n}\n```',
  'Here’s a quick summary:\n\n1. This is a simulated streaming response for the Phase 1 UI shell.\n2. Once the real backend is wired in, this text will come from the LangGraph agent instead.\n3. Everything else — markdown, code blocks, tables — renders exactly the same either way.\n\n| Field | Value |\n| --- | --- |\n| Provider | Mocked |\n| Status | Ready for backend swap |',
  'Sure, I can help with that. A few things worth noting:\n\n> Streaming, markdown, and code highlighting are all wired up client-side, so integrating the real API later is just a matter of swapping the data source.\n\nLet me know if you’d like me to go deeper on any part of this.',
];

export function pickCannedReply(seed: number): string {
  return CANNED_REPLIES[seed % CANNED_REPLIES.length];
}
