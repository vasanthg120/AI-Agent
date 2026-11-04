// What makes a typed number callable, beyond "8 to 15 digits": countries whose
// numbers all have one length are held to it, so a digit short (a 9-digit
// Indian mobile) is caught before anyone's phone rings, not after a call that
// can never connect. Pure, and mirrored in frontend/src/dialer/lib/dialRules.ts
// so the keypad says exactly what the server will.

interface FixedLengthPlan {
  dialCode: string;
  // "Indian numbers have 10 digits…"
  adjective: string;
  nationalDigits: number;
  // What the first national digit may be (no Indian number starts with 0; no
  // North American area code starts with 0 or 1).
  firstDigit: RegExp;
}

export const FIXED_LENGTH_PLANS: readonly FixedLengthPlan[] = [
  { dialCode: '91', adjective: 'Indian', nationalDigits: 10, firstDigit: /[1-9]/ },
  { dialCode: '1', adjective: 'US and Canadian', nationalDigits: 10, firstDigit: /[2-9]/ },
];

export const MIN_DIGITS = 8;
export const MAX_DIGITS = 15; // E.164's ceiling

/** Why `digits` (country code included, no "+") can't be called — or null when it can. */
export function dialableProblem(digits: string): string | null {
  if (!/^\d+$/.test(digits)) return 'A phone number can only contain digits.';
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
    return 'Enter the full number with its country code, e.g. +91 98765 43210.';
  }
  const plan = FIXED_LENGTH_PLANS.find((p) => digits.startsWith(p.dialCode));
  if (!plan) return null;
  const national = digits.slice(plan.dialCode.length);
  if (national.length !== plan.nationalDigits) {
    return `${plan.adjective} numbers have ${plan.nationalDigits} digits after +${plan.dialCode} — this one has ${national.length}.`;
  }
  if (!plan.firstDigit.test(national[0])) {
    return national[0] === '0'
      ? `Leave out the 0 after +${plan.dialCode}.`
      : `That isn't a valid ${plan.adjective} number. Check the first digits.`;
  }
  return null;
}
