import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { dataSourceScopePlugin } from '../../data-sources/data-source-scope.plugin';

export type AccountDocument = Account & Document<Types.ObjectId>;

@Schema({ timestamps: true, collection: 'crm_accounts' })
export class Account {
  @Prop({ required: true, index: true })
  organizationId: string;

  // The data source (CRM) this record came from — see
  // data-sources/schemas/data-source.schema.ts. Reads are scoped by it
  // automatically (dataSourceScopePlugin), so two CRMs' records never mix.
  @Prop({ index: true })
  dataSourceId?: string;

  // The record's own id in the CRM it was synced from; absent for records
  // created in HaiVE.
  @Prop()
  externalId?: string;

  @Prop({ required: true })
  name: string;

  @Prop()
  domain?: string;

  @Prop()
  city?: string;

  @Prop()
  industry?: string;

  @Prop()
  revenue?: number;
}

export const AccountSchema = SchemaFactory.createForClass(Account);
AccountSchema.plugin(dataSourceScopePlugin);
AccountSchema.index({ organizationId: 1, dataSourceId: 1 });
AccountSchema.index({ organizationId: 1, dataSourceId: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $exists: true } } });
