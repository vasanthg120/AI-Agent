import { computePlivoSignatureV3, isValidPlivoSignature, plivoSignatureBase } from './plivo-signature';
import { maskPhone, normalizePhone } from './plivo-phone';
import { EMPTY_RESPONSE_XML, recordAndDialXml, speakAndHangupXml } from './plivo-xml';

// Every signature below was accepted by Plivo's own SDK (plivo-node,
// validateV3Signature) when these vectors were generated, and the implementation
// was cross-checked against that SDK on thousands of random requests — so these
// pin "matches what Plivo actually sends", not just "matches itself".
const VECTORS = [
  {
    name: 'POST with a query string and body params (the recording callback)',
    method: 'POST' as const,
    url: 'https://abc.ngrok.app/plivo/webhooks/recording?callId=665f1c2e9b1d4a0012ab34cd',
    nonce: '5e8f3a1c-77b2-4c1e-9d0a-2f6b8c4e1a90',
    token: 'MTQ2ZTA1NDU5OTMxYTIyYzMwNzk3NmVjYWI0NGZi',
    params: {
      RecordUrl: 'https://media.plivo.com/Recording/MAXXXXXXXXXXXXXXXXXX/rec-1.mp3',
      RecordingID: 'a1b2c3d4-0000-1111-2222-333344445555',
      RecordingDuration: '187',
      RecordingDurationMs: '187433',
    },
    signature: 'jVGQI+VSjSHAVZxDlpWzT88qEQ+EmQAD4TtPNVAPB0k=',
  },
  {
    name: 'POST with body params and no query (an inbound Answer)',
    method: 'POST' as const,
    url: 'https://abc.ngrok.app/plivo/webhooks/answer',
    nonce: 'nonce-without-query',
    token: 'auth-token-123',
    params: { CallUUID: 'f7e6d5c4-b3a2-4110-9988-776655443322', From: '919876543210', To: '918012345678', Direction: 'inbound' },
    signature: 'hMnnpF+tBIde2crcWN1I1PL5/Cz9z5MrXaTZqNObe5Y=',
  },
  {
    name: 'POST with a query string and an empty body',
    method: 'POST' as const,
    url: 'https://abc.ngrok.app/plivo/webhooks/hangup?callId=665f1c2e9b1d4a0012ab34cd',
    nonce: 'n3',
    token: 'auth-token-123',
    params: {},
    signature: 'njq8Sjyfe7RMXh5Cbw6Zdd3ePGdcQ8egtbV6xZtTSiA=',
  },
  {
    name: 'GET with unsorted, repeated query parameters',
    method: 'GET' as const,
    url: 'https://abc.ngrok.app/plivo/webhooks/hangup?z=1&a=2&a=1',
    nonce: 'n4',
    token: 'auth-token-123',
    params: {},
    signature: 'M6DAkHxq2nYDLrk8Y5gEMQqbxJlD5LiplO795K0tFuc=',
  },
];

describe('Plivo webhook signature (V3)', () => {
  it.each(VECTORS)('computes the signature Plivo sends: $name', ({ method, url, nonce, token, params, signature }) => {
    expect(computePlivoSignatureV3(method, url, nonce, token, params)).toBe(signature);
    expect(isValidPlivoSignature({ method, requestUrl: url, params, nonce, signatureHeader: signature, authToken: token })).toBe(true);
  });

  const v = VECTORS[0];
  const valid = { method: v.method, requestUrl: v.url, params: v.params, nonce: v.nonce, signatureHeader: v.signature, authToken: v.token };

  it('rejects a wrong auth token, a wrong nonce, a changed URL and a changed body', () => {
    expect(isValidPlivoSignature({ ...valid, authToken: 'someone-elses-token' })).toBe(false);
    expect(isValidPlivoSignature({ ...valid, nonce: 'other-nonce' })).toBe(false);
    expect(isValidPlivoSignature({ ...valid, requestUrl: v.url.replace('665f1c2e9b1d4a0012ab34cd', '000000000000000000000000') })).toBe(false);
    expect(isValidPlivoSignature({ ...valid, params: { ...v.params, RecordUrl: 'http://169.254.169.254/latest/meta-data' } })).toBe(false);
    expect(isValidPlivoSignature({ ...valid, params: { ...v.params, Extra: 'field' } })).toBe(false);
  });

  it('accepts one good signature among several (Plivo sends more than one during token rotation)', () => {
    expect(isValidPlivoSignature({ ...valid, signatureHeader: `AAAA, ${v.signature} ,BBBB` })).toBe(true);
    expect(isValidPlivoSignature({ ...valid, signatureHeader: 'AAAA,BBBB' })).toBe(false);
  });

  it('treats missing or malformed input as invalid rather than throwing', () => {
    expect(isValidPlivoSignature({ ...valid, signatureHeader: undefined })).toBe(false);
    expect(isValidPlivoSignature({ ...valid, nonce: undefined })).toBe(false);
    expect(isValidPlivoSignature({ ...valid, authToken: '' })).toBe(false);
    expect(isValidPlivoSignature({ ...valid, requestUrl: 'not a url' })).toBe(false);
    expect(isValidPlivoSignature({ ...valid, signatureHeader: '' })).toBe(false);
  });

  it('is independent of parameter order in the request', () => {
    const shuffled = Object.fromEntries(Object.entries(v.params).reverse());
    expect(isValidPlivoSignature({ ...valid, params: shuffled })).toBe(true);
  });

  it('builds the string Plivo signs (URL, sorted query, "." only when both a query and a body exist)', () => {
    expect(plivoSignatureBase('POST', 'https://h.io/p?b=2&a=1', { X: '1', A: '2' })).toBe('https://h.io/p?a=1&b=2.A2X1');
    expect(plivoSignatureBase('POST', 'https://h.io/p', { X: '1' })).toBe('https://h.io/p?X1');
    expect(plivoSignatureBase('POST', 'https://h.io/p?a=1', {})).toBe('https://h.io/p?a=1');
    expect(plivoSignatureBase('POST', 'https://h.io/p', {})).toBe('https://h.io/p');
    expect(plivoSignatureBase('GET', 'https://h.io/p?b=2&a=1')).toBe('https://h.io/p?a=1&b=2');
  });
});

describe('Plivo call XML', () => {
  const xml = recordAndDialXml({
    recordingCallbackUrl: 'https://x.io/plivo/webhooks/recording?callId=abc&x=1',
    dialActionUrl: 'https://x.io/plivo/webhooks/hangup?callId=abc',
    callerId: '918012345678',
    destination: '919876543210',
  });

  it('records the bridged conversation, then dials the destination', () => {
    expect(xml).toContain('<Record startOnDialAnswer="true"');
    expect(xml).toContain('callbackMethod="POST"');
    expect(xml).toContain('<Number>919876543210</Number>');
    expect(xml).toContain('callerId="918012345678"');
    expect(xml.indexOf('<Record')).toBeLessThan(xml.indexOf('<Dial')); // recording is armed before the dial
  });

  it('escapes every interpolated value so a URL can never break out of an attribute', () => {
    expect(xml).toContain('callId=abc&amp;x=1');
    const hostile = recordAndDialXml({ recordingCallbackUrl: 'https://x.io/?"><Hangup/>', dialActionUrl: 'u', callerId: '<c>', destination: '1&2' });
    expect(hostile).not.toContain('<Hangup/>');
    expect(hostile).toContain('&lt;c&gt;');
    expect(hostile).toContain('1&amp;2');
  });

  it('has a ring timeout that never drops below a sane minimum', () => {
    expect(recordAndDialXml({ recordingCallbackUrl: 'r', dialActionUrl: 'a', callerId: 'c', destination: 'd', ringTimeoutSeconds: 1 })).toContain('timeout="5"');
  });

  it('builds the not-set-up message and the empty acknowledgement', () => {
    expect(speakAndHangupXml('Not <ready> & "so"')).toBe('<Response>\n  <Speak>Not &lt;ready&gt; &amp; &quot;so&quot;</Speak>\n  <Hangup/>\n</Response>');
    expect(EMPTY_RESPONSE_XML).toBe('<Response></Response>');
  });
});

describe('phone numbers', () => {
  it.each([
    ['98765 43210', '919876543210'],
    ['09876543210', '919876543210'],
    ['+91 98765-43210', '919876543210'],
    ['0091 9876543210', '919876543210'],
    ['(91) 98765 43210', '919876543210'],
    ['+1 (415) 555-1234', '14155551234'],
    ['918012345678', '918012345678'],
  ])('normalizes %s -> %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(['', 'abc', '12345', '1234567', '1'.repeat(16), null as unknown as string])('rejects %p', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it('uses the configured default country code for bare national numbers', () => {
    expect(normalizePhone('4155551234', '1')).toBe('14155551234');
  });

  it('masks all but the last four digits', () => {
    expect(maskPhone('919876543210')).toBe('••••••••3210');
    expect(maskPhone('1234')).toBe('1234');
  });
});
