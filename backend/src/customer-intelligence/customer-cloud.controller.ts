import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UploadedFile, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CloudErrorFilter } from '../cloud-files/cloud-error.filter';
import { sendCloudFile } from '../cloud-files/cloud-response';
import { Feature } from '../common/app-features';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CLOUD_UPLOAD_INTERCEPTOR_OPTIONS } from '../common/upload-limits';
import { CustomerCloudService } from './customer-cloud.service';
import {
  AttachCloudFilesDto,
  CustomerFolderItemsQueryDto,
  CustomerFolderSearchQueryDto,
  CustomerSubfolderDto,
  InlineQueryDto,
  LinkCustomerFolderDto,
  UpdateCloudLinkDto,
} from './dto/customer-cloud.dto';

// A customer's Google Drive / OneDrive documents, from the Customers panel. Same
// audience as the page; every call is scoped to the caller's organization and to
// that one customer's identity keys (customer-cloud.service.ts says who may open
// what), and every change is audited.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin', 'manager')
@Feature('inquiries')
@UseFilters(CloudErrorFilter)
@Controller()
export class CustomerCloudController {
  constructor(private cloud: CustomerCloudService) {}

  @Get('customers/:id/cloud')
  overview(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.cloud.overview(user, id);
  }

  @Post('customers/:id/cloud/folders')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  linkFolder(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: LinkCustomerFolderDto) {
    if (dto.folderId) return this.cloud.linkFolder(user, id, dto.connectionId, dto.folderId);
    return this.cloud.createFolder(user, id, dto.connectionId, dto.parentId ?? '', dto.name ?? '', !!dto.subfolders);
  }

  @Delete('customers/:id/cloud/folders/:mappingId')
  async unlinkFolder(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('mappingId') mappingId: string) {
    await this.cloud.unlinkFolder(user, id, mappingId);
    return { status: 'ok' };
  }

  @Get('customers/:id/cloud/folders/:mappingId/items')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  browse(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('mappingId') mappingId: string, @Query() query: CustomerFolderItemsQueryDto) {
    return this.cloud.browse(user, id, mappingId, query);
  }

  @Get('customers/:id/cloud/folders/:mappingId/search')
  search(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('mappingId') mappingId: string, @Query() query: CustomerFolderSearchQueryDto) {
    return this.cloud.search(user, id, mappingId, query.q, query.type);
  }

  @Get('customers/:id/cloud/folders/:mappingId/items/:itemId/preview')
  folderPreview(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('mappingId') mappingId: string, @Param('itemId') itemId: string) {
    return this.cloud.folderPreview(user, id, mappingId, itemId);
  }

  @Get('customers/:id/cloud/folders/:mappingId/items/:itemId/content')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async folderContent(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('mappingId') mappingId: string,
    @Param('itemId') itemId: string,
    @Query() query: InlineQueryDto,
    @Res() res: Response,
  ) {
    const inline = !!query.inline;
    sendCloudFile(res, await this.cloud.folderItem(user, id, mappingId, itemId, inline), inline);
  }

  @Post('customers/:id/cloud/folders/:mappingId/folders')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  subfolder(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('mappingId') mappingId: string, @Body() dto: CustomerSubfolderDto) {
    return this.cloud.createSubfolder(user, id, mappingId, dto.parentId, dto.name);
  }

  @Post('customers/:id/cloud/folders/:mappingId/upload')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', CLOUD_UPLOAD_INTERCEPTOR_OPTIONS))
  // The folder is read as one plain field (checked by the service) so that a refused body never leaves the upload on disk.
  upload(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('mappingId') mappingId: string, @Body('parentId') parentId: unknown, @UploadedFile() file: Express.Multer.File) {
    return this.cloud.upload(user, id, mappingId, typeof parentId === 'string' ? parentId.slice(0, 600) : '', file);
  }

  @Post('customers/:id/cloud/links')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  attach(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: AttachCloudFilesDto) {
    return this.cloud.attach(user, id, dto.connectionId, dto.fileIds, dto.category, dto.quotationId);
  }

  @Patch('customers/:id/cloud/links/:linkId')
  updateLink(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('linkId') linkId: string, @Body() dto: UpdateCloudLinkDto) {
    return this.cloud.updateLink(user, id, linkId, dto);
  }

  @Delete('customers/:id/cloud/links/:linkId')
  async removeLink(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('linkId') linkId: string) {
    await this.cloud.removeLink(user, id, linkId);
    return { status: 'ok' };
  }

  @Get('customers/:id/cloud/links/:linkId/preview')
  linkPreview(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('linkId') linkId: string) {
    return this.cloud.linkPreview(user, id, linkId);
  }

  @Get('customers/:id/cloud/links/:linkId/content')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async linkContent(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('linkId') linkId: string, @Query() query: InlineQueryDto, @Res() res: Response) {
    const inline = !!query.inline;
    sendCloudFile(res, await this.cloud.linkContent(user, id, linkId, inline), inline);
  }

  @Post('customers/:id/cloud/links/:linkId/copy')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  copy(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('linkId') linkId: string) {
    return this.cloud.copyIntoHaive(user, id, linkId);
  }

  // HaiVE's own customer files, across customers — the Files page's "HaiVE uploads".
  @Get('customer-files')
  haiveFiles(@CurrentUser() user: JwtPayload) {
    return this.cloud.haiveFiles(user);
  }
}
