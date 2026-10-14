import { FileInterceptor } from '@nestjs/platform-express';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { UPLOAD_FILE_INTERCEPTOR_OPTIONS } from '../common/upload-limits';
import { BusinessKnowledgeDocumentListQueryDto } from './dto/business-knowledge-document-list-query.dto';
import { UpdateBusinessKnowledgeDocumentDto } from './dto/update-business-knowledge-document.dto';
import { BusinessKnowledgeDocumentsService } from './business-knowledge-documents.service';
import { Feature } from '../common/app-features';

// Reads (list/get/file) are CRM-dashboard-tier (owner/admin/manager) —
// mutations (upload/patch/delete/retry) are owner/admin only, matching
// business-profile.controller.ts's identical split (see Phase 14a plan
// notes). Route order matters: 'query' is a static segment and must be
// registered before ':id', same rule as crm/deals.controller.ts.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin', 'manager')
@Feature('business_knowledge')
@Controller('business-knowledge/documents')
export class BusinessKnowledgeDocumentsController {
  constructor(private documentsService: BusinessKnowledgeDocumentsService) {}

  @Post()
  @Roles('owner', 'admin')
  @UseInterceptors(FileInterceptor('file', UPLOAD_FILE_INTERCEPTOR_OPTIONS))
  upload(@CurrentUser() user: JwtPayload, @UploadedFile() file: Express.Multer.File) {
    return this.documentsService.upload(user.organizationId, user.sub, file);
  }

  @Get('query')
  listFiltered(@CurrentUser() user: JwtPayload, @Query() query: BusinessKnowledgeDocumentListQueryDto) {
    return this.documentsService.listFiltered(user.organizationId, query);
  }

  @Get(':id')
  getOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.documentsService.findOne(id, user.organizationId);
  }

  @Get(':id/file')
  async getFile(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Res() res: Response) {
    const { stream, doc } = await this.documentsService.getFileStream(id, user.organizationId);
    res.set({
      'Content-Type': doc.mimeType,
      'Content-Disposition': `inline; filename="${doc.originalFilename}"`,
    });
    stream.pipe(res);
  }

  @Patch(':id')
  @Roles('owner', 'admin')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateBusinessKnowledgeDocumentDto) {
    return this.documentsService.update(id, user.organizationId, user.sub, dto);
  }

  @Post(':id/retry-extraction')
  @Roles('owner', 'admin')
  retryExtraction(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.documentsService.retryExtraction(id, user.organizationId, user.sub);
  }

  @Delete(':id')
  @Roles('owner', 'admin')
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.documentsService.remove(id, user.organizationId);
  }
}
