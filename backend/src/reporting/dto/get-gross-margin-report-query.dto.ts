import { IsIn, Matches } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class GetGrossMarginReportQueryDto {
  @Matches(DATE, { message: 'dateFrom must be YYYY-MM-DD' })
  dateFrom: string;

  @Matches(DATE, { message: 'dateTo must be YYYY-MM-DD' })
  dateTo: string;

  @IsIn(['customer', 'user'])
  groupBy: 'customer' | 'user';
}
