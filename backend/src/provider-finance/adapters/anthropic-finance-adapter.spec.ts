import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { AnthropicFinanceAdapter } from './anthropic-finance-adapter.service';

// Pure unit tests against a mocked HttpService — no real network calls, no
// real Mongo. Exercises exactly the gaps flagged in a live-usage bug report:
// cost amount units (confirmed via Anthropic's own docs to be MINOR units/
// cents, not whole dollars — see this adapter's own MINOR_UNITS_PER_WHOLE_UNIT
// comment), full pagination, retry-with-backoff, and auth-failure handling.
function axiosError(status: number): { response: { status: number } } {
  return { response: { status } };
}

describe('AnthropicFinanceAdapter', () => {
  function build(getImpl: jest.Mock) {
    const http = { get: getImpl } as unknown as HttpService;
    return new AnthropicFinanceAdapter(http);
  }

  it('normalizes cost amounts from minor units (cents) to whole USD — confirmed against Anthropic\'s own docs', async () => {
    const get = jest.fn().mockReturnValue(
      of({
        data: {
          data: [{ starting_at: '2026-11-01T00:00:00Z', results: [{ amount: '12345', currency: 'USD' }] }], // "12345" minor units = $123.45
          has_more: false,
          next_page: null,
        },
      }),
    );
    const adapter = build(get);

    const report = await adapter.syncUsageCost('admin-key', new Date('2026-11-01'));

    expect(report.totalCostUsd).toBeCloseTo(123.45, 5);
    expect(report.points).toEqual([{ date: '2026-11-01', costUsd: 123.45 }]);
  });

  it('sums multiple cost line items within the same day bucket, each normalized independently', async () => {
    const get = jest.fn().mockReturnValue(
      of({
        data: {
          data: [
            {
              starting_at: '2026-11-01T00:00:00Z',
              results: [
                { amount: '10000', currency: 'USD' }, // $100.00
                { amount: '2550', currency: 'USD' }, // $25.50
              ],
            },
          ],
          has_more: false,
          next_page: null,
        },
      }),
    );
    const adapter = build(get);

    const report = await adapter.syncUsageCost('admin-key', new Date('2026-11-01'));

    expect(report.totalCostUsd).toBeCloseTo(125.5, 5);
  });

  it('drains every page before returning, following has_more/next_page, never returning a partial result', async () => {
    const get = jest
      .fn()
      .mockReturnValueOnce(of({ data: { data: [{ starting_at: '2026-11-01T00:00:00Z', results: [{ amount: '100', currency: 'USD' }] }], has_more: true, next_page: 'cursor-2' } }))
      .mockReturnValueOnce(of({ data: { data: [{ starting_at: '2026-11-02T00:00:00Z', results: [{ amount: '200', currency: 'USD' }] }], has_more: true, next_page: 'cursor-3' } }))
      .mockReturnValueOnce(of({ data: { data: [{ starting_at: '2026-11-03T00:00:00Z', results: [{ amount: '300', currency: 'USD' }] }], has_more: false, next_page: null } }));
    const adapter = build(get);

    const report = await adapter.syncUsageCost('admin-key', new Date('2026-11-01'));

    expect(get).toHaveBeenCalledTimes(3);
    expect(get.mock.calls[1][1].params.page).toBe('cursor-2');
    expect(get.mock.calls[2][1].params.page).toBe('cursor-3');
    expect(report.points).toHaveLength(3);
    expect(report.totalCostUsd).toBeCloseTo(1 + 2 + 3, 5); // (100+200+300 cents)/100
  });

  it('retries a transient 429/5xx response and succeeds once the provider recovers', async () => {
    const get = jest
      .fn()
      .mockReturnValueOnce(throwError(() => axiosError(429)))
      .mockReturnValueOnce(throwError(() => axiosError(503)))
      .mockReturnValueOnce(of({ data: { data: [{ starting_at: '2026-11-01T00:00:00Z', results: [{ amount: '500', currency: 'USD' }] }], has_more: false, next_page: null } }));
    const adapter = build(get);

    const report = await adapter.syncUsageCost('admin-key', new Date('2026-11-01'));

    expect(get).toHaveBeenCalledTimes(3);
    expect(report.totalCostUsd).toBeCloseTo(5, 5);
  }, 10_000);

  it('gives up after exhausting retries on a persistent failure, surfacing the real error rather than silently returning empty data', async () => {
    const get = jest.fn().mockReturnValue(throwError(() => axiosError(503)));
    const adapter = build(get);

    await expect(adapter.syncUsageCost('admin-key', new Date('2026-11-01'))).rejects.toBeDefined();
  }, 15_000);

  it('does not retry a non-retryable 401 — fails fast on authentication failure', async () => {
    const get = jest.fn().mockReturnValue(throwError(() => axiosError(401)));
    const adapter = build(get);

    await expect(adapter.syncUsageCost('bad-key', new Date('2026-11-01'))).rejects.toBeDefined();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('readRateLimits reports PERMISSION_REQUIRED for a 401/403 (wrong credential tier), distinct from UNSUPPORTED', async () => {
    const get = jest.fn().mockReturnValue(throwError(() => axiosError(403)));
    const adapter = build(get);

    const result = await adapter.readRateLimits('normal-chat-key-not-admin');

    expect(result.status).toBe('PERMISSION_REQUIRED');
    expect(result.ok).toBe(false);
  });

  it('readRateLimits reports SUPPORTED with real data on success', async () => {
    const get = jest.fn().mockReturnValue(of({ data: { input_tokens_limit: 1000 } }));
    const adapter = build(get);

    const result = await adapter.readRateLimits('admin-key');

    expect(result.status).toBe('SUPPORTED');
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ input_tokens_limit: 1000 });
  });

  it('getCapabilities flips USAGE_COST_READ/RATE_LIMIT_READ from CONFIGURATION_REQUIRED to SUPPORTED exactly when an Admin API key is present', () => {
    const adapter = build(jest.fn());

    const withoutKey = adapter.getCapabilities({});
    expect(withoutKey.USAGE_COST_READ.status).toBe('CONFIGURATION_REQUIRED');
    expect(withoutKey.RATE_LIMIT_READ.status).toBe('CONFIGURATION_REQUIRED');

    const withKey = adapter.getCapabilities({ adminApiKeyEncrypted: 'encrypted-blob' });
    expect(withKey.USAGE_COST_READ.status).toBe('SUPPORTED');
    expect(withKey.RATE_LIMIT_READ.status).toBe('SUPPORTED');

    // BALANCE_READ is never SUPPORTED regardless — no API exists at all,
    // confirmed live, not assumed.
    expect(withKey.BALANCE_READ.status).toBe('UNSUPPORTED');
  });
});
