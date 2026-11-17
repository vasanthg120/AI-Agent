import type { IconType } from 'react-icons';
import { FiAlertCircle, FiArchive, FiCheckCircle, FiClock, FiSlash, FiUserPlus } from 'react-icons/fi';
import type { InboxBox } from '@/services/emailIntelligenceService';

export type BoxTone = 'accent' | 'warning' | 'info' | 'success' | 'neutral' | 'muted';

// What each box of the AI Email Inbox is called and says about itself. Every
// email is in exactly one (the backend decides — email-inbox-boxes.ts), named by
// what it needs from you rather than by the AI's type labels.
export const BOX_META: Record<InboxBox, { label: string; hint: string; icon: IconType; tone: BoxTone; empty: string }> = {
  new_enquiries: {
    label: 'New enquiries',
    hint: 'People asking to buy or for a quote',
    icon: FiUserPlus,
    tone: 'accent',
    empty: 'No new enquiries are waiting for an answer.',
  },
  to_reply: {
    label: 'Need to reply',
    hint: 'Customers and suppliers waiting for you',
    icon: FiAlertCircle,
    tone: 'warning',
    empty: 'Nobody else is waiting for a reply from you.',
  },
  awaiting_customer: {
    label: 'Waiting for reply',
    hint: 'You answered — now their turn',
    icon: FiClock,
    tone: 'info',
    empty: 'No replies of yours are waiting on a customer’s answer.',
  },
  replied: {
    label: 'Replied',
    hint: 'Answered — here or in Outlook',
    icon: FiCheckCircle,
    tone: 'success',
    empty: 'Nothing answered yet. Once you reply — here or in Outlook — the email moves here.',
  },
  no_reply: {
    label: 'No reply needed',
    hint: 'For your information, or closed by you',
    icon: FiArchive,
    tone: 'neutral',
    empty: 'Nothing here. Business mail that needs no answer, and emails you closed, appear here.',
  },
  junk: {
    label: 'Junk & automated',
    hint: 'Receipts, notifications, newsletters',
    icon: FiSlash,
    tone: 'muted',
    empty: 'No junk or automated mail.',
  },
};

/** The boxes where something is waiting on you — sorted most urgent first, and highlighted when not empty. */
export const ACTION_BOXES: InboxBox[] = ['new_enquiries', 'to_reply'];
