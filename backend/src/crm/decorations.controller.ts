import { FileInterceptor } from '@nestjs/platform-express';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { UPLOAD_FILE_INTERCEPTOR_OPTIONS } from '../common/upload-limits';
import { CreateDecorationDto } from './dto/create-decoration.dto';
import { UpdateDecorationDto } from './dto/update-decoration.dto';
import { ListDecorationsQueryDto } from './dto/list-decorations-query.dto';
import { ImportDecorationsDto } from './dto/import-decorations.dto';
import { buildImportTemplateCsv, DecorationsService } from './decorations.service';

// Hoops-parity Catalog — same JwtAuthGuard+RolesGuard tiers as
// ProductsController (read: owner/admin/manager/consultant, write:
// owner/admin/manager). Route order matters: 'query'/'import-template'/
// 'import/preview'/'import/commit' are static segments and must be
// registered before ':id', same rule products.controller.ts documents.
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('crm/decorations')
export class DecorationsController {
  constructor(private decorationsService: DecorationsService) {}

  @Get('query')
  @Roles('owner', 'admin', 'manager', 'consultant')
  listFiltered(@CurrentUser() user: JwtPayload, @Query() query: ListDecorationsQueryDto) {
    return this.decorationsService.listFiltered(user.organizationId, query);
  }

  @Get('import-template')
  @Roles('owner', 'admin', 'manager')
  downloadTemplate(@Res() res: Response) {
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="decoration-import-template.csv"',
    });
    res.send(buildImportTemplateCsv());
  }

  @Post('import/preview')
  @Roles('owner', 'admin', 'manager')
  @UseInterceptors(FileInterceptor('file', UPLOAD_FILE_INTERCEPTOR_OPTIONS))
  async previewImport(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('A CSV file is required.');
    return this.decorationsService.parseImportFile(file.buffer);
  }

  @Post('import/commit')
  @Roles('owner', 'admin', 'manager')
  @UseInterceptors(FileInterceptor('file', UPLOAD_FILE_INTERCEPTOR_OPTIONS))
  async commitImport(@CurrentUser() user: JwtPayload, @UploadedFile() file: Express.Multer.File, @Body() dto: ImportDecorationsDto) {
    if (!file) throw new BadRequestException('A CSV file is required.');
    const { decorations, errors } = await this.decorationsService.parseImportFile(file.buffer);
    const { created, updated } = await this.decorationsService.importRows(user.organizationId, decorations, dto.vendorId, user.sub);
    return { created, updated, errors };
  }

  @Get(':id')
  @Roles('owner', 'admin', 'manager', 'consultant')
  getOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.decorationsService.getOne(user.organizationId, id);
  }

  @Post()
  @Roles('owner', 'admin', 'manager')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateDecorationDto) {
    return this.decorationsService.create(user.organizationId, dto, user.sub);
  }

  @Patch(':id')
  @Roles('owner', 'admin', 'manager')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateDecorationDto) {
    return this.decorationsService.update(user.organizationId, id, dto);
  }

  @Delete(':id')
  @Roles('owner', 'admin', 'manager')
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.decorationsService.remove(user.organizationId, id);
  }
}
