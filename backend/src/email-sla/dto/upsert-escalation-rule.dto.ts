import { IsBoolean, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class UpsertEscalationRuleDto {
  @IsString()
  @MinLength(1)
  priority: string;

  @IsInt()
  @Min(1)
  escalationLevel: number;

  @IsInt()
  @Min(0)
  delayMinutes: number;

  @IsOptional() @IsBoolean() notifyAssignedUser?: boolean;
  @IsOptional() @IsBoolean() notifyManager?: boolean;
  @IsOptional() @IsBoolean() notifyAdmin?: boolean;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
