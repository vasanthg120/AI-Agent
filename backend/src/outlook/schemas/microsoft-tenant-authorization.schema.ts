import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type MicrosoftTenantAuthorizationDocument = MicrosoftTenantAuthorization & Document<Types.ObjectId>;

// Informational record only — Microsoft/Azure AD itself is the actual
// authority on whether an org's tenant has granted admin consent (once it
// has, every subsequent employee's normal "Connect Outlook" click succeeds
// without hitting the interactive consent wall, entirely on Microsoft's
// side; nothing in this app needs to branch on this field to make that
// work). This just lets the UI show "your organization has approved this
// app" instead of every admin having to remember whether they already did
// it. One doc per Azure AD tenant (not per Pantheras organizationId) since
// the same Microsoft tenant could theoretically span org boundaries here.
@Schema({ timestamps: true, collection: 'microsoft_tenant_authorizations' })
export class MicrosoftTenantAuthorization {
  // Indexed by the unique index below only — a second, plain `index: true`
  // shares its name, and whichever is built first wins (uniqueness was lost).
  @Prop({ required: true })
  tenantId: string;

  @Prop({ required: true })
  organizationId: string;

  @Prop({ required: true })
  authorizedByUserId: string;

  @Prop({ required: true })
  authorizedByEmail: string;
}

export const MicrosoftTenantAuthorizationSchema = SchemaFactory.createForClass(MicrosoftTenantAuthorization);
MicrosoftTenantAuthorizationSchema.index({ tenantId: 1 }, { unique: true });
