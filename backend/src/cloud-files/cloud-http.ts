import { HttpService } from '@nestjs/axios';
import { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import { firstValueFrom } from 'rxjs';

// Every call to Google Drive and Microsoft Graph goes through here: a few retries
// when the provider is busy or briefly down, and one plain message when it fails.

export type CloudErrorKind = 'auth' | 'permission' | 'not_found' | 'conflict' | 'rate_limit' | 'too_large' | 'unavailable' | 'bad_request' | 'not_configured';

/** A provider call that failed, said in words a person can act on. `detail` is for the log, never the page. */
export class CloudError extends Error {
  constructor(
    public readonly kind: CloudErrorKind,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
  }
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 20_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long the provider asked us to wait (Retry-After, in seconds or as a date), capped. */
function retryAfter(response: AxiosResponse | undefined, attempt: number): number {
  const header = response?.headers?.['retry-after'];
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_WAIT_MS);
    const at = Date.parse(String(header));
    if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), MAX_WAIT_MS);
  }
  return Math.min(500 * 2 ** attempt, MAX_WAIT_MS);
}

/** The provider's own words for an error, from either API's error body. */
function providerMessage(data: unknown): string {
  const body = (data ?? {}) as Record<string, any>;
  const error = body.error;
  if (typeof error === 'string') return [error, body.error_description].filter(Boolean).join(': ');
  return String(error?.message ?? body.message ?? '');
}

function providerReason(data: unknown): string {
  const error = ((data ?? {}) as Record<string, any>).error;
  return String(error?.errors?.[0]?.reason ?? error?.code ?? error?.status ?? '');
}

export function toCloudError(err: unknown, label: string): CloudError {
  if (err instanceof CloudError) return err;
  const axiosError = err as AxiosError;
  const status = axiosError.response?.status;
  const data = axiosError.response?.data;
  // A streamed response's body is a stream, not its words.
  const said = data && typeof (data as { pipe?: unknown }).pipe !== 'function' ? providerMessage(data) : '';
  const reason = data && typeof (data as { pipe?: unknown }).pipe !== 'function' ? providerReason(data) : '';
  const detail = `${status ?? 'no response'} ${reason} ${said || axiosError.message}`.trim().slice(0, 600);
  if (said.includes('invalid_grant') || status === 401)
    return new CloudError('auth', `The connection to ${label} has expired or was revoked. Reconnect it on the Integrations page.`, detail);
  if (status === 429 || /rateLimitExceeded|userRateLimitExceeded|activityThrottled/i.test(reason))
    return new CloudError('rate_limit', `${label} is limiting how fast HaiVE can work. Try again in a minute.`, detail);
  // Google reports a full drive as a 403: checked before the plain "no permission".
  if (status === 413 || /quotaExceeded|storageQuotaExceeded|quotaLimitReached/i.test(reason)) return new CloudError('too_large', `${label} has no room for that file.`, detail);
  if (status === 403) return new CloudError('permission', `Your ${label} account doesn’t have permission to do that.`, detail);
  if (status === 404) return new CloudError('not_found', `That file or folder is no longer in ${label} — it may have been moved or deleted.`, detail);
  if (status === 409) return new CloudError('conflict', `Something with that name is already there in ${label}.`, detail);
  if (status === 400) return new CloudError('bad_request', `${label} didn’t accept that${said ? `: ${said.slice(0, 160)}` : '.'}`, detail);
  return new CloudError('unavailable', `${label} couldn’t be reached. Try again in a minute.`, detail);
}

export interface CloudRequest extends AxiosRequestConfig {
  /** Retry when busy or down. On by default except for POST, which might have happened already. */
  retry?: boolean;
}

/** One call, retried on 429/5xx (Retry-After honoured), failing as a CloudError. */
export async function cloudRequest<T = any>(http: HttpService, label: string, config: CloudRequest): Promise<AxiosResponse<T>> {
  const { retry, ...request } = config;
  const retrying = retry ?? (request.method ?? 'get').toLowerCase() !== 'post';
  for (let attempt = 0; ; attempt++) {
    try {
      return await firstValueFrom(http.request<T>({ timeout: 30_000, ...request }));
    } catch (err) {
      const response = (err as AxiosError).response;
      const transient = !response || RETRY_STATUSES.has(response.status);
      if (!retrying || !transient || attempt + 1 >= MAX_ATTEMPTS) throw toCloudError(err, label);
      await sleep(retryAfter(response, attempt));
    }
  }
}
