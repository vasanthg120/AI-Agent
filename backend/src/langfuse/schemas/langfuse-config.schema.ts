import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LangfuseConfigDocument = LangfuseConfig & Document;

// One platform-wide document (organizationId: 'platform', same sentinel
// IntegrationsService's PLATFORM_INTEGRATION_SCOPE uses for Anthropic/Groq/
// Gmail/Outlook/Zoho/Xero platform app credentials) — Langfuse is configured
// once for the whole HaiVE deployment, not per customer organization, same
// as every other platform-level provider. A dedicated schema rather than an
// IntegrationCredential row: that schema is OAuth/API-key shaped and has no
// typed home for enabled/connectionStatus/samplingRate/captureInputOutput,
// which would just be irrelevant noise on every other provider's row.
@Schema({ collection: 'langfuse_config', timestamps: true })
export class LangfuseConfig {
  @Prop({ required: true, unique: true, default: 'platform' })
  organizationId: string;

  // Both encrypted via EncryptionService (AES-256-GCM), same as every other
  // provider's secret in this app — the public key isn't inherently
  // sensitive by Langfuse's own design, but the admin spec asks for a masked
  // display after saving, and encrypting both costs nothing extra while
  // keeping one uniform at-rest convention.
  @Prop()
  publicKeyEncrypted?: string;

  @Prop()
  secretKeyEncrypted?: string;

  @Prop({ default: 'https://cloud.langfuse.com' })
  baseUrl: string;

  @Prop({ enum: ['development', 'staging', 'production'], default: 'production' })
  environment: 'development' | 'staging' | 'production';

  @Prop({ default: false })
  enabled: boolean;

  @Prop({ default: 100, min: 0, max: 100 })
  samplingRate: number;

  @Prop({ default: true })
  captureInputOutput: boolean;

  @Prop({ enum: ['untested', 'connected', 'error'], default: 'untested' })
  connectionStatus: 'untested' | 'connected' | 'error';

  @Prop()
  lastTestedAt?: Date;

  // Set only from a real trace-emission confirmation (python-agent), never
  // fabricated from a successful Test Connection alone — see
  // ai-usage-admin.service.ts's own "never fake providerReconciliationAvailable"
  // precedent for the same honesty standard applied here.
  @Prop()
  lastSuccessfulTraceAt?: Date;

  @Prop()
  errorMessage?: string;
}

export const LangfuseConfigSchema = SchemaFactory.createForClass(LangfuseConfig);
