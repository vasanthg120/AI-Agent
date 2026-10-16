// Zoho's documented regional data centers, each with a completely separate
// accounts server AND a completely separate app registry — a client_id
// registered in one DC's API Console is only ever valid against that same
// DC's accounts server (confirmed root cause of this integration's original
// HTTP 400: the platform default pointed at .com while a customer's app was
// registered on a different DC). Used by both the "Connect Zoho CRM"
// credential modal's region dropdown and zoho.service.ts's URL building —
// one source of truth so the two can never drift.
//
// Not exhaustive by design (Zoho adds regions occasionally) — the DTO/UI
// also accept region: 'other' with a raw accounts-server URL for anything
// not listed here, so this app never hardcodes "every customer is on one of
// these" (see SaveZohoAppCredentialsDto).
export const ZOHO_DATA_CENTERS: Record<string, { label: string; accountsBaseUrl: string }> = {
  us: { label: 'United States (.com)', accountsBaseUrl: 'https://accounts.zoho.com' },
  eu: { label: 'Europe (.eu)', accountsBaseUrl: 'https://accounts.zoho.eu' },
  in: { label: 'India (.in)', accountsBaseUrl: 'https://accounts.zoho.in' },
  au: { label: 'Australia (.com.au)', accountsBaseUrl: 'https://accounts.zoho.com.au' },
  jp: { label: 'Japan (.jp)', accountsBaseUrl: 'https://accounts.zoho.jp' },
  ca: { label: 'Canada (.ca)', accountsBaseUrl: 'https://accounts.zoho.ca' },
};

export function accountsBaseUrlForRegion(region: string, accountsServerUrlOverride?: string): string {
  if (region === 'other') {
    if (!accountsServerUrlOverride) throw new Error('accountsServerUrl is required when region is "other".');
    return accountsServerUrlOverride.replace(/\/$/, '');
  }
  const dc = ZOHO_DATA_CENTERS[region];
  if (!dc) throw new Error(`Unknown Zoho data center "${region}".`);
  return dc.accountsBaseUrl;
}
