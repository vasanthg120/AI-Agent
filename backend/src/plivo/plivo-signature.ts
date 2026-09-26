import { createHmac, timingSafeEqual } from 'crypto';

// Plivo signs every webhook it sends (Answer / Hangup / Record callbacks) with
// an HMAC-SHA256 of the request, keyed by the account's Auth Token. Verifying
// it is what stops anyone who finds these URLs from forging "a call ended,
// here is its recording" and making this server download and process a file of
// their choosing. Anything that fails verification is rejected.
//
// The algorithm is Plivo's "V3" signature. The exact string that gets signed
// is not fully spelled out in their docs; it is taken from their official SDK
// (plivo-node, utils/v3Security.js) and pinned against it by plivo-signature.spec.ts:
//
//   base   = scheme://host[:port]/path
//   query  = the URL's own query parameters, keys sorted, values sorted per key, "k=v" joined by "&"
//   POST   = base + (query || bodyParams ? "?" : "") + query + (query && bodyParams ? "." : "")
//                 + bodyParams sorted by key, each as "key" + "value", concatenated
//   GET    = base + (query ? "?" + query : "")
//   signed = HMAC-SHA256(authToken, `${POST-or-GET-string}.${nonce}`), base64
//
// Plivo may send several signatures at once (comma-separated, e.g. while a
// token is being rotated); any one matching is enough.

type Params = Record<string, unknown>;

function asArray(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).map((v) => String(v ?? ''));
}

function sortedQuery(url: URL): string {
  const byKey = new Map<string, string[]>();
  for (const [key, value] of url.searchParams.entries()) byKey.set(key, [...(byKey.get(key) ?? []), value]);
  return [...byKey.keys()]
    .sort()
    .flatMap((key) =>
      byKey
        .get(key)!
        .sort()
        .map((value) => `${key}=${value}`),
    )
    .join('&');
}

function sortedBodyParams(params: Params): string {
  return Object.keys(params)
    .sort()
    .flatMap((key) =>
      asArray(params[key])
        .sort()
        .map((value) => `${key}${value}`),
    )
    .join('');
}

export function plivoSignatureBase(method: 'GET' | 'POST', requestUrl: string, params: Params = {}): string {
  const url = new URL(requestUrl);
  const base = `${url.protocol}//${url.host}${url.pathname}`;
  const query = sortedQuery(url);
  const hasBody = Object.keys(params).length > 0;

  if (method === 'GET') return query ? `${base}?${query}` : base;

  let out = base;
  if (query || hasBody) out += `?${query}`;
  if (query && hasBody) out += '.';
  return out + sortedBodyParams(params);
}

export function computePlivoSignatureV3(
  method: 'GET' | 'POST',
  requestUrl: string,
  nonce: string,
  authToken: string,
  params: Params = {},
): string {
  return createHmac('sha256', authToken).update(`${plivoSignatureBase(method, requestUrl, params)}.${nonce}`).digest('base64');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** True when any of the comma-separated signatures in `signatureHeader` is the
 * correct one for this request. Never throws on malformed input — a bad URL or
 * a missing header is simply "not valid". */
export function isValidPlivoSignature(args: {
  method: 'GET' | 'POST';
  requestUrl: string;
  params?: Params;
  nonce: string | undefined;
  signatureHeader: string | undefined;
  authToken: string;
}): boolean {
  const { method, requestUrl, params, nonce, signatureHeader, authToken } = args;
  if (!nonce || !signatureHeader || !authToken) return false;
  try {
    const expected = computePlivoSignatureV3(method, requestUrl, nonce, authToken, params);
    return signatureHeader.split(',').some((candidate) => safeEqual(candidate.trim(), expected));
  } catch {
    return false;
  }
}
