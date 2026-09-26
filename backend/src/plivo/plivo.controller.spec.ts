import { JwtPayload } from '../auth/jwt-payload.interface';
import { PlivoController } from './plivo.controller';

const user: JwtPayload = { sub: 'agent-1', email: 'a@example.com', roles: ['user'], organizationId: 'org-1' };
const admin: JwtPayload = { ...user, sub: 'admin-1', roles: ['owner', 'admin'] };

function callDoc(over: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'call-1' },
    direction: 'outbound',
    customerNumber: '919800000001',
    plivoNumber: '918012345678',
    status: 'completed',
    importStatus: 'failed',
    userId: 'agent-1',
    recordingUrl: 'https://media.plivo.com/secret-recording.mp3',
    createdAt: new Date('2026-09-25T10:00:00Z'),
    updatedAt: new Date(),
    ...over,
  };
}

function setup(call: ReturnType<typeof callDoc>, afterImport?: ReturnType<typeof callDoc>) {
  const plivo = { getCallForUser: jest.fn().mockResolvedValueOnce(call).mockResolvedValue(afterImport ?? call) };
  const webhooks = { importRecording: jest.fn(async () => undefined) };
  return { controller: new PlivoController(plivo as never, webhooks as never), plivo, webhooks };
}

describe('PlivoController.retryImport', () => {
  it('retries an import that failed, and returns the refreshed call', async () => {
    const failed = callDoc({ importStatus: 'failed' });
    const { controller, webhooks } = setup(failed, callDoc({ importStatus: 'imported', sessionId: 's-1' }));

    const view = await controller.retryImport(user, 'call-1');

    expect(webhooks.importRecording).toHaveBeenCalledWith(failed);
    expect(view).toMatchObject({ importStatus: 'imported', sessionId: 's-1' });
  });

  it('retries an import that was lost part-way (pending for a long time — e.g. the server restarted)', async () => {
    const lost = callDoc({ importStatus: 'pending', updatedAt: new Date(Date.now() - 20 * 60_000) });
    const { controller, webhooks } = setup(lost);
    await controller.retryImport(user, 'call-1');
    expect(webhooks.importRecording).toHaveBeenCalledWith(lost);
  });

  it.each([
    ['one still genuinely running', callDoc({ importStatus: 'pending', updatedAt: new Date(Date.now() - 2 * 60_000) })],
    ['one that already succeeded', callDoc({ importStatus: 'imported' })],
    ['a call with no recording', callDoc({ importStatus: 'none' })],
  ])('does not start a second import for %s', async (_name, call) => {
    const { controller, webhooks } = setup(call);
    await controller.retryImport(user, 'call-1');
    expect(webhooks.importRecording).not.toHaveBeenCalled();
  });

  it("lets an admin act on anyone's call in the organization, but a user only on their own", async () => {
    const { controller, plivo } = setup(callDoc());
    await controller.retryImport(admin, 'call-1');
    expect(plivo.getCallForUser).toHaveBeenCalledWith(admin, 'call-1', true);
    await controller.retryImport(user, 'call-1');
    expect(plivo.getCallForUser).toHaveBeenCalledWith(user, 'call-1', false);
  });

  it('never puts the recording URL in what it returns', async () => {
    const { controller } = setup(callDoc({ importStatus: 'imported' }));
    expect(JSON.stringify(await controller.retryImport(user, 'call-1'))).not.toContain('secret-recording');
  });
});
