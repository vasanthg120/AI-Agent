import { CallCopilotGateway } from './call-copilot.gateway';

// The browser sends call:start the moment its socket connects — while the connection's own
// sign-in check (an async session lookup) may still be running. The call waits for it,
// instead of answering "Unauthorized" to a signed-in person.
describe('CallCopilotGateway — starting a call straight after connecting', () => {
  const payload = { sub: 'u1', organizationId: 'o1', roles: ['owner'], email: 'u@example.com' };

  function setup(sessionOk: boolean) {
    let finishLookup: (ok: boolean) => void = () => undefined;
    const usersService = {
      resolveSession: jest.fn(() => new Promise<boolean>((resolve) => (finishLookup = resolve))),
      // Stops the call right after the sign-in question, so the test needs nothing else.
      socketAccess: jest.fn(async () => ({ refusal: 'Call Copilot isn’t part of your role.' })),
    };
    const gateway = new CallCopilotGateway({} as never, { verify: () => payload } as never, usersService as never, {} as never);
    const emitted: [string, unknown][] = [];
    const client = {
      id: 's1',
      data: {},
      handshake: { auth: { token: 't' }, headers: {} },
      emit: (event: string, body: unknown) => emitted.push([event, body]),
      join: jest.fn(),
      disconnect: jest.fn(),
    };
    return { gateway, client, emitted, usersService, finish: () => finishLookup(sessionOk) };
  }

  it('call:start before the sign-in check finishes: it waits, then goes on as the signed-in person', async () => {
    const { gateway, client, emitted, usersService, finish } = setup(true);
    const connecting = gateway.handleConnection(client as never);
    const starting = gateway.onStart(client as never, {});
    finish();
    await Promise.all([connecting, starting]);
    expect(emitted.some(([, body]) => (body as { message?: string })?.message === 'Unauthorized')).toBe(false);
    expect(usersService.socketAccess).toHaveBeenCalledWith(payload, 'call_copilot', 'create', 'call_copilot');
  });

  it('“End call” while the last part is still being saved: the call ends only once it is in (no audio lost)', async () => {
    const order: string[] = [];
    let finishSaving: () => void = () => undefined;
    const session = { _id: 'sess1', transcript: [] as { text: string }[], userId: 'u1' };
    const calls = {
      appendAudioSegment: jest.fn(
        () =>
          new Promise<{ transcript: string; transcribeFailed: boolean }>((resolve) => {
            finishSaving = () => {
              order.push('last part saved');
              session.transcript.push({ text: 'see you then' });
              resolve({ transcript: 'see you then', transcribeFailed: false });
            };
          }),
      ),
      maybeAnalyze: jest.fn(async () => ({ skipped: true })),
      endSession: jest.fn(async () => {
        order.push(`ended with ${session.transcript.length} line(s)`);
        return session;
      }),
      generateCoaching: jest.fn(() => new Promise(() => undefined)),
    };
    const recordings = { prepare: jest.fn() };
    const gateway = new CallCopilotGateway(calls as never, {} as never, {} as never, recordings as never);
    const client = { id: 's1', data: { activeSession: session } as Record<string, unknown>, emit: jest.fn() };

    const lastPart = gateway.onAudioSegment(client as never, { sequence: 3, audio: Buffer.from('x'), mimeType: 'audio/webm', languageCode: 'en' });
    const ending = gateway.onEnd(client as never);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.endSession).not.toHaveBeenCalled();
    finishSaving();
    await Promise.all([lastPart, ending]);
    expect(order).toEqual(['last part saved', 'ended with 1 line(s)']);
    expect(recordings.prepare).toHaveBeenCalledWith(session);
  });

  it('audio recorded while the call is still being set up belongs to that call (nothing dropped at the start)', async () => {
    let created: (s: unknown) => void = () => undefined;
    const session = { _id: 'sess2', transcript: [] as unknown[] };
    const calls = {
      startSession: jest.fn(() => new Promise((resolve) => (created = resolve))),
      appendAudioSegment: jest.fn(async () => ({ transcript: 'hello', transcribeFailed: false })),
      maybeAnalyze: jest.fn(async () => ({ skipped: true })),
    };
    const usersService = { socketAccess: jest.fn(async () => ({ refusal: null })) };
    const gateway = new CallCopilotGateway(calls as never, {} as never, usersService as never, {} as never);
    const emitted: string[] = [];
    const client = { id: 's2', data: { user: payload } as Record<string, unknown>, emit: (event: string) => emitted.push(event) };
    const starting = gateway.onStart(client as never, {});
    const firstPart = gateway.onAudioSegment(client as never, { sequence: 0, audio: Buffer.from('x'), mimeType: 'audio/webm', languageCode: 'en' });
    await new Promise((r) => setTimeout(r, 20));
    created(session);
    await Promise.all([starting, firstPart]);
    expect(calls.appendAudioSegment).toHaveBeenCalledWith(session, 0, expect.any(Buffer), 'audio/webm', 'en');
    expect(emitted).not.toContain('call:error');
  });

  it('a session that isn’t valid is still refused', async () => {
    const { gateway, client, emitted, usersService, finish } = setup(false);
    const connecting = gateway.handleConnection(client as never);
    const starting = gateway.onStart(client as never, {});
    finish();
    await Promise.all([connecting, starting]);
    expect(emitted.filter(([, body]) => (body as { message?: string })?.message === 'Unauthorized').length).toBeGreaterThan(0);
    expect(usersService.socketAccess).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalled();
  });
});
