import { FileInterceptor } from '@nestjs/platform-express';
import {
  Controller,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { UPLOAD_FILE_INTERCEPTOR_OPTIONS } from '../common/upload-limits';
import { DocumentsService } from './documents.service';
import { Permission } from '../common/permissions/permission.decorator';

@UseGuards(JwtAuthGuard)
@Permission('ai_agent', 'create')
@Controller('documents')
export class DocumentsController {
  constructor(private documentsService: DocumentsService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', UPLOAD_FILE_INTERCEPTOR_OPTIONS))
  upload(
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const bearerToken = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    return this.documentsService.ingest(user.sub, bearerToken, file);
  }
}
