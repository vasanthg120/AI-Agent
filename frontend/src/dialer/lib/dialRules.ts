// What the keypad holds and what it means: the typed text ("98765 43210", or
// "+44 7700…" with its own country code), the number that would be called, how
// to show it while typing, and why it can't be called yet. Pure — the keypad
// and the call button read the same answers.
//
// dialableProblem mirrors backend/src/calling/dialable-number.ts word for word,
// so the keypad refuses exactly what the server would.

import { COUNTRIES, countryOfNumber, type Country } from '@/services/callingService';

// ---- the server's rule ---------------------------------------------------------

interface FixedLengthPlan {
  dialCode: string;
  adjective: string;
  nationalDigits: number;
  firstDigit: RegExp;
}

const FIXED_LENGTH_PLANS: readonly FixedLengthPlan[] = [
  { dialCode: '91', adjective: 'Indian', nationalDigits: 10, firstDigit: /[1-9]/ },
  { dialCode: '1', adjective: 'US and Canadian', nationalDigits: 10, firstDigit: /[2-9]/ },
];
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

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

// ---- the keypad's text -------------------------------------------------------------

/** Only what a keypad can type: digits, * and #, and a + at the very start. */
export function cleanEntry(raw: string): string {
  const kept = raw.replace(/[^\d*#+]/g, '');
  const plus = kept.startsWith('+');
  return (plus ? '+' : '') + kept.replace(/\+/g, '');
}

/** The country a number is in: the one its "+" code names, else the one picked. */
export function countryOfEntry(text: string, picked: Country): Country {
  if (!text.startsWith('+')) return picked;
  return countryOfNumber(text.slice(1)) ?? picked;
}

/** The number to call, digits with country code — or null while there isn't one. */
export function numberToCall(text: string, picked: Country): string | null {
  if (!text || text === '+') return null;
  if (text.startsWith('+')) return text.slice(1);
  // A national number keeps its trunk 0 out ("098765…" is +91 98765…) — except
  // in North America, where there is none.
  const national = picked.dialCode !== '1' && text.startsWith('0') ? text.slice(1) : text;
  return `${picked.dialCode}${national}`;
}

/** What to say under the number while it's being typed: how far there is to go, or what's wrong. */
export function entryHint(text: string, picked: Country): { tone: 'info' | 'error'; text: string } | null {
  if (!text || text === '+') return null;
  if (/[*#]/.test(text)) return { tone: 'error', text: 'Phone numbers can’t include * or #.' };
  const digits = numberToCall(text, picked);
  if (!digits) return null;
  const plan = FIXED_LENGTH_PLANS.find((p) => digits.startsWith(p.dialCode));
  if (plan) {
    const national = digits.slice(plan.dialCode.length);
    if (national.length < plan.nationalDigits) {
      const left = plan.nationalDigits - national.length;
      return { tone: 'info', text: `${left} more digit${left === 1 ? '' : 's'}` };
    }
  }
  const problem = dialableProblem(digits);
  if (problem && digits.length < MIN_DIGITS) return null; // still typing
  return problem ? { tone: 'error', text: problem } : null;
}

/** How the typed number reads: grouped the way that country writes it. */
export function formatEntry(text: string, picked: Country): string {
  if (!text) return '';
  if (/[*#]/.test(text)) return text;
  if (text.startsWith('+')) {
    const digits = text.slice(1);
    const country = countryOfNumber(digits);
    if (!country) return text;
    return `+${country.dialCode} ${groupNational(digits.slice(country.dialCode.length), country)}`.trim();
  }
  return groupNational(text, picked);
}

function groupNational(national: string, country: Country): string {
  if (country.dialCode === '1') {
    // (415) 555-0100
    if (national.length <= 3) return national;
    if (national.length <= 6) return `(${national.slice(0, 3)}) ${national.slice(3)}`;
    return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
  }
  if (country.dialCode === '91') {
    // 98765 43210 (a leading trunk 0 stays in front: 0 98765 43210)
    const lead = national.startsWith('0') ? '0 ' : '';
    const rest = lead ? national.slice(1) : national;
    return `${lead}${rest.slice(0, 5)}${rest.length > 5 ? ` ${rest.slice(5)}` : ''}`;
  }
  // Elsewhere, by length: 8 digits 4-4, 9 digits 3-3-3, 10 digits 4-3-3; longer,
  // blocks of three with the last up to four.
  if (national.length === 8) return `${national.slice(0, 4)} ${national.slice(4)}`;
  if (national.length === 9) return `${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
  if (national.length === 10) return `${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)}`;
  const groups: string[] = [];
  let rest = national;
  while (rest.length > 4) {
    groups.push(rest.slice(0, 3));
    rest = rest.slice(3);
  }
  if (rest) groups.push(rest);
  return groups.join(' ');
}

/** A full number (digits with country code) as the Dialer shows it everywhere: "+91 98765 43210". */
export function formatNumber(digits: string): string {
  return /^\d+$/.test(digits) && countryOfNumber(digits) ? formatEntry(`+${digits}`, COUNTRIES[0]) : digits;
}

/**
 * A pasted number, as keypad text. "+44 7700 900123" and "0044 7700…" keep
 * their country code; "919876543210" (the picked country's code, the full
 * length) becomes "+91…"; anything else is a national number.
 */
export function entryFromPaste(raw: string, picked: Country): string {
  const trimmed = raw.trim();
  let digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return '';
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  const plan = FIXED_LENGTH_PLANS.find((p) => p.dialCode === picked.dialCode);
  if (plan && digits.startsWith(plan.dialCode) && digits.length === plan.dialCode.length + plan.nationalDigits) return `+${digits}`;
  if (digits.length > 11 && countryOfNumber(digits)) return `+${digits}`;
  digits = digits.slice(0, MAX_DIGITS);
  return digits;
}

/** The country to start on: the one last used here, else the business's home country. */
export function startingCountry(storedIso: string | null, domesticDialCode: string): Country {
  return (
    COUNTRIES.find((c) => c.iso === storedIso) ??
    COUNTRIES.find((c) => c.dialCode === domesticDialCode) ??
    COUNTRIES[0]
  );
}
