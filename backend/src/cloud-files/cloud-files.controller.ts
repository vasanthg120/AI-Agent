import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Redirect, Res, UploadedFile, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CLOUD_UPLOAD_INTERCEPTOR_OPTIONS, CLOUD_UPLOAD_SIZE_LIMIT_BYTES } from '../common/upload-limits';
import { CloudConnectionsService } from './cloud-connections.service';
import { CloudErrorFilter } from './cloud-error.filter';
import { CloudFilesService, GRANTABLE_ROLES } from './cloud-files.service';
import { sendCloudFile } from './cloud-response';
import { ROOT_REF } from './cloud-files.types';
import {
  ConnectQueryDto,
  ContentQueryDto,
  CreateFolderDto,
  ItemQueryDto,
  ListItemsQueryDto,
  SearchQueryDto,
  SetFolderGrantsDto,
  UpdateItemDto,
} from './dto/cloud-files.dto';

// Google Drive and OneDrive for the signed-in person. Which account and which
// folders they may open is decided per call by CloudAccessService; tokens never
// leave the backend. Changes are also recorded by the global AuditInterceptor.
@UseFilters(CloudErrorFilter)
@Controller('cloud-files')
export class CloudFilesController {
  constructor(
    private connections: CloudConnectionsService,
    private files: CloudFilesService,
  ) {}

  // ---- accounts ----------------------------------------------------------------------

  @UseGuards(JwtAuthGuard)
  @Get('providers')
  async providers(@CurrentUser() user: JwtPayload) {
    return { providers: await this.connections.overview(user), grantableRoles: GRANTABLE_ROLES, maxUploadBytes: CLOUD_UPLOAD_SIZE_LIMIT_BYTES };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':provider/connect-url')
  connectUrl(@CurrentUser() user: JwtPayload, @Param('provider') provider: string, @Query() query: ConnectQueryDto) {
    return { url: this.connections.connectUrl(user, provider, query.ownership ?? 'personal') };
  }

  // Google returns here. (OneDrive returns to /outlook/callback — the address already registered with Microsoft.)
  @Get('google/callback')
  @Redirect()
  async googleCallback(@Query('code') code?: string, @Query('state') state?: string, @Query('error') error?: string) {
    const cloud = this.connections.readState(state);
    if (!cloud || cloud.provider !== 'google_drive') return { url: this.connections.backTo('google_drive', 'error'), statusCode: 302 };
    return { url: await this.connections.finish(cloud, code, error), statusCode: 302 };
  }

  @UseGuards(JwtAuthGuard)
  @Delete('connections/:id')
  async disconnect(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.connections.disconnect(user, id);
    return { status: 'ok' };
  }

  // ---- files and folders ---------------------------------------------------------------

  @UseGuards(JwtAuthGuard)
  @Get('connections/:id/roots')
  roots(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.files.roots(user, id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('connections/:id/items')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  list(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Query() query: ListItemsQueryDto) {
    return this.files.list(user, id, query.folderId || ROOT_REF, {
      cursor: query.cursor,
      sort: query.sort,
      direction: query.direction,
      type: query.type,
      foldersOnly: !!query.foldersOnly,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Get('connections/:id/search')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  search(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Query() query: SearchQueryDto) {
    return this.files.search(user, id, {
      query: query.q,
      type: query.type,
      modifiedAfter: query.modifiedAfter ? new Date(query.modifiedAfter) : undefined,
      folderId: query.folderId,
      cursor: query.cursor,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Get('connections/:id/items/:itemId')
  item(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('itemId') itemId: string, @Query() query: ItemQueryDto) {
    return this.files.item(user, id, itemId, !!query.path);
  }

  @UseGuards(JwtAuthGuard)
  @Get('connections/:id/items/:itemId/preview')
  preview(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('itemId') itemId: string) {
    return this.files.preview(user, id, itemId);
  }

  // A download by default. `inline=1` only ever hands back an image, a PDF or plain text, under a sandbox.
  @UseGuards(JwtAuthGuard)
  @Get('connections/:id/items/:itemId/content')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async content(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('itemId') itemId: string, @Query() query: ContentQueryDto, @Res() res: Response) {
    const inline = !!query.inline;
    sendCloudFile(res, await this.files.download(user, id, itemId, inline), inline);
  }

  @UseGuards(JwtAuthGuard)
  @Post('connections/:id/folders')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  createFolder(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: CreateFolderDto) {
    return this.files.createFolder(user, id, dto.parentId, dto.name);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('connections/:id/items/:itemId')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('itemId') itemId: string, @Body() dto: UpdateItemDto) {
    return this.files.update(user, id, itemId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('connections/:id/items/:itemId')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async remove(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('itemId') itemId: string) {
    await this.files.remove(user, id, itemId);
    return { status: 'ok' };
  }

  @UseGuards(JwtAuthGuard)
  @Post('connections/:id/upload')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', CLOUD_UPLOAD_INTERCEPTOR_OPTIONS))
  // The folder is read as one plain field (checked by the service), not a DTO: a refused body would
  // otherwise leave the uploaded file behind on disk, since only the service deletes it.
  upload(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body('parentId') parentId: unknown, @UploadedFile() file: Express.Multer.File) {
    return this.files.upload(user, id, typeof parentId === 'string' ? parentId.slice(0, 600) : '', file);
  }

  // ---- company account: folders shared with roles -----------------------------------------

  @UseGuards(JwtAuthGuard)
  @Get('connections/:id/grants')
  grants(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.files.listGrants(user, id);
  }

  @UseGuards(JwtAuthGuard)
  @Put('connections/:id/grants')
  setGrants(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: SetFolderGrantsDto) {
    return this.files.setGrants(user, id, dto.grants);
  }
}
