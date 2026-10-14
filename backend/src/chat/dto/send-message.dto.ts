import { ArrayMaxSize, IsArray, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

// 8000 chars comfortably covers a real pasted email thread/document excerpt
// (this app's actual chat use cases) while still bounding the per-call LLM
// token cost — previously unbounded, so a single request could forward an
// arbitrarily large payload straight to python-agent.
const MAX_MESSAGE_LENGTH = 8000;

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_MESSAGE_LENGTH)
  message: string;

  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsOptional()
  @IsString()
  agentId?: string;

  // Documents uploaded through POST /chat/attachments to send with this
  // message (ChatAttachmentsService.attach checks they are the caller's own).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsMongoId({ each: true })
  attachmentIds?: string[];
}
