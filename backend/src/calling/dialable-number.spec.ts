import { dialableProblem } from './dialable-number';

describe('dialableProblem — what may be dialled', () => {
  it.each([
    ['919876543210', 'an Indian mobile (10 digits after +91)'],
    ['918031730029', 'an Indian landline with its area code'],
    ['911123456789', 'a Delhi number (area code 11)'],
    ['14155550100', 'a US number'],
    ['447700900123', 'a UK mobile'],
    ['61402779906', 'an Australian mobile'],
    ['97150123456', 'a UAE mobile'],
    ['6591234567', 'a Singapore number (8 national digits)'],
  ])('accepts %s (%s)', (digits) => {
    expect(dialableProblem(digits)).toBeNull();
  });

  it('refuses a 9-digit Indian number — the known gap (91934447052 never connected)', () => {
    expect(dialableProblem('91934447052')).toBe('Indian numbers have 10 digits after +91 — this one has 9.');
  });

  it('refuses an Indian number with a digit too many, or with the trunk 0 kept', () => {
    expect(dialableProblem('9198765432101')).toMatch(/10 digits after \+91 — this one has 11/);
    expect(dialableProblem('910987654321')).toBe('Leave out the 0 after +91.');
  });

  it('holds US/Canadian numbers to 10 digits and a real area code', () => {
    expect(dialableProblem('1415555010')).toMatch(/10 digits after \+1 — this one has 9/);
    expect(dialableProblem('11155550100')).toMatch(/isn't a valid US and Canadian number/);
  });

  it('refuses anything that is not 8–15 digits', () => {
    expect(dialableProblem('4477')).toMatch(/full number with its country code/);
    expect(dialableProblem('4477009001234567')).toMatch(/full number with its country code/);
    expect(dialableProblem('91987*543210')).toBe('A phone number can only contain digits.');
    expect(dialableProblem('')).toBe('A phone number can only contain digits.');
  });
});
