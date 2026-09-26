import type { BadgeVariant } from '@/components/ui';
import type { EmailIntelligenceItem, EmailResponseStatus, EmailRespondedVia } from '@/services/emailIntelligenceService';

// How an email's state is worded — one place, so the queue row, the detail
// banner and the conversation timeline can never describe the same email
// differently. The state itself (`responseStatus`) is decided by the backend;
// this only chooses words for it, using the same fields the backend used.
type StateFields = Pick<EmailIntelligenceItem, 'responseStatus' | 'status' | 'aiStatus' | 'sendError' | 'respondedVia'>;

export const RESPONDED_VIA_LABEL: Record<EmailRespondedVia, string> = {
  app: 'Replied',
  outlook: 'Replied in Outlook',
  thread: 'Answered by a later reply',
};

export const RESPONSE_VIEW_LABEL: Record<EmailResponseStatus, string> = {
  needs_response: 'Needs Response',
  responded: 'Responded',
  resolved: 'Resolved',
};

export function responseBadge(item: StateFields): { label: string; variant: BadgeVariant } {
  if (item.responseStatus === 'responded') {
    return { label: item.respondedVia ? RESPONDED_VIA_LABEL[item.respondedVia] : 'Replied', variant: 'success' };
  }
  if (item.responseStatus === 'needs_response') {
    // Approved is NOT answered: the draft still has to go out, and if sending
    // failed the email is still waiting — never shown as handled.
    if (item.status === 'approved') {
      return item.sendError
        ? { label: 'Send failed', variant: 'danger' }
        : { label: 'Approved · ready to send', variant: 'info' };
    }
    if (item.aiStatus === 'validation_failed') return { label: 'Needs review', variant: 'danger' };
    if (item.aiStatus === 'draft_ready') return { label: 'Draft ready', variant: 'warning' };
    return { label: 'Needs reply', variant: 'warning' };
  }
  if (item.status === 'rejected') return { label: 'Rejected', variant: 'neutral' };
  if (item.aiStatus === 'awaiting_customer_response') return { label: 'Awaiting customer', variant: 'info' };
  if (item.status === 'approved') return { label: 'Approved · no reply needed', variant: 'neutral' };
  return { label: 'No reply needed', variant: 'neutral' };
}

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
