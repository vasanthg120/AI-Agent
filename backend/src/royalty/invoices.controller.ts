import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import { VoidInvoiceDto } from './dto/void-invoice.dto';
import { ListInvoicesQueryDto } from './dto/list-invoices-query.dto';
import { InvoicesService } from './invoices.service';
import { Permission } from '../common/permissions/permission.decorator';

// Invoice management is store-operational CRUD data, like Deal/Quote — the
// CRUD tier (owner/admin/manager, manager forced to their own store),
// deliberately NOT the tighter owner/admin-only tier RoyaltyRulesController
// uses for the actual royalty percentage/cap configuration.
//
// Route order matters: 'query' is a static segment and must be registered
// before ':id', or a request to /royalty/invoices/query would match :id
// with id="query" instead — same rule deals.controller.ts documents.
@UseGuards(JwtAuthGuard, RolesGuard)
@Permission('finance')
@Controller('royalty/invoices')
export class InvoicesController {
  constructor(private invoicesService: InvoicesService) {}

  @Get()
  @Roles('owner', 'admin', 'manager')
  list(@CurrentUser() user: JwtPayload) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.invoicesService.list(user.organizationId, storeConstraint);
  }

  @Get('query')
  @Roles('owner', 'admin', 'manager')
  listFiltered(@CurrentUser() user: JwtPayload, @Query() query: ListInvoicesQueryDto) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.invoicesService.listFiltered(user.organizationId, query, storeConstraint);
  }

  @Get(':id')
  @Roles('owner', 'admin', 'manager')
  getOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.invoicesService.findOne(id, user.organizationId, storeConstraint);
  }

  @Post()
  @Roles('owner', 'admin', 'manager')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateInvoiceDto) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.invoicesService.create(user.organizationId, dto, storeConstraint, user.sub);
  }

  @Patch(':id')
  @Roles('owner', 'admin', 'manager')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateInvoiceDto) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.invoicesService.update(id, user.organizationId, dto, storeConstraint);
  }

  @Patch(':id/void')
  @Roles('owner', 'admin', 'manager')
  voidInvoice(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: VoidInvoiceDto) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.invoicesService.voidInvoice(id, user.organizationId, dto, storeConstraint);
  }
}
