import { useEffect, useState } from 'react';

// The value, but only once it has stopped changing for `delayMs` — so a search
// box can drive a server query without firing one request per keystroke.
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
