// TwiML — the XML Twilio reads to decide what a call does next. Only the few
// shapes HaiVE needs, built by hand (no SDK dependency) with every value escaped.

const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export function sayAndHangupTwiml(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(message)}</Say><Hangup/></Response>`;
}

/** Plays a short message to whoever hears it, then hands the call back (used as
 * the <Number url>: the customer hears it the moment they pick up, before the
 * two sides are connected). */
export function sayTwiml(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(message)}</Say></Response>`;
}

/**
 * Dial `destination` from `callerId` and record the conversation from the
 * moment it is answered, one channel per side ("record-from-answer-dual"), so
 * the transcript can tell the two speakers apart. Twilio posts the recording to
 * `recordingCallbackUrl` when it is ready and the dial's outcome to `actionUrl`
 * when the call ends. `announceUrl`, when given, is played to the person being
 * dialed as soon as they answer (the recording notice).
 */
export function recordAndDialTwiml(options: {
  callerId: string;
  destination: string;
  recordingCallbackUrl: string;
  actionUrl: string;
  announceUrl?: string;
  greeting?: string;
  ringTimeoutSeconds?: number;
}): string {
  const greeting = options.greeting ? `<Say>${escapeXml(options.greeting)}</Say>` : '';
  const numberUrl = options.announceUrl ? ` url="${escapeXml(options.announceUrl)}" method="POST"` : '';
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    greeting +
    `<Dial callerId="${escapeXml(options.callerId)}" timeout="${options.ringTimeoutSeconds ?? 45}"` +
    ` record="record-from-answer-dual" recordingStatusCallback="${escapeXml(options.recordingCallbackUrl)}"` +
    ' recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"' +
    ` action="${escapeXml(options.actionUrl)}" method="POST">` +
    `<Number${numberUrl}>${escapeXml(options.destination)}</Number>` +
    '</Dial></Response>'
  );
}
