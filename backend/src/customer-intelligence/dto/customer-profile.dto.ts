import { Type } from 'class-transformer';
import { IsArray, IsEmail, IsIn, IsNumber, IsOptional, IsString, IsUrl, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

// Phase 3 — the first real writes a "customer" can receive. See
// customer-directory.service.ts's own comment on createCustomer/
// updateCustomer for why these stay deliberately thin (name/email/phone/
// company + rep) rather than a full Account-shaped form: everything else a
// customer carries (notes, files, tasks, quotations, jobs) already has its
// own real, working write path keyed by the same customer id.
//
// Hoops-parity Add/Edit Customer — customerType/website/industryType/
// minimumMarkupPct/salesDiscountPct/addresses are new, additive profile
// fields (see customer-directory.service.ts's upsertProfile) — saved in
// HaiVE only, same as repUserId/nameOverride/contacts already are. None of
// them touch crm_contacts or any connected CRM.

export type CustomerType = 'business' | 'individual';
export const CUSTOMER_TYPES: CustomerType[] = ['business', 'individual'];
export const ADDRESS_TYPES = ['billing', 'shipping', 'other'] as const;
export type AddressType = (typeof ADDRESS_TYPES)[number];

export class CustomerAddressDto {
  @IsIn(ADDRESS_TYPES)
  type: AddressType;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  address: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  addressLine2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  state?: string;
}

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

  // Business (company-first form) or Individual (person-first form) — the
  // form the record came from. Defaults to 'business' when company is set,
  // 'individual' otherwise (see createCustomer's own fallback), so this is
  // optional even though the frontend always sends it.
  @IsOptional()
  @IsIn(CUSTOMER_TYPES)
  customerType?: CustomerType;

  @IsOptional()
  @IsUrl({ require_protocol: false })
  @MaxLength(300)
  website?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  industryType?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  minimumMarkupPct?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  salesDiscountPct?: number;

  // Free-text notes about the customer (Hoops' own "Profile" field on the
  // Add/Edit Customer form) — distinct from the computed CustomerProfile
  // this module builds elsewhere, so named profileNote here to avoid any
  // confusion between the two.
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  profileNote?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomerAddressDto)
  addresses?: CustomerAddressDto[];

  // Inline contacts at creation time (Business customers) — the exact same
  // shape addContact's own AddCustomerContactDto takes, declared further
  // down this file; class declarations in a module are safe to reference
  // here since @Type's thunk only runs after the whole file has evaluated.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AddCustomerContactDto)
  contacts?: AddCustomerContactDto[];
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

  @IsOptional()
  @IsIn(CUSTOMER_TYPES)
  customerType?: CustomerType;

  // '' clears a previously-set value back to "not recorded" for all four of these.
  @IsOptional()
  @IsString()
  @MaxLength(300)
  website?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  industryType?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  minimumMarkupPct?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  salesDiscountPct?: number;

  // '' clears it back to "not recorded" — same convention as website/industryType above.
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  profileNote?: string;
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

// Mirrors CustomerAddressDto's own fields exactly (kept as a separate class,
// not a reuse, since this one is the body of its own POST route rather than
// an item inside CreateCustomerDto.addresses).
export class CreateCustomerAddressDto {
  @IsIn(ADDRESS_TYPES)
  type: AddressType;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  address: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  addressLine2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  state?: string;
}
