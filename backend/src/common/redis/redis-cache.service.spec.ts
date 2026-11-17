import { Logger } from '@nestjs/common';
import { RedisCacheService } from './redis-cache.service';

// Redis not running (local development): the cache must step aside at once —
// no request waiting on reconnects (each cached read used to take 0.5–1+ s) —
// and say so once, not every two seconds with an empty message.
describe('RedisCacheService without a Redis', () => {
  let service: RedisCacheService;
  let warn: jest.SpyInstance;

  beforeAll(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // A port nothing listens on.
    service = new RedisCacheService({ get: () => 'redis://:secret@127.0.0.1:6390/0' } as never);
  });

  afterAll(() => {
    service.onModuleDestroy();
    warn.mockRestore();
  });

  it('reads come back at once as a miss, writes are skipped quietly — nothing waits on a reconnect', async () => {
    await new Promise((r) => setTimeout(r, 600)); // let it fail to connect a few times
    // Not a stopwatch (a busy machine makes any time limit flaky): no command is even sent while
    // Redis is away, so none can sit in a queue waiting for it.
    const client = (service as unknown as { client: Record<string, (...args: unknown[]) => unknown> }).client;
    const sent = ['get', 'set', 'del'].map((name) => jest.spyOn(client, name));
    expect(await service.get('anything')).toBeNull();
    expect(await service.get('anything-else')).toBeNull();
    await expect(service.set('k', { a: 1 }, 60)).resolves.toBeUndefined();
    await expect(service.del('k')).resolves.toBeUndefined();
    for (const spy of sent) expect(spy).not.toHaveBeenCalled();
    sent.forEach((spy) => spy.mockRestore());
  });

  it('says so once, in words, without the password', async () => {
    await new Promise((r) => setTimeout(r, 1200)); // more failed reconnects
    const messages = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('Redis cache'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/Redis cache unavailable \((ECONNREFUSED|connect ECONNREFUSED[^)]*)\) at 127\.0\.0\.1:6390 — carrying on without the cache/);
    expect(messages[0]).not.toMatch(/secret/);
  });
});
