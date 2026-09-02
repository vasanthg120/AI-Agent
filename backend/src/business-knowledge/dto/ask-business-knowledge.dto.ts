import { IsString, MinLength } from 'class-validator';

export class AskBusinessKnowledgeDto {
  @IsString()
  @MinLength(1)
  question: string;
}
