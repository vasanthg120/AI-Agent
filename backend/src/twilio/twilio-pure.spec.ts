import { chooseProvider } from '../calling/calling-routing';
import { computeTwilioSignature, isValidTwilioSignature } from './twilio-signature';
import { recordAndDialTwiml, sayAndHangupTwiml } from './twilio-twiml';

// Expected signatures generated with the official twilio-node SDK (v5,
// webhooks.getExpectedTwilioSignature); the first is also the worked example in
// Twilio's own security docs. Placeholders only: nothing here is shaped like a
// real Account SID or Auth Token, so secret scanners (GitHub push protection)
// have nothing to flag.
const SDK_VECTORS: Array<[string, string, Record<string, unknown>, string]> = [
  [
    '12345',
    'https://mycompany.com/myapp.php?foo=1&bar=2',
    { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' },
    '0/KCTR6DLpKmkAf8muzZqo1nDgQ=',
  ],
  [
    'test-auth-token',
    'https://haive.example.com/twilio/webhooks/recording?callId=66f0c0ffee0000000000abcd',
    {
      AccountSid: 'AC_TEST_ACCOUNT_SID',
      CallSid: 'CAaaa',
      RecordingSid: 'RE123',
      RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE123',
      RecordingStatus: 'completed',
      RecordingDuration: '42',
    },
    'Be+yzwvN/6NMFIZL+gyQJ0xx+Oo=',
  ],
  ['tok', 'https://x.ngrok-free.dev/twilio/webhooks/voice', { Multi: ['b', 'a'], Z: 'ü ✓' }, 'y+dTelQgCHSFMfzQbD/gJbk4VEE='],
];

describe('Twilio signature', () => {
  it.each(SDK_VECTORS)('matches the official SDK (%#)', (token, url, params, expected) => {
    expect(computeTwilioSignature(token, url, params)).toBe(expected);
    expect(isValidTwilioSignature({ authToken: token, url, params, signatureHeader: expected })).toBe(true);
  });

  const [token, url, params, sig] = SDK_VECTORS[1];

  it('rejects a changed parameter, URL, token or missing header', () => {
    expect(isValidTwilioSignature({ authToken: token, url, params: { ...params, RecordingUrl: 'https://evil.example/x' }, signatureHeader: sig })).toBe(false);
    expect(isValidTwilioSignature({ authToken: token, url: url.replace('abcd', 'abce'), params, signatureHeader: sig })).toBe(false);
    expect(isValidTwilioSignature({ authToken: 'other', url, params, signatureHeader: sig })).toBe(false);
    expect(isValidTwilioSignature({ authToken: token, url, params, signatureHeader: undefined })).toBe(false);
  });

  it('accepts the URL signed with the default port spelled out, as the SDK does', () => {
    const withPort = url.replace('haive.example.com', 'haive.example.com:443');
    const signedWithPort = computeTwilioSignature(token, withPort, params);
    expect(isValidTwilioSignature({ authToken: token, url, params, signatureHeader: signedWithPort })).toBe(true);
  });
});

describe('TwiML', () => {
  it('records both sides from answer and escapes every value', () => {
    const xml = recordAndDialTwiml({
      callerId: '+14155550100',
      destination: '+447700900123',
      recordingCallbackUrl: 'https://h.example/twilio/webhooks/recording?callId=1&x=<y>',
      actionUrl: 'https://h.example/twilio/webhooks/dial-status?callId=1',
      announceUrl: 'https://h.example/twilio/webhooks/announce?callId=1',
      greeting: 'Connecting "you" & them',
    });
    expect(xml).toContain('record="record-from-answer-dual"');
    expect(xml).toContain('recordingStatusCallback="https://h.example/twilio/webhooks/recording?callId=1&amp;x=&lt;y&gt;"');
    expect(xml).toContain('<Say>Connecting &quot;you&quot; &amp; them</Say>');
    expect(xml).toContain('<Number url="https://h.example/twilio/webhooks/announce?callId=1" method="POST">+447700900123</Number>');
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it('leaves out the announcement and greeting when not asked for', () => {
    const xml = recordAndDialTwiml({ callerId: '+1', destination: '+2', recordingCallbackUrl: 'r', actionUrl: 'a' });
    expect(xml).toContain('<Number>+2</Number>');
    expect(xml).not.toContain('<Say>');
    expect(sayAndHangupTwiml('Not set up <yet>')).toContain('<Say>Not set up &lt;yet&gt;</Say><Hangup/>');
  });
});

describe('call routing', () => {
  it('sends domestic numbers via Plivo and international via Twilio when both are available', () => {
    expect(chooseProvider('919876543210', ['plivo', 'twilio'], '91')).toBe('plivo');
    expect(chooseProvider('447700900123', ['plivo', 'twilio'], '91')).toBe('twilio');
    expect(chooseProvider('14155550100', ['plivo', 'twilio'], '91')).toBe('twilio');
  });

  it('falls back to whichever single provider is available', () => {
    expect(chooseProvider('447700900123', ['plivo'], '91')).toBe('plivo');
    expect(chooseProvider('919876543210', ['twilio'], '91')).toBe('twilio');
    expect(chooseProvider('919876543210', [], '91')).toBeNull();
  });

  it('honours an explicit choice only when that provider is available', () => {
    expect(chooseProvider('919876543210', ['plivo', 'twilio'], '91', 'twilio')).toBe('twilio');
    expect(chooseProvider('447700900123', ['plivo'], '91', 'twilio')).toBeNull();
  });
});
