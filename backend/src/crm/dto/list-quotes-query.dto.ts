import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListQuotesQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  salesStatus?: string;

  @IsOptional()
  @IsString()
  classification?: string;

  @IsOptional()
  @IsString()
  paymentInvoiceStatus?: string;

  @IsOptional()
  @IsString()
  orderStatus?: string;

  @IsOptional()
  @IsString()
  paymentStatus?: string;

  @IsOptional()
  @IsString()
  deliveryStatus?: string;

  @IsOptional()
  @IsString()
  artworkStatus?: string;

  @IsOptional()
  @IsString()
  productionReadyStatus?: string;

  @IsOptional()
  @IsString()
  completedStatus?: string;

  @IsOptional()
  @IsString()
  productionHouseVendorId?: string;

  @IsOptional()
  @IsString()
  vendorId?: string;

  @IsOptional()
  @IsString()
  decorationId?: string;

  @IsOptional()
  @IsString()
  customerType?: string;

  @IsOptional()
  @IsString()
  ownerUserId?: string;

  @IsOptional()
  @IsString()
  createdByUserId?: string;

  @IsOptional()
  @IsString()
  deadlineFrom?: string;

  @IsOptional()
  @IsString()
  deadlineTo?: string;

  @IsOptional()
  @IsString()
  deliveryDateFrom?: string;

  @IsOptional()
  @IsString()
  deliveryDateTo?: string;

  @IsOptional()
  @IsString()
  paymentDeadlineFrom?: string;

  @IsOptional()
  @IsString()
  paymentDeadlineTo?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsNumber()
  totalMin?: number;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsNumber()
  totalMax?: number;

  @IsOptional()
  @IsIn(['only', 'missing'])
  hasReference?: 'only' | 'missing';

  @IsOptional()
  @IsIn(['only', 'unviewed'])
  viewed?: 'only' | 'unviewed';

  @IsOptional()
  @IsString()
  sort?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  direction?: 'asc' | 'desc';

  @IsOptional()
  @IsIn(['only', 'include'])
  archived?: 'only' | 'include';

  @IsOptional()
  @IsString()
  dateFrom?: string;

  @IsOptional()
  @IsString()
  dateTo?: string;

  @IsOptional()
  @IsString()
  clientApprovalStatus?: string;

  @IsOptional()
  @IsString()
  quoteStatus?: string;

  // Owner/admin only — ignored (never trusted) for manager/consultant.
  @IsOptional()
  @IsString()
  storeId?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
