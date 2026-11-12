import toast from 'react-hot-toast';
import { copyText } from './clipboard';

/** What the server says about an invitation email (users and sub-account owners alike). */
export interface InvitationOutcome {
  activationLink?: string;
  // false: the mail server didn't take it (emailProblem says why). Missing on older servers: treated as sent.
  emailSent?: boolean;
  emailProblem?: string;
}

/** Tells whoever invited whether the email actually went. If it didn't, says why
 * and puts the activation link on the clipboard to send by hand. */
export async function announceInvitation(outcome: InvitationOutcome, email: string): Promise<void> {
  if (outcome.emailSent !== false) {
    toast.success(`An invitation has gone to ${email}`);
    return;
  }
  const copied = outcome.activationLink ? await copyText(outcome.activationLink) : false;
  toast.error(
    `The invitation email to ${email} wasn’t sent. ${outcome.emailProblem ?? ''}${copied ? ' The activation link is copied — send it to them yourself.' : ''}`,
    { duration: 12_000 },
  );
}
