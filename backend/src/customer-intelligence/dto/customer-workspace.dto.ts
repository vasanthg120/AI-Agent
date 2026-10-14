import { IsDateString, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// What the team can write on a customer. Lengths are capped here; emptiness
// after trimming is checked in the service.

export class SetCustomerStatusDto {
  @IsIn(['inquiry', 'quote', 'order', 'payment', 'email', 'followUp'])
  stage: 'inquiry' | 'quote' | 'order' | 'payment' | 'email' | 'followUp';

  // One of that step's options, or null: back to what the connected systems say.
  @IsOptional()
  @IsString()
  @MaxLength(40)
  status?: string | null;
}

export class CreateCustomerNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body: string;
}

export class CreateCustomerTaskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  assigneeId?: string;
}

export class UpdateCustomerTaskDto {
  @IsOptional()
  @IsIn(['open', 'done'])
  status?: 'open' | 'done';

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  // null clears the date / the assignee.
  @IsOptional()
  @IsDateString()
  dueDate?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  assigneeId?: string | null;
}
