import { IsNumber, Min } from 'class-validator';

// A platform admin manually confirming "I checked the provider's own
// console — this is really what's left." The one moment
// provider-account.schema.ts's confirmedBalance is ever set.
export class RecordReconciliationDto {
  @IsNumber()
  @Min(0)
  confirmedBalance: number;
}
