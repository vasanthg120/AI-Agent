import type { IconType } from 'react-icons';
import {
  FiBarChart2,
  FiBookOpen,
  FiCheckSquare,
  FiCpu,
  FiCreditCard,
  FiDollarSign,
  FiInbox,
  FiPhoneCall,
  FiShield,
  FiZap,
} from 'react-icons/fi';
import { ROUTES } from '@/constants/routes';

// The help centre's content: short, task-shaped answers ("how do I…"), each
// pointing at the page where it's done. Kept as data so search, the category
// cards and the answer list all read from one place — adding an answer is one
// entry here, nothing else.

export interface HelpArticle {
  id: string;
  question: string;
  answer: string;
  // Where it's done — shown as a "Take me there" button.
  link?: { label: string; path: string };
  // Owners/admins only (the answer describes a settings page others can't open).
  adminOnly?: boolean;
  // Extra words people search with that aren't in the text.
  keywords?: string;
}

export interface HelpCategory {
  id: string;
  title: string;
  blurb: string;
  icon: IconType;
  articles: HelpArticle[];
}

export const HELP_CATEGORIES: HelpCategory[] = [
  {
    id: 'start',
    title: 'Getting started',
    blurb: 'Find your way around in five minutes.',
    icon: FiZap,
    articles: [
      {
        id: 'start-tour',
        question: 'What can HaiVE do for me?',
        answer:
          'HaiVE brings your deals, customers, emails, calls and documents into one place and puts an AI assistant on top. Start on the Dashboard for today’s picture, ask HaiVE AI anything in plain language, and use Call Copilot and the AI Email Inbox to handle conversations faster.',
        link: { label: 'Open the Dashboard', path: ROUTES.dashboard },
      },
      {
        id: 'start-search',
        question: 'How do I jump to any page quickly?',
        answer:
          'Press Ctrl + / (⌘ + / on Mac) anywhere to open the command palette, type a few letters of the page you want and press Enter.',
        keywords: 'shortcut command palette navigate find',
      },
      {
        id: 'start-profile',
        question: 'How do I update my name, phone or time zone?',
        answer:
          'Open your Profile from the account menu at the bottom of the sidebar. Changes save when you press Save (or Ctrl + S).',
        link: { label: 'Open Profile', path: ROUTES.profile },
        keywords: 'account timezone language name',
      },
      {
        id: 'start-notifications',
        question: 'Where do my notifications go?',
        answer:
          'The bell in the top bar shows what needs your attention. Choose which alerts you get — in the app or on your desktop — in Settings → Notifications.',
        link: { label: 'Notification settings', path: ROUTES.settingsNotifications },
      },
    ],
  },
  {
    id: 'ai',
    title: 'HaiVE AI & agents',
    blurb: 'Chat, history and custom AI agents.',
    icon: FiCpu,
    articles: [
      {
        id: 'ai-ask',
        question: 'How do I ask HaiVE AI a question?',
        answer:
          'Click the HaiVE AI button in the top bar to open the assistant in the corner of any page, or open AI Chat for a full-screen conversation. Ask in plain language — it can look up deals, quotes, customers and your uploaded documents.',
        link: { label: 'Open AI Chat', path: ROUTES.chat },
        keywords: 'assistant chat question',
      },
      {
        id: 'ai-history',
        question: 'Can I find an old conversation?',
        answer: 'Every conversation is saved. Open History to search, reopen, rename, pin or archive them.',
        link: { label: 'Open History', path: ROUTES.chatHistory },
      },
      {
        id: 'ai-agents',
        question: 'How do I create my own AI agent?',
        answer:
          'Go to Settings → AI Agents and choose Create agent. Pick a template or start blank, describe its job, choose the tools it can use, and activate it. Owners and admins can assign agents to people.',
        link: { label: 'AI Agents', path: ROUTES.settingsAgentRoles },
        adminOnly: true,
        keywords: 'agent builder role persona',
      },
      {
        id: 'ai-knowledge',
        question: 'How does the AI know about our company?',
        answer:
          'It reads what you add to Business Knowledge — your company profile and uploaded documents such as policies, price lists and product sheets. Keep them current and the answers stay current.',
        link: { label: 'Business Knowledge', path: ROUTES.businessKnowledge },
        keywords: 'documents upload rag policies',
      },
    ],
  },
  {
    id: 'calls',
    title: 'Call Copilot & calling',
    blurb: 'Live coaching, phone calls and summaries.',
    icon: FiPhoneCall,
    articles: [
      {
        id: 'calls-record',
        question: 'How do I get live coaching during a call?',
        answer:
          'Open Call Copilot, choose Record here, pick the customer and language and press Start. HaiVE listens through your microphone, transcribes as you talk and suggests your next move. End the call for a summary and an AI Coach report.',
        link: { label: 'Open Call Copilot', path: ROUTES.callCopilot },
        keywords: 'microphone live coach transcript',
      },
      {
        id: 'calls-phone',
        question: 'How do I call a customer from HaiVE?',
        answer:
          'In Call Copilot choose Call a customer, pick the country, type the number and press Call. HaiVE rings your own phone first; answer it and you are connected to the customer. The call is recorded and its summary appears in Call Library.',
        link: { label: 'Open Call Copilot', path: ROUTES.callCopilot },
        keywords: 'phone dial plivo twilio international',
      },
      {
        id: 'calls-international',
        question: 'Can I call customers in other countries?',
        answer:
          'Yes. Indian numbers go out through Plivo and every other country through Twilio, chosen automatically — the call card shows the route before you call. An administrator connects the providers in Settings → Calling.',
        link: { label: 'Calling settings', path: ROUTES.settingsCalling },
        keywords: 'twilio plivo abroad country usa uk uae',
      },
      {
        id: 'calls-upload',
        question: 'I already have a recording — can HaiVE analyse it?',
        answer:
          'Yes. In Call Copilot choose Upload a recording and drop the audio file. You get a transcript, summary and AI Coach report in a minute or two.',
        link: { label: 'Open Call Copilot', path: ROUTES.callCopilot },
        keywords: 'audio file mp3',
      },
      {
        id: 'calls-voice',
        question: 'How do I change the AI Coach’s voice or accent?',
        answer:
          'Settings → Voice & Accent lets you pick the voice that reads coaching aloud — Indian, Australian, American or British English, male or female. Admins set the default for everyone.',
        link: { label: 'Voice & Accent', path: ROUTES.settingsVoice },
      },
    ],
  },
  {
    id: 'email',
    title: 'AI Email Inbox',
    blurb: 'Replies, SLAs and follow-ups.',
    icon: FiInbox,
    articles: [
      {
        id: 'email-queues',
        question: 'What do the inbox queues mean?',
        answer:
          '“Needs a reply” holds customer emails nobody has answered yet. Once anyone replies — from HaiVE, from Outlook, or later in the same thread — the email leaves that queue on its own.',
        link: { label: 'Open AI Email Inbox', path: ROUTES.emailIntelligence },
        keywords: 'pending missed responded',
      },
      {
        id: 'email-draft',
        question: 'How do AI reply drafts work?',
        answer:
          'Open an email to see the draft HaiVE wrote. Edit it if you like, then approve and send — nothing is sent without you.',
        link: { label: 'Open AI Email Inbox', path: ROUTES.emailIntelligence },
      },
      {
        id: 'email-sla',
        question: 'How are response-time targets (SLAs) set?',
        answer:
          'Owners and admins set how quickly each kind of email should be answered, business hours and escalation rules in Settings → Email SLA.',
        link: { label: 'Email SLA', path: ROUTES.settingsEmailSla },
        adminOnly: true,
      },
    ],
  },
  {
    id: 'insights',
    title: 'Dashboard & reports',
    blurb: 'Pipeline, team performance and exports.',
    icon: FiBarChart2,
    articles: [
      {
        id: 'insights-dashboard',
        question: 'How do I read the Dashboard?',
        answer:
          'Overview shows today’s picture and the AI briefing. The other tabs go deeper: Pipeline & Quotes, Team Performance, Customers & Email and Vendor Profitability. Click any figure to see the records behind it.',
        link: { label: 'Open the Dashboard', path: ROUTES.dashboard },
        keywords: 'kpi pipeline briefing',
      },
      {
        id: 'insights-reports',
        question: 'How do I build and export a report?',
        answer:
          'Open Reporting, choose a report type, a date range and how to group it. Sort or search the table, then download it as CSV.',
        link: { label: 'Open Reporting', path: ROUTES.reporting },
        keywords: 'csv export download',
      },
      {
        id: 'insights-deals',
        question: 'Why don’t my deals show on my dashboard?',
        answer:
          'Personal figures count deals assigned to you. An owner or admin assigns deals to people in Settings → Deal Assignment.',
        link: { label: 'Deal Assignment', path: ROUTES.settingsDealAssignment },
        keywords: 'owner assign missing',
      },
    ],
  },
  {
    id: 'finance',
    title: 'Finance AI',
    blurb: 'Invoices, spending and reviews.',
    icon: FiDollarSign,
    articles: [
      {
        id: 'finance-docs',
        question: 'How does Finance AI handle invoices and quotes?',
        answer:
          'Documents are read automatically and sorted by type. Anything that needs a human check is marked “awaiting review”. Spending breaks down by vendor and category — click a bar to see the documents.',
        link: { label: 'Open Finance AI', path: ROUTES.finance },
        keywords: 'invoice vendor spend',
      },
    ],
  },
  {
    id: 'work',
    title: 'To-Do & EOD',
    blurb: 'Your day, planned and wrapped up.',
    icon: FiCheckSquare,
    articles: [
      {
        id: 'work-todo',
        question: 'How do I plan my day?',
        answer: 'Open To-Do. Add tasks, drag them between columns and use the day picker to look ahead or back.',
        link: { label: 'Open To-Do', path: ROUTES.todoEod },
        keywords: 'tasks board kanban',
      },
      {
        id: 'work-eod',
        question: 'What is the EOD report?',
        answer:
          'Your end-of-day summary: tasks done and pending, emails handled and CRM activity, with an AI summary you can share.',
        link: { label: 'Open EOD Report', path: ROUTES.eod },
        keywords: 'end of day summary',
      },
    ],
  },
  {
    id: 'billing',
    title: 'Billing & credits',
    blurb: 'Plans, credits and invoices.',
    icon: FiCreditCard,
    articles: [
      {
        id: 'billing-credits',
        question: 'What are HaiVE credits?',
        answer:
          'AI work — chat answers, call analysis, email drafts — uses credits from your workspace balance. Billing shows the balance, what used it, and lets owners top up or turn on auto-recharge.',
        link: { label: 'Open Billing', path: ROUTES.billing },
        keywords: 'balance wallet usage',
      },
      {
        id: 'billing-out',
        question: 'What happens when credits run out?',
        answer:
          'AI features pause until credits are added — your data stays safe. Recordings that could not be processed can be retried after topping up.',
        link: { label: 'Add credits', path: ROUTES.addCredits },
        keywords: 'insufficient empty zero',
      },
    ],
  },
  {
    id: 'security',
    title: 'Account & security',
    blurb: 'Passwords, 2FA, sessions and people.',
    icon: FiShield,
    articles: [
      {
        id: 'security-2fa',
        question: 'How do I turn on two-factor authentication?',
        answer:
          'Settings → Security → Two-Factor Authentication. Scan the code with an authenticator app and keep the backup codes safe.',
        link: { label: 'Security settings', path: ROUTES.settingsSecurity },
        keywords: '2fa otp authenticator',
      },
      {
        id: 'security-sessions',
        question: 'I think someone else is signed in to my account.',
        answer: 'Open Settings → Security → Active Sessions, sign out every other session, then change your password.',
        link: { label: 'Security settings', path: ROUTES.settingsSecurity },
        keywords: 'hacked logout password',
      },
      {
        id: 'security-users',
        question: 'How do I add a teammate?',
        answer:
          'Owners and admins add people in Settings → Users. They get a temporary password to share with the new person directly.',
        link: { label: 'Users', path: ROUTES.settingsUsers },
        adminOnly: true,
        keywords: 'invite employee member',
      },
    ],
  },
  {
    id: 'knowledge',
    title: 'Business Knowledge',
    blurb: 'What the AI knows about you.',
    icon: FiBookOpen,
    articles: [
      {
        id: 'knowledge-upload',
        question: 'Which files can I upload?',
        answer:
          'PDFs, Word documents, spreadsheets and text files. Drag them onto Business Knowledge; each one is read and becomes something HaiVE AI can quote from.',
        link: { label: 'Business Knowledge', path: ROUTES.businessKnowledge },
        keywords: 'pdf docx upload rag',
      },
    ],
  },
];

export interface ArticleHit {
  article: HelpArticle;
  category: HelpCategory;
  score: number;
}

/** Word-based search across questions, answers and keywords — every word must
 * appear somewhere; hits in the question rank highest. */
export function searchArticles(query: string, categories: HelpCategory[]): ArticleHit[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length > 1);
  if (words.length === 0) return [];
  const hits: ArticleHit[] = [];
  for (const category of categories) {
    for (const article of category.articles) {
      const question = article.question.toLowerCase();
      const body = `${article.answer} ${article.keywords ?? ''} ${category.title}`.toLowerCase();
      let score = 0;
      let all = true;
      for (const word of words) {
        if (question.includes(word)) score += 3;
        else if (body.includes(word)) score += 1;
        else all = false;
      }
      if (all) hits.push({ article, category, score });
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}
