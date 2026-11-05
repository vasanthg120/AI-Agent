import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { VendorsService } from './vendors.service';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { UpdateVendorDto } from './dto/update-vendor.dto';
import { CreateVendorQuoteDto } from './dto/create-vendor-quote.dto';
import { UpdateVendorQuoteDto } from './dto/update-vendor-quote.dto';
import { ListVendorQuotesQueryDto } from './dto/list-vendor-quotes-query.dto';

// Owner/admin only, matching Vendor Profitability's own sensitivity tier
// (see business-intelligence's vendor-profitability.controller.ts) — vendor
// cost/margin data is more sensitive than pipeline data, same precedent
// Finance already established for this class of data.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin')
@Controller()
export class VendorsController {
  constructor(private vendorsService: VendorsService) {}

  @Get('vendors')
  listVendors(@CurrentUser() user: JwtPayload) {
    return this.vendorsService.listVendors(user.organizationId);
  }

  // Static segment, must be registered before 'vendors/:id' — same rule
  // products.controller.ts documents. Broader than this controller's own
  // owner/admin gate (method-level @Roles overrides the class-level one,
  // same pattern crm's controllers use per-route) — see listPicker's own
  // comment for why a name-only projection is safe at Catalog's wider tier.
  @Get('vendors/picker')
  @Roles('owner', 'admin', 'manager')
  listPicker(@CurrentUser() user: JwtPayload) {
    return this.vendorsService.listPicker(user.organizationId);
  }

  @Get('vendors/:id')
  getVendor(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.vendorsService.getVendor(user.organizationId, id);
  }

  @Post('vendors')
  createVendor(@CurrentUser() user: JwtPayload, @Body() dto: CreateVendorDto) {
    return this.vendorsService.createVendor(user.organizationId, dto, user.sub);
  }

  @Patch('vendors/:id')
  updateVendor(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateVendorDto) {
    return this.vendorsService.updateVendor(user.organizationId, id, dto);
  }

  @Get('vendor-quotes')
  listVendorQuotes(@CurrentUser() user: JwtPayload, @Query() query: ListVendorQuotesQueryDto) {
    return this.vendorsService.listVendorQuotes(user.organizationId, query);
  }

  @Post('vendor-quotes')
  createVendorQuote(@CurrentUser() user: JwtPayload, @Body() dto: CreateVendorQuoteDto) {
    return this.vendorsService.createVendorQuote(user.organizationId, dto, user.sub);
  }

  @Patch('vendor-quotes/:id')
  updateVendorQuote(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateVendorQuoteDto) {
    return this.vendorsService.updateVendorQuote(user.organizationId, id, dto);
  }
}
