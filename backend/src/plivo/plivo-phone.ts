// Phone numbers travel through Plivo as digits only, country code included
// (E.164 without the "+", e.g. 919876543210) — the shape its Make Call API
// documents. People type them every which way, so this normalizes once, at the
// edge, and everything stored or sent afterward is already clean.

const MIN_DIGITS = 8;
const MAX_DIGITS = 15; // E.164's ceiling

/** null when the input can't be a phone number. A bare national number (10
 * digits, or 11 with a leading 0) gets `defaultCountryCode` prepended — for this
 * deployment that's India, so "98765 43210" and "09876543210" both become
 * 919876543210; anything longer is taken to already carry its country code. */
export function normalizePhone(input: string, defaultCountryCode = '91'): string | null {
  let digits = (input ?? '').replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2); // international dialing prefix
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = `${defaultCountryCode}${digits}`;
  return digits.length >= MIN_DIGITS && digits.length <= MAX_DIGITS ? digits : null;
}

/** For display and logs: the last four digits only. */
export function maskPhone(digits: string): string {
  return digits.length <= 4 ? digits : `${'•'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}
