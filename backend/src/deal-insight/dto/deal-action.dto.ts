import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { DEAL_ACTION_TYPES, DealActionType } from '../deal-insight.service';

/** One action a person approved in the deal panel (see DealInsightService.runAction). */
export class DealActionDto {
  @IsIn(DEAL_ACTION_TYPES)
  type: DealActionType;

  // Made by the page per proposed action: the same key twice runs it once.
  @IsString()
  @Matches(/^[\w:.-]{8,120}$/)
  idempotencyKey: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;
}

export class DealTaskDoneDto {
  @IsBoolean()
  done: boolean;
}
