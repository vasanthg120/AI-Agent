// The Plivo XML this integration returns to Plivo's Answer webhook. Kept as
// small pure functions so what is sent to the phone network is exactly what the
// spec asserts, with every interpolated value escaped.

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface RecordAndDialOptions {
  // Where Plivo POSTs the finished recording (RecordUrl, RecordingID, ...).
  recordingCallbackUrl: string;
  // Where Plivo POSTs how the dialed leg ended (DialStatus, ...).
  dialActionUrl: string;
  // Where Plivo POSTs the dialed leg's events as they happen (DialAction
  // "answer" the moment the far end picks up, then "hangup").
  dialEventsUrl?: string;
  // The number shown to the person being dialed.
  callerId: string;
  // Digits only, country code included.
  destination: string;
  // Seconds to let the far end ring before giving up.
  ringTimeoutSeconds?: number;
}

/**
 * Connects the caller to `destination` and records the conversation between
 * the two of them.
 *
 * `startOnDialAnswer` (Plivo's documented way to record a bridged call) starts
 * recording when the dialed party picks up, so ringing and the agent's own
 * "hello?" before a connection are not recorded. Both sides are captured, on
 * separate stereo channels, which keeps "who said what" recoverable.
 */
export function recordAndDialXml(options: RecordAndDialOptions): string {
  const { recordingCallbackUrl, dialActionUrl, dialEventsUrl, callerId, destination, ringTimeoutSeconds = 40 } = options;
  const events = dialEventsUrl ? ` callbackUrl="${escapeXml(dialEventsUrl)}" callbackMethod="POST"` : '';
  return [
    '<Response>',
    `  <Record startOnDialAnswer="true" fileFormat="mp3" recordChannelType="stereo" callbackUrl="${escapeXml(recordingCallbackUrl)}" callbackMethod="POST"/>`,
    `  <Dial callerId="${escapeXml(callerId)}" timeout="${Math.max(5, Math.floor(ringTimeoutSeconds))}" action="${escapeXml(dialActionUrl)}" method="POST"${events}>`,
    `    <Number>${escapeXml(destination)}</Number>`,
    '  </Dial>',
    '</Response>',
  ].join('\n');
}

/** Says a short message and ends the call — used when a number isn't set up. */
export function speakAndHangupXml(message: string): string {
  return `<Response>\n  <Speak>${escapeXml(message)}</Speak>\n  <Hangup/>\n</Response>`;
}

/** Acknowledge a callback with nothing further to do. */
export const EMPTY_RESPONSE_XML = '<Response></Response>';
