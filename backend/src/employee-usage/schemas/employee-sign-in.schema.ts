import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { USAGE_RETENTION_SECONDS } from './employee-usage-hour.schema';

export type EmployeeSignInDocument = EmployeeSignIn & Document<Types.ObjectId>;

export type SignInKind = 'sign_in' | 'sign_out' | 'switch_in';

// When someone signed in to HaiVE, signed out, or moved into another business
// (the Main Account owner entering a sub-account). Written by AuthService as it
// happens — nothing before this log existed is invented. A session that simply
// expires has no sign-out.
@Schema({ collection: 'employee_sign_ins', versionKey: false })
export class EmployeeSignIn {
  @Prop({ required: true })
  organizationId: string;

  @Prop({ required: true })
  userId: string;

  @Prop({ required: true, enum: ['sign_in', 'sign_out', 'switch_in'] })
  kind: SignInKind;

  @Prop({ required: true })
  at: Date;

  // The session (JWT id): pairs a sign-out with its sign-in.
  @Prop()
  jti?: string;

  @Prop()
  device?: string;

  @Prop()
  location?: string;
}

export const EmployeeSignInSchema = SchemaFactory.createForClass(EmployeeSignIn);
EmployeeSignInSchema.index({ organizationId: 1, userId: 1, at: -1 });
EmployeeSignInSchema.index({ at: 1 }, { expireAfterSeconds: USAGE_RETENTION_SECONDS });
