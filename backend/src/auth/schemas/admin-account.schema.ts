import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AdminAccountDocument = AdminAccount & Document<Types.ObjectId>;

// A fully separate credential store from User — an admin account is never a
// repurposed customer account. No organizationId, no roles array: existing
// in this collection (with active:true) IS the credential. See
// AdminJwtStrategy for how this is validated on every request.
@Schema({ timestamps: true, collection: 'platform_admins' })
export class AdminAccount {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true })
  passwordHash: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ default: true })
  active: boolean;
}

export const AdminAccountSchema = SchemaFactory.createForClass(AdminAccount);
