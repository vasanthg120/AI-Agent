import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes, Types } from 'mongoose';
import type { CrmModule, CrmProviderId, FieldMappings, StatusMapping, Terminology } from '../provider-catalog';

export type DataSourceDocument = DataSource & Document<Types.ObjectId>;

export type DataSourceStatus = 'active' | 'disconnected';
export type SyncState = 'never' | 'running' | 'ok' | 'error';

export interface StageMapping {
  // The CRM's own stage id/name.
  value: string;
  // What people should see.
  label: string;
  category: 'open' | 'won' | 'lost';
}

// One CRM an organization takes data from — its own identity, configuration,
// field mappings and sync state. Every CRM record HaiVE stores (crm_deals,
// crm_quotes, crm_contacts, crm_accounts) carries the id of the data source it
// came from, which is what keeps two CRMs' data from ever being mixed up.
@Schema({ timestamps: true, collection: 'crm_data_sources' })
export class DataSource {
  @Prop({ required: true, index: true })
  organizationId: string;

  // Stable per-organization key ("haive", "prospectconnect", "hubspot"…).
  @Prop({ required: true })
  key: string;

  @Prop({ required: true })
  provider: CrmProviderId;

  // Editable display name.
  @Prop({ required: true })
  label: string;

  // The integration_credentials row this source reads through (provider name
  // and id) — absent for the built-in HaiVE workspace source.
  @Prop()
  integrationProvider?: string;

  @Prop()
  connectionId?: string;

  @Prop({ default: 'active', enum: ['active', 'disconnected'] })
  status: DataSourceStatus;

  // The source dashboards show when nobody has picked one.
  @Prop({ default: false })
  isDefault: boolean;

  // Which of the CRM's modules HaiVE uses (and so which metrics it can show).
  @Prop({ type: [String], default: [] })
  modules: CrmModule[];

  @Prop({ type: SchemaTypes.Mixed, default: {} })
  terminology: Terminology;

  // Per module: HaiVE canonical field -> the CRM's field path ("properties.amount").
  @Prop({ type: SchemaTypes.Mixed, default: {} })
  fieldMappings: FieldMappings;

  @Prop({ type: SchemaTypes.Mixed, default: { won: [], lost: [] } })
  statusMapping: StatusMapping;

  @Prop({ type: [SchemaTypes.Mixed], default: [] })
  stageMappings: StageMapping[];

  // Field paths actually seen on this CRM's records during sync, per module —
  // offered as choices in the mapping editor.
  @Prop({ type: SchemaTypes.Mixed, default: {} })
  availableFields: Partial<Record<string, string[]>>;

  @Prop({
    type: SchemaTypes.Mixed,
    default: { enabled: true, intervalMinutes: 10, lastStatus: 'never' },
  })
  sync: {
    enabled: boolean;
    intervalMinutes: number;
    lastSyncAt?: Date;
    lastStatus: SyncState;
    lastError?: string;
    lastCounts?: Record<string, number>;
  };

  @Prop({ type: SchemaTypes.Mixed, default: {} })
  metadata: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
}

export const DataSourceSchema = SchemaFactory.createForClass(DataSource);
DataSourceSchema.index({ organizationId: 1, key: 1 }, { unique: true });
