import { IsArray, IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CREDIT_STATUSES, ITEM_STATUSES, JOB_STATUS_KEYS, JobStatusKey, PROOF_STATUSES, PURCHASE_ORDER_STATUSES, SHIPMENT_STATUSES } from '../job-statuses';

// What the team can write on a job. Lengths are capped here; emptiness after
// trimming, and whether a status is one of its column's options, are checked
// in the service. Where a field may be cleared, null clears it.

const statusesOf = (options: { status: string }[]) => options.map((o) => o.status);

export class ConvertQuotationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  quotationId: string;
}

export class UpdateJobDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string | null;

  // JobBoard spec's "Production" column — a real Vendor (org-scoped,
  // validated in the service), distinct from the `production` status chip
  // above (in_house/outsourced/not_started), which stays untouched.
  @IsOptional()
  @IsString()
  productionHouseVendorId?: string | null;

  // "In Hands date" — separate from dueDate (when the job must be
  // finished): when the finished goods must be physically in the
  // customer's hands.
  @IsOptional()
  @IsDateString()
  inHandsDate?: string | null;

  // JobBoard spec section 12 — a soft ref into the Catalog's own
  // Decoration price list (crm/schemas/decoration.schema.ts), same model
  // SalesBoard's Quote.decorationId already points at.
  @IsOptional()
  @IsString()
  decorationId?: string | null;

  // Multiple vendors on one job (distinct from the single
  // productionHouseVendorId above).
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  vendorIds?: string[];

  // JobBoard spec section 11 — the real Xero invoice this job is linked
  // to, if any, by its human-readable number (e.g. "INV-0342" — what a
  // person actually has on hand, and a valid filter on Xero's own
  // Invoices API, unlike its opaque internal InvoiceID). Set by hand (this
  // app has no automatic Quote/Job -> Xero invoice creation flow), and
  // only ever read back live through Xero's own API — see
  // customer-jobs.service.ts's getXeroInvoiceStatus.
  @IsOptional()
  @IsString()
  @MaxLength(80)
  xeroInvoiceNumber?: string | null;
}

export class SetJobStatusDto {
  @IsIn(JOB_STATUS_KEYS)
  key: JobStatusKey;

  // One of that column's options, or null: not set.
  @IsOptional()
  @IsString()
  @MaxLength(40)
  status?: string | null;

  // Section 16 — required when moving the payment column to a value that
  // asserts remittance was received (see customer-jobs.service.ts's own
  // REMITTANCE_PROOF_REQUIRED). Must name a file already attached to this
  // job.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  proofFileId?: string;
}

export class SetJobVoidedDto {
  @IsBoolean()
  voided: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string | null;
}

export class SetJobItemStatusDto {
  @IsIn(statusesOf(ITEM_STATUSES))
  status: string;
}

export class CreatePurchaseOrderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  vendor: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000_000_000)
  amount?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  reference?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  accountingPoNumber?: string | null;

  @IsOptional()
  @IsIn(statusesOf(PURCHASE_ORDER_STATUSES))
  status?: string;

  @IsOptional()
  @IsDateString()
  orderedAt?: string | null;

  @IsOptional()
  @IsDateString()
  expectedAt?: string | null;

  @IsOptional()
  @IsDateString()
  receivedAt?: string | null;

  @IsOptional()
  @IsDateString()
  deadline?: string | null;

  @IsOptional()
  @IsDateString()
  backorderDueDate?: string | null;
}

export class UpdatePurchaseOrderDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  vendor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000_000_000)
  amount?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  reference?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  accountingPoNumber?: string | null;

  @IsOptional()
  @IsIn(statusesOf(PURCHASE_ORDER_STATUSES))
  status?: string;

  @IsOptional()
  @IsDateString()
  orderedAt?: string | null;

  @IsOptional()
  @IsDateString()
  expectedAt?: string | null;

  @IsOptional()
  @IsDateString()
  receivedAt?: string | null;

  @IsOptional()
  @IsDateString()
  deadline?: string | null;

  @IsOptional()
  @IsDateString()
  backorderDueDate?: string | null;
}

export class CreateShipmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  carrier: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  trackingNumber?: string | null;

  @IsOptional()
  @IsIn(statusesOf(SHIPMENT_STATUSES))
  status?: string;

  @IsOptional()
  @IsDateString()
  shippedAt?: string | null;

  @IsOptional()
  @IsDateString()
  deliveredAt?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class UpdateShipmentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  carrier?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  trackingNumber?: string | null;

  @IsOptional()
  @IsIn(statusesOf(SHIPMENT_STATUSES))
  status?: string;

  @IsOptional()
  @IsDateString()
  shippedAt?: string | null;

  @IsOptional()
  @IsDateString()
  deliveredAt?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class CreateCreditDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  creditNumber?: string | null;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000_000_000)
  amount?: number | null;

  @IsOptional()
  @IsIn(statusesOf(CREDIT_STATUSES))
  status?: string;
}

export class UpdateCreditDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  creditNumber?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000_000_000)
  amount?: number | null;

  @IsOptional()
  @IsIn(statusesOf(CREDIT_STATUSES))
  status?: string;
}

export class SetProofDto {
  @IsIn(statusesOf(PROOF_STATUSES))
  status: string;

  // What to change, when changes are needed.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}
