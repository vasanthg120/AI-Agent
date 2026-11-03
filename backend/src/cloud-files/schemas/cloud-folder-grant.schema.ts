import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CloudFolderGrantDocument = CloudFolderGrant & Document<Types.ObjectId>;

// A folder of the organization's company account opened to some roles. People in
// those roles see that folder and everything below it — nothing else of the
// account. Owners and admins see the whole account and set these.
@Schema({ timestamps: true, collection: 'cloud_folder_grants' })
export class CloudFolderGrant {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true, index: true })
  connectionId: string;

  @Prop({ required: true })
  folderId: string;

  @Prop({ required: true })
  name: string;

  /** Where it is, as it read when granted ("My Drive / Sales / Customers"). */
  @Prop({ default: '' })
  path: string;

  @Prop({ type: [String], default: [] })
  roles: string[];

  /** view: browse, search, download · edit: also upload, make folders, rename, move and delete. */
  @Prop({ default: 'view' })
  access: 'view' | 'edit';

  @Prop()
  grantedBy?: string;
}

export const CloudFolderGrantSchema = SchemaFactory.createForClass(CloudFolderGrant);
CloudFolderGrantSchema.index({ connectionId: 1, folderId: 1 }, { unique: true });
