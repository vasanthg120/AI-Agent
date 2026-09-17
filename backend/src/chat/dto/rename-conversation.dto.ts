import { IsString, MaxLength, MinLength } from 'class-validator';

export class RenameConversationDto {
  @IsString() @MinLength(1) @MaxLength(200) title: string;
}
