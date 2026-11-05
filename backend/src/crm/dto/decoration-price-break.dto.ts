import { IsNumber, Min } from 'class-validator';

export class DecorationPriceBreakDto {
  @IsNumber()
  @Min(1)
  quantity: number;

  @IsNumber()
  @Min(0)
  price: number;
}
