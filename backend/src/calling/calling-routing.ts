// Which provider places a call. Plivo is the domestic carrier (Indian numbers,
// Indian compliance); Twilio covers the rest of the world. When only one is
// available to the caller it is used for everything; an explicit choice wins
// when that provider is available. Pure, so the browser's preview of "this call
// will go via …" and the server's decision are the same rule (mirrored in
// frontend/src/services/callingService.ts).

export type CallingProvider = 'plivo' | 'twilio';

export function chooseProvider(
  customerDigits: string,
  available: CallingProvider[],
  domesticCountryCode: string,
  requested?: CallingProvider,
): CallingProvider | null {
  if (requested) return available.includes(requested) ? requested : null;
  const domestic = customerDigits.startsWith(domesticCountryCode);
  const order: CallingProvider[] = domestic ? ['plivo', 'twilio'] : ['twilio', 'plivo'];
  return order.find((p) => available.includes(p)) ?? null;
}
