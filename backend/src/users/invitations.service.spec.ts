import { describeSmtpFailure, MailDelivery } from '../mail/mail.service';
import { InvitationsService } from './invitations.service';

// An invitation used to say "sent" whatever happened to the email (it was sent
// in the background and never checked). Now whoever invites is told whether the
// mail server took it — and, if not, why — and still gets the link to pass on.
describe('Invitations: whether the email actually went', () => {
  const user = { _id: { toString: () => 'u1' }, email: 'priya@example.com', name: 'Priya Raman', organizationId: 'org-1' } as never;

  function service(delivery: MailDelivery) {
    const users = { setInvitation: jest.fn(async () => undefined), organizationName: jest.fn(async () => 'Fully Promoted T.Nagar') };
    const mail = {
      sendInvitationEmail: jest.fn(async () => delivery),
      invitationLink: (token: string) => `https://app.example/activate?token=${token}`,
    };
    return { invitations: new InvitationsService(users as never, mail as never), users, mail };
  }

  it('says so when the mail server accepted the invitation', async () => {
    const { invitations, mail } = service({ sent: true });
    const result = await invitations.invite(user);
    expect(result).toMatchObject({ emailSent: true, activationLink: expect.stringContaining('/activate?token=') });
    expect(result.emailProblem).toBeUndefined();
    expect(mail.sendInvitationEmail).toHaveBeenCalledWith('priya@example.com', 'Priya Raman', 'Fully Promoted T.Nagar', expect.any(String));
  });

  it('says why when it was not sent — and still hands over the link to pass on by hand', async () => {
    const { invitations, users } = service({ sent: false, problem: 'Email isn’t set up on this server (no SMTP_HOST), so nothing was sent.' });
    const result = await invitations.invite(user);
    expect(result).toMatchObject({ emailSent: false, emailProblem: expect.stringContaining('isn’t set up'), activationLink: expect.any(String) });
    expect(users.setInvitation).toHaveBeenCalled(); // the link works either way
  });
});

describe('describeSmtpFailure: why the mail server refused, for an administrator', () => {
  it('a rejected sign-in points at the account settings', () => {
    expect(describeSmtpFailure({ code: 'EAUTH', responseCode: 535, response: '535-5.7.8 Username and Password not accepted' }, 'a@b.c')).toMatch(/refused HaiVE’s sign-in/);
  });

  it('an unreachable server says to try again', () => {
    expect(describeSmtpFailure({ code: 'ETIMEDOUT', message: 'Connection timeout' }, 'a@b.c')).toMatch(/couldn’t reach the mail server/);
  });

  it('a refused address names it', () => {
    expect(describeSmtpFailure({ code: 'EENVELOPE', responseCode: 553, response: '553 5.1.3 invalid address' }, 'not-an-address')).toMatch(/wouldn’t send to not-an-address/);
  });

  it('anything else quotes the server briefly', () => {
    expect(describeSmtpFailure({ responseCode: 421, response: '421 4.7.0 Try again later' }, 'a@b.c')).toBe('The mail server didn’t accept the email (421 4.7.0 Try again later).');
  });
});
