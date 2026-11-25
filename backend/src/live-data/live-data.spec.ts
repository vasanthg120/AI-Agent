import { of, throwError } from 'rxjs';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { LiveDataService } from './live-data.service';

// Live source data: a page open asks python to read what is stale (per business, never
// blocking the page), and status() says where each source stands — live or nightly, being
// read, failed — and drops the in-memory copies once a newer read has landed.
const NOW = Date.now();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000);
const HOOPS_WINDOW = { utcOffsetMinutes: 600, start: '19:00', end: '23:59', label: 'AEST' };

describe('LiveDataService', () => {
  let rows: Record<string, unknown>[];
  let mailboxConnected: boolean;
  const http = { post: jest.fn() };
  const jwt = { sign: jest.fn((payload: { organizationId: string }) => `token-${payload.organizationId}`) };
  const scopes = { resolve: jest.fn() };
  const dataSources = { forget: jest.fn() };
  const directory = { invalidate: jest.fn() };
  const mailSync = {
    fetchLive: jest.fn(async () => ({ connected: true, newItemsCount: 0, answeredCount: 0, checked: true })),
    syncState: jest.fn(async () => ({ lastSyncedAt: minutesAgo(1), running: false, awaitingAnalysis: 2, aiReading: true, health: { status: 'ok' } })),
  };
  const connection = {
    collection: (name: string) => ({
      find: (query: { organizationId: { $in: string[] } }) => ({
        sort: () => ({
          toArray: async () => (name === 'crm_data_sources' ? rows.filter((r) => query.organizationId.$in.includes(r.organizationId as string) && r.status === 'active') : []),
        }),
      }),
      findOne: async () => (name === 'outlook_connections' && mailboxConnected ? { _id: 'c1' } : null),
    }),
  };
  const config = { get: () => 'http://agent' };

  const caller = { sub: 'u1', organizationId: 'main', roles: ['owner'] } as JwtPayload;
  const make = () =>
    new LiveDataService(connection as never, http as never, jwt as never, scopes as never, dataSources as never, directory as never, mailSync as never, config as never);

  const source = (id: string, organizationId: string, provider: string, sync: Record<string, unknown>, status = 'active') => ({
    _id: { toString: () => id },
    organizationId,
    provider,
    label: provider,
    status,
    sync,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    http.post.mockReturnValue(of({ data: { sources: [] } }));
    mailboxConnected = true;
    scopes.resolve.mockResolvedValue({
      businesses: [
        { id: 'main', name: 'Main' },
        { id: 'sub', name: 'T.Nagar' },
      ],
      acrossBusinesses: true,
    });
    rows = [
      source('gd', 'main', 'gorilladash', { lastStatus: 'ok', lastSyncAt: minutesAgo(5) }),
      source('pc', 'main', 'prospectconnect', { lastStatus: 'running', runningSince: minutesAgo(1), lastSyncAt: minutesAgo(30) }),
      source('hp', 'main', 'hoops', { lastStatus: 'ok', lastSyncAt: minutesAgo(600), window: HOOPS_WINDOW }),
      source('native', 'main', 'haive_native', { lastStatus: 'never' }),
      source('old', 'main', 'hubspot', { lastStatus: 'ok' }, 'disconnected'),
      source('sub-gd', 'sub', 'gorilladash', { lastStatus: 'error', lastError: 'Gorilla Dash refused the key.', lastSyncAt: minutesAgo(2) }),
    ];
  });

  it('a page open asks python to read this business only, with a short-lived system token, and says where each source stands', async () => {
    const status = await make().refresh(caller);
    expect(http.post).toHaveBeenCalledTimes(1);
    const [url, , options] = http.post.mock.calls[0];
    expect(url).toBe('http://agent/sync/crm/refresh-live');
    expect(options.headers.Authorization).toBe('Bearer token-main');
    expect(jwt.sign).toHaveBeenCalledWith({ sub: 'system', organizationId: 'main' }, { expiresIn: '2m' });

    // The built-in workspace and a disconnected CRM are not sources to read.
    expect(status.sources.map((s) => s.id)).toEqual(['gd', 'pc', 'hp']);
    const by = Object.fromEntries(status.sources.map((s) => [s.id, s]));
    expect(by.gd).toMatchObject({ mode: 'live', refreshing: false, businessName: 'Main' });
    expect(by.pc).toMatchObject({ mode: 'live', refreshing: true });
    expect(by.hp).toMatchObject({ mode: 'nightly', refreshing: false });
    expect(new Date(by.hp.nextNightlyAt!).getTime()).toBeGreaterThan(NOW);
    expect(status.mailbox).toBeUndefined();
    expect(mailSync.fetchLive).not.toHaveBeenCalled();
  });

  it('the Main Account owner’s all-businesses view reads every business; anyone else only their own', async () => {
    const status = await make().refresh(caller, { scope: 'all' });
    expect(http.post.mock.calls.map((c) => c[2].headers.Authorization).sort()).toEqual(['Bearer token-main', 'Bearer token-sub']);
    expect(status.sources.find((s) => s.id === 'sub-gd')).toMatchObject({ businessName: 'T.Nagar', error: 'Gorilla Dash refused the key.' });

    http.post.mockClear();
    scopes.resolve.mockResolvedValue({ businesses: [{ id: 'main', name: 'Main' }], acrossBusinesses: false });
    await make().refresh(caller, { scope: 'all' });
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('python being down never fails the page: it shows the last read and its time', async () => {
    http.post.mockReturnValue(throwError(() => new Error('connect ECONNREFUSED')));
    const status = await make().refresh(caller);
    expect(status.sources).toHaveLength(3);
    expect(status.sources[0].lastSyncAt).toBe(minutesAgo(5).toISOString());
  });

  it('a read stuck as running for over 15 minutes is not shown as being read', async () => {
    rows[1].sync = { lastStatus: 'running', runningSince: minutesAgo(40) };
    const status = await make().status(caller);
    expect(status.sources.find((s) => s.id === 'pc')!.refreshing).toBe(false);
  });

  it('with the mailbox: starts a live fetch (in the background) and says whether the AI is reading', async () => {
    const status = await make().refresh(caller, { email: true });
    expect(mailSync.fetchLive).toHaveBeenCalledWith('u1');
    expect(status.mailbox).toMatchObject({ connected: true, awaitingAi: 2, aiReading: true, fetching: false });
    mailboxConnected = false;
    expect((await make().status(caller, { email: true })).mailbox!.connected).toBe(false);

    // The inbox asks for its mailbox only.
    http.post.mockClear();
    await make().refresh(caller, { email: true, crm: false });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('drops the Customers page and source-list copies once a newer read has landed, not before', async () => {
    const live = make();
    await live.status(caller);
    expect(directory.invalidate).toHaveBeenCalledTimes(1); // the first look since start
    directory.invalidate.mockClear();
    dataSources.forget.mockClear();

    await live.status(caller);
    expect(directory.invalidate).not.toHaveBeenCalled();

    rows[0].sync = { lastStatus: 'ok', lastSyncAt: new Date(NOW + 1_000) };
    await live.status(caller);
    expect(directory.invalidate).toHaveBeenCalledWith('main');
    expect(dataSources.forget).toHaveBeenCalledWith('main');
  });
});
