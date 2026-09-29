import { useId, useState } from 'react';
import { COUNTRIES, countryOfNumber, flagPrefix, type Country } from '@/services/callingService';
import styles from './PhoneNumberField.module.css';
import { Flag } from './Flag';

const MIN_NATIONAL_DIGITS = 6;
const MAX_TOTAL_DIGITS = 15; // E.164

export interface PhoneNumberFieldProps {
  label: string;
  hint?: string;
  // Country shown first (ISO code, e.g. "IN").
  defaultCountry?: string;
  disabled?: boolean;
  // The full number as digits with its country code ('' while incomplete), and
  // the country it was dialled for.
  onChange: (digits: string, country: Country) => void;
}

function findCountry(iso: string): Country {
  return COUNTRIES.find((c) => c.iso === iso) ?? COUNTRIES[0];
}

/** Digits with the country code, or '' when the number can't be dialled yet. */
export function toFullNumber(country: Country, national: string): string {
  // A leading 0 is the national trunk prefix ("07700 900123" in the UK) — never
  // dialled after a country code.
  const digits = national.replace(/\D/g, '').replace(/^0+/, '');
  const full = `${country.dialCode}${digits}`;
  return digits.length >= MIN_NATIONAL_DIGITS && full.length <= MAX_TOTAL_DIGITS ? full : '';
}

// A phone number with its country: a flag-and-code picker next to the number.
// Pasting a full international number ("+44 7700 900123" or "0044…") switches
// the country by itself, so people never have to work out which part is which.
export function PhoneNumberField({ label, hint, defaultCountry = 'IN', disabled, onChange }: PhoneNumberFieldProps) {
  const id = useId();
  const [country, setCountry] = useState<Country>(() => findCountry(defaultCountry));
  const [national, setNational] = useState('');

  const emit = (nextCountry: Country, nextNational: string) =>
    onChange(toFullNumber(nextCountry, nextNational), nextCountry);

  const handleNumber = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith('+') || trimmed.startsWith('00')) {
      const digits = trimmed.replace(/\D/g, '').replace(/^00/, '');
      const detected = countryOfNumber(digits);
      if (detected) {
        // Keep the choice between countries that share a code (US/Canada).
        const keep = country.dialCode === detected.dialCode ? country : detected;
        const rest = digits.slice(detected.dialCode.length);
        setCountry(keep);
        setNational(rest);
        emit(keep, rest);
        return;
      }
    }
    setNational(raw);
    emit(country, raw);
  };

  const handleCountry = (iso: string) => {
    const next = findCountry(iso);
    setCountry(next);
    emit(next, national);
  };

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={`${id}-number`}>
        {label}
      </label>
      <div className={styles.control} data-disabled={disabled || undefined}>
        <span className={styles.countryWrap}>
          <Flag iso={country.iso} />
          <span className={styles.code} aria-hidden>
            +{country.dialCode}
          </span>
          <select
            className={styles.countrySelect}
            aria-label="Country"
            value={country.iso}
            disabled={disabled}
            onChange={(e) => handleCountry(e.target.value)}
          >
            {COUNTRIES.map((c) => (
              <option key={c.iso} value={c.iso}>
                {flagPrefix(c.iso)}
                {c.name} (+{c.dialCode})
              </option>
            ))}
          </select>
        </span>
        <input
          id={`${id}-number`}
          className={styles.input}
          type="tel"
          inputMode="tel"
          autoComplete="off"
          placeholder={country.iso === 'IN' ? '98765 43210' : country.iso === 'GB' ? '7700 900123' : 'Phone number'}
          value={national}
          disabled={disabled}
          onChange={(e) => handleNumber(e.target.value)}
        />
      </div>
      {hint && <span className={styles.hint}>{hint}</span>}
    </div>
  );
}
