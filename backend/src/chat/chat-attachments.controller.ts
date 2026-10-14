import { Controller, Delete, ForbiddenException, Get, Param, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UPLOAD_FILE_INTERCEPTOR_OPTIONS } from '../common/upload-limits';
import { ChatAttachmentsService } from './chat-attachments.service';

// Documents attached in the AI chat: uploaded here first (validated, text
// extracted, stored encrypted), then referenced by id when the message is
// sent (SendMessageDto.attachmentIds). Every mutating call is recorded by the
// global AuditInterceptor.
@UseGuards(JwtAuthGuard)
@Controller('chat/attachments')
export class ChatAttachmentsController {
  constructor(private attachments: ChatAttachmentsService) {}

  // What the chat input enforces before uploading (the server enforces it again).
  @Get('limits')
  limits() {
    return this.attachments.limits;
  }

  @Post()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', UPLOAD_FILE_INTERCEPTOR_OPTIONS))
  upload(@CurrentUser() user: JwtPayload, @Req() req: Request, @UploadedFile() file: Express.Multer.File) {
    // Same switch as sending a message: no AI access, nothing to attach to.
    if (user.aiAccessEnabled === false) {
      throw new ForbiddenException('AI access has been disabled for your account by an administrator.');
    }
    const bearerToken = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    return this.attachments.upload(user.sub, user.organizationId, bearerToken, file);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.attachments.remove(user.sub, user.organizationId, id);
    return { status: 'ok' };
  }
}
