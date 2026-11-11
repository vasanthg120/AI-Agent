import { FileInterceptor } from '@nestjs/platform-express';
import { Body, Controller, Get, Param, Patch, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { UPLOAD_FILE_INTERCEPTOR_OPTIONS } from '../common/upload-limits';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { ProductsService } from './products.service';
import { Permission } from '../common/permissions/permission.decorator';

// Native product/service catalog for Quote line items. Same
// JwtAuthGuard+RolesGuard shape as QuotesController: read is open to every
// CRM role (including consultant, so a rep can build a quote from the
// catalog), writes are owner/admin/manager only — matching Quote's own
// write-route tier exactly.
//
// Route order matters: 'query' is a static segment and must be registered
// before ':id' — same rule quotes.controller.ts/deals.controller.ts document.
@UseGuards(JwtAuthGuard, RolesGuard)
@Permission('customers')
@Controller('crm/products')
export class ProductsController {
  constructor(private productsService: ProductsService) {}

  @Get('query')
  @Roles('owner', 'admin', 'manager', 'consultant')
  listFiltered(@CurrentUser() user: JwtPayload, @Query() query: ListProductsQueryDto) {
    return this.productsService.listFiltered(user.organizationId, query);
  }

  @Get(':id')
  @Roles('owner', 'admin', 'manager', 'consultant')
  getOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.productsService.getOne(user.organizationId, id);
  }

  @Post()
  @Roles('owner', 'admin', 'manager')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateProductDto) {
    return this.productsService.create(user.organizationId, dto, user.sub);
  }

  @Patch(':id')
  @Roles('owner', 'admin', 'manager')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.productsService.update(user.organizationId, id, dto);
  }

  @Post(':id/activate')
  @Roles('owner', 'admin', 'manager')
  @Permission('customers', 'edit')
  activate(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.productsService.setActive(user.organizationId, id, true);
  }

  @Post(':id/deactivate')
  @Roles('owner', 'admin', 'manager')
  @Permission('customers', 'edit')
  deactivate(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.productsService.setActive(user.organizationId, id, false);
  }

  @Post(':id/image')
  @Roles('owner', 'admin', 'manager')
  @UseInterceptors(FileInterceptor('file', UPLOAD_FILE_INTERCEPTOR_OPTIONS))
  setImage(@CurrentUser() user: JwtPayload, @Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    return this.productsService.setImage(user.organizationId, id, file);
  }

  @Get(':id/image')
  @Roles('owner', 'admin', 'manager', 'consultant')
  async getImage(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Res() res: Response) {
    const { stream, filename, mimeType } = await this.productsService.getImageStream(user.organizationId, id);
    res.set({ 'Content-Type': mimeType, 'Content-Disposition': `inline; filename="${filename}"` });
    stream.pipe(res);
  }
}
