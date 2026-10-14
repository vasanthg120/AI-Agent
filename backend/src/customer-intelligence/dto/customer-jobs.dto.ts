import { IsDateString, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ITEM_STATUSES, JOB_STATUS_KEYS, JobStatusKey, PROOF_STATUSES, PURCHASE_ORDER_STATUSES, SHIPMENT_STATUSES } from '../job-statuses';

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
}

export class SetJobStatusDto {
  @IsIn(JOB_STATUS_KEYS)
  key: JobStatusKey;

  // One of that column's options, or null: not set.
  @IsOptional()
  @IsString()
  @MaxLength(40)
  status?: string | null;
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

export class SetProofDto {
  @IsIn(statusesOf(PROOF_STATUSES))
  status: string;

  // What to change, when changes are needed.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}
