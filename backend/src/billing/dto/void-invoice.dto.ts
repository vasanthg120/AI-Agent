import { IsOptional, IsString } from 'class-validator';

export class VoidInvoiceDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
