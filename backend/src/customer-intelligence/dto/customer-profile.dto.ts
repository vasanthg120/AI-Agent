import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// Phase 3 — the first real writes a "customer" can receive. See
// customer-directory.service.ts's own comment on createCustomer/
// updateCustomer for why these stay deliberately thin (name/email/phone/
// company + rep) rather than a full Account-shaped form: everything else a
// customer carries (notes, files, tasks, quotations, jobs) already has its
// own real, working write path keyed by the same customer id.

export class CreateCustomerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  company?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  repUserId?: string;

  // The duplicate check (createCustomer) found a likely-matching existing
  // customer and returned it instead of creating a new one; the caller
  // re-sends the same request with this set to proceed anyway. Never
  // trusted to skip the check itself — only to accept its outcome.
  @IsOptional()
  confirmDuplicate?: boolean;
}

export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  company?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  // '' clears the assignment back to the derived (quote/deal) owner.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  repUserId?: string;
}

export class AddCustomerContactDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  role?: string;
}
