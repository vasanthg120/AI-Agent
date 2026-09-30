import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { dataSourceScopePlugin } from '../../data-sources/data-source-scope.plugin';

export type ContactDocument = Contact & Document<Types.ObjectId>;

// Field names mirror what python-agent's crm_contact tool already sends/expects
// (see python-agent/app/tools/crm_tool.py) — this is the native backing store
// used when an org hasn't connected an external CRM; keeping the same
// vocabulary means the tool's request/response shape never has to branch on
// which backend it's actually talking to.
@Schema({ timestamps: true, collection: 'crm_contacts' })
export class Contact {
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

  @Prop()
  storeId?: string;

  @Prop()
  firstName?: string;

  @Prop()
  lastName?: string;

  @Prop()
  name?: string;

  @Prop({ index: true })
  email?: string;

  @Prop({ index: true })
  phone?: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop()
  stageId?: string;
}

export const ContactSchema = SchemaFactory.createForClass(Contact);
ContactSchema.plugin(dataSourceScopePlugin);
ContactSchema.index({ organizationId: 1, dataSourceId: 1 });
ContactSchema.index({ organizationId: 1, dataSourceId: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $exists: true } } });
