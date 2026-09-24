import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type IntegrationCredentialDocument = IntegrationCredential & Document<Types.ObjectId>;

@Schema({ timestamps: true, collection: 'integration_credentials' })
export class IntegrationCredential {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true })
  provider: string;

  // Required historically (the only auth style that existed: apiKey +
  // optional baseUrl, used by the 'anthropic'/'crm' providers). Relaxed to
  // optional so newer auth types (bearer/basic/customHeaders — see
  // ../auth-methods.ts) that have no meaningful "apiKey" value can omit it;
  // every existing row already has one populated, so this is additive, not
  // a migration.
  @Prop()
  apiKey?: string;

  @Prop()
  baseUrl?: string;

  // Which shape `credentialsEncrypted` below is decrypted into — undefined
  // on every row written before this existed, which callers should treat as
  // the original apiKey(+baseUrl) style (see IntegrationsService.status).
  @Prop()
  authType?: 'apiKey' | 'apiKeyBaseUrl' | 'bearer' | 'basic' | 'customHeaders';

  // Encrypted (see common/encryption/encryption.service.ts) JSON blob of
  // AuthCredentials (../auth-methods.ts) — bearerToken/username+password/
  // custom headers, whichever authType above needs. The legacy `apiKey`
  // field above is plaintext and untouched for backward compatibility;
  // encryption only applies to auth data going through this newer path.
  @Prop()
  credentialsEncrypted?: string;

  // Optional path (e.g. "/health", "/ping") appended to baseUrl for the
  // Test Connection button — POST /integrations/:provider/test. Empty means
  // "just hit baseUrl itself".
  @Prop()
  healthCheckPath?: string;

  // Admin-configured spend budget for this credential (currently only set
  // for the 'anthropic' platform credential, from the AI Usage admin page).
  // This is Haive's own tracking target, NOT an authoritative balance from
  // the provider — the Anthropic API for a plain API key exposes no account
  // balance, so "remaining" is always budgetUsd minus Haive's own recorded
  // spend (see ai-usage-admin.service.ts), never claimed as provider truth.
  @Prop({ type: Number })
  budgetUsd?: number;

  @Prop({ enum: ['monthly', 'total'], default: 'monthly' })
  budgetPeriod?: 'monthly' | 'total';
}

export const IntegrationCredentialSchema = SchemaFactory.createForClass(IntegrationCredential);
// One credential per (org, provider) — was a single global doc per provider
// shared by the entire deployment, which meant every tenant's chat agent
// used the same Anthropic/CRM key. Compound-unique replaces the old
// field-level `unique: true` on `provider` alone.
IntegrationCredentialSchema.index({ organizationId: 1, provider: 1 }, { unique: true });
