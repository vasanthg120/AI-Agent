import { createHmac, timingSafeEqual } from 'crypto';

// Twilio signs every webhook it sends (voice, dial status, recording, call
// status) in the X-Twilio-Signature header: an HMAC-SHA1 of the full URL it
// requested plus the POST parameters, keyed by the account's Auth Token.
// Verifying it is what stops anyone who finds these URLs from forging "the call
// ended, here is its recording". Algorithm as documented at
// https://www.twilio.com/docs/usage/security#validating-requests and
// implemented by the official twilio-node SDK (webhooks.getExpectedTwilioSignature),
// pinned against it by twilio-pure.spec.ts:
//
//   data   = full URL (scheme, host, path and query string exactly as requested)
//            + every POST parameter sorted by name, each as name + value
//              (a repeated name contributes name + value once per value, values sorted)
//   signed = base64(HMAC-SHA1(authToken, data))
//
// The SDK also accepts the URL with the default port added or removed, because
// some proxies change it on the way — done the same way here.

type Params = Record<string, unknown>;

function asValues(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).map((v) => String(v ?? ''));
}

export function twilioSignatureBase(url: string, params: Params): string {
  return Object.keys(params)
    .sort()
    .reduce(
      (acc, key) =>
        acc +
        asValues(params[key])
          .sort()
          .map((value) => `${key}${value}`)
          .join(''),
      url,
    );
}

export function computeTwilioSignature(authToken: string, url: string, params: Params): string {
  return createHmac('sha1', authToken).update(twilioSignatureBase(url, params), 'utf8').digest('base64');
}

/** The URL as Twilio may have signed it: as-is, and with the scheme's default
 * port added or removed. */
function urlVariants(url: string): string[] {
  try {
    const parsed = new URL(url);
    const defaultPort = parsed.protocol === 'https:' ? '443' : '80';
    const withoutPort = new URL(url);
    withoutPort.port = '';
    const withPort = `${parsed.protocol}//${parsed.hostname}:${parsed.port || defaultPort}${parsed.pathname}${parsed.search}`;
    return [...new Set([url, withoutPort.toString(), withPort])];
  } catch {
    return [url];
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isValidTwilioSignature(input: { authToken: string; url: string; params: Params; signatureHeader: string | undefined }): boolean {
  const signature = input.signatureHeader?.trim();
  if (!signature || !input.authToken) return false;
  return urlVariants(input.url).some((url) => safeEqual(computeTwilioSignature(input.authToken, url, input.params), signature));
}
