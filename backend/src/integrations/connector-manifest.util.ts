import { AuthCredentials, AuthType } from './auth-methods';

export interface ManifestAuthShape {
  type?: string;
  location?: string;
  header_name?: string;
  value_template?: string;
}

export interface ManifestSecretInput {
  apiKeyValue?: string;
  username?: string;
  password?: string;
}

const BEARER_TEMPLATE = /^Bearer\s*\{\{\s*api_key\s*\}\}$/i;
const BARE_TOKEN_TEMPLATE = /^\{\{\s*api_key\s*\}\}$/i;

/** Maps a connector manifest's `auth` block (a template describing how the
 * *provider* wants its key sent — header name + value shape, e.g.
 * `{"header_name": "Authorization", "value_template": "Bearer {{api_key}}"}`)
 * onto one of auth-methods.ts's 5 existing AuthTypes. This mapping is the
 * one genuinely new piece of logic the import feature needs — header
 * construction, encryption, and execution are all pure reuse of the
 * already-working generic connector engine. */
export function resolveManifestAuthType(auth: ManifestAuthShape): AuthType {
  if (auth.type === 'basic') return 'basic';

  const headerName = (auth.header_name || 'Authorization').trim();
  const template = (auth.value_template || '{{api_key}}').trim();

  if (headerName.toLowerCase() === 'authorization' && BEARER_TEMPLATE.test(template)) {
    return 'bearer';
  }
  if (headerName.toLowerCase() !== 'authorization' && BARE_TOKEN_TEMPLATE.test(template)) {
    return 'apiKey';
  }
  // Anything else (a raw Authorization value with no Bearer scheme, or a
  // custom header wrapping the key in extra literal text) doesn't cleanly
  // fit apiKey/bearer's fixed shapes — preserve it exactly via customHeaders
  // rather than guessing at a lossy approximation.
  return 'customHeaders';
}

/** Builds the AuthCredentials shape connectWithAuth() needs, given the
 * authType resolveManifestAuthType() picked and the raw secret(s) the
 * importer typed in — never taken from the manifest itself, which only ever
 * carries an auth *template*, never a live key. */
export function buildManifestCredentials(
  authType: AuthType,
  auth: ManifestAuthShape,
  secrets: ManifestSecretInput,
): AuthCredentials {
  switch (authType) {
    case 'bearer':
      return { bearerToken: secrets.apiKeyValue ?? '' };
    case 'apiKey':
    case 'apiKeyBaseUrl':
      return { apiKey: secrets.apiKeyValue ?? '', headerName: auth.header_name };
    case 'basic':
      return { username: secrets.username ?? '', password: secrets.password ?? '' };
    case 'customHeaders': {
      const headerName = (auth.header_name || 'Authorization').trim();
      const template = auth.value_template || '{{api_key}}';
      const value = template.replace(/\{\{\s*api_key\s*\}\}/gi, secrets.apiKeyValue ?? '');
      return { headers: { [headerName]: value } };
    }
    case 'oauth2':
      // Unreachable in practice: resolveManifestAuthType() above never
      // returns 'oauth2' — a connector manifest only ever describes a static
      // header/token template (see its own doc comment), never a full OAuth
      // consent flow. Zoho/Salesforce's real OAuth (../zoho/, ../salesforce/)
      // bypasses this whole file. Only present so this switch stays
      // exhaustive against auth-methods.ts's AuthType union.
      throw new Error('OAuth2 connections cannot be created by importing a connector manifest.');
  }
}
