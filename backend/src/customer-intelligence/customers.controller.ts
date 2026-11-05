import { FileInterceptor } from '@nestjs/platform-express';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Feature } from '../common/app-features';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UPLOAD_FILE_INTERCEPTOR_OPTIONS } from '../common/upload-limits';
import { CustomerDirectoryService } from './customer-directory.service';
import { CustomerWorkspaceService } from './customer-workspace.service';
import { buildCustomerImportTemplateCsv, CustomerImportService } from './customer-import.service';
import { AddCustomerContactDto, CreateCustomerAddressDto, CreateCustomerDto, UpdateCustomerDto } from './dto/customer-profile.dto';

// Customers: one row per customer, built from every connected CRM and the
// mailbox together. Same audience as New Inquiries (owner/admin/manager, or an
// AI role that includes it); every query is scoped to the caller's organization.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin', 'manager')
@Feature('inquiries')
@Controller('customers')
export class CustomersController {
  constructor(
    private directory: CustomerDirectoryService,
    private workspace: CustomerWorkspaceService,
    private importService: CustomerImportService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: JwtPayload,
    @Query('source') source?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('view') view?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: string,
    @Query('direction') direction?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('owner') owner?: string,
    @Query('type') type?: string,
    @Query('quote') quote?: string,
    @Query('payment') payment?: string,
    @Query('mail') mail?: string,
    @Query('channel') channel?: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.directory.list(user.organizationId, {
      ...{ source, from, to, view, search, sort, direction, page: Number(page), pageSize: Number(pageSize) },
      ...{ owner, type, quote, payment, mail, channel, includeArchived },
    });
  }

  // Phase 3 — "Add Customer". Creates a real crm_contacts record (see
  // CustomerDirectoryService.createCustomer's own comment); when the
  // email/phone/company looks like an existing customer, returns that
  // match instead of creating one — resend with confirmDuplicate:true to
  // create anyway. Declared before ':id' so 'export'/'sync' (both static
  // segments, same rule as every other GET below) are never shadowed; POST
  // here can't collide with GET :id regardless of order (different verbs).
  @Post()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateCustomerDto) {
    return this.directory.createCustomer(user, dto);
  }

  // Just enough to populate the "Customer Rep" picker (id + name only) — declared before ':id'.
  @Get('reps')
  listReps(@CurrentUser() user: JwtPayload) {
    return this.directory.listReps(user.organizationId);
  }

  // Hoops-parity Tasks tab — every task across every customer/job, not
  // narrowed to one (see CustomerWorkspaceService.listAllTasks's own
  // comment). Declared before ':id' so it's never shadowed by it.
  @Get('tasks')
  listAllTasks(@CurrentUser() user: JwtPayload, @Query('status') status?: 'open' | 'done', @Query('mine') mine?: string) {
    return this.workspace.listAllTasks(user, { status, mine: mine === 'true' });
  }

  // The board as a spreadsheet: the same filters as the list, every page. Declared before ':id'.
  @Get('export')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async export(
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
    @Query('source') source?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('view') view?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: string,
    @Query('direction') direction?: string,
    @Query('owner') owner?: string,
    @Query('type') type?: string,
    @Query('quote') quote?: string,
    @Query('payment') payment?: string,
    @Query('mail') mail?: string,
    @Query('channel') channel?: string,
  ) {
    const csv = await this.directory.export(user.organizationId, {
      source,
      from,
      to,
      view,
      search,
      sort,
      direction,
      owner,
      type,
      quote,
      payment,
      mail,
      channel,
    });
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    // The mark at the start tells a spreadsheet the file is UTF-8, so ₹ and accented names read correctly.
    res.send(`﻿${csv}`);
  }

  // Pull the latest from the connected CRMs now (otherwise they sync on their own schedule).
  @Post('sync')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  sync(@CurrentUser() user: JwtPayload, @Query('source') source?: string) {
    return this.directory.sync(user.organizationId, source);
  }

  // Hoops-parity CSV import — declared before ':id', same static-segment
  // rule as 'export'/'sync' above.
  @Get('import-template')
  importTemplate(@Res() res: Response) {
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="customer-import-template.csv"',
    });
    res.send(buildCustomerImportTemplateCsv());
  }

  @Post('import/preview')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', UPLOAD_FILE_INTERCEPTOR_OPTIONS))
  async previewImport(@CurrentUser() user: JwtPayload, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('A CSV file is required.');
    return this.importService.parseImportFile(user.organizationId, file.buffer);
  }

  @Post('import/commit')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', UPLOAD_FILE_INTERCEPTOR_OPTIONS))
  async commitImport(@CurrentUser() user: JwtPayload, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('A CSV file is required.');
    const { customers, errors } = await this.importService.parseImportFile(user.organizationId, file.buffer);
    const result = await this.importService.importRows(user, customers);
    return { ...result, errors: [...errors, ...result.errors] };
  }

  @Get(':id')
  detail(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.directory.detail(user.organizationId, id);
  }

  // "Edit customer" — name/email/phone corrections and the assigned rep.
  // Never touches which records belong to this customer (see
  // updateCustomer's own comment) — only how they display.
  @Patch(':id')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateCustomerDto) {
    return this.directory.updateCustomer(user.organizationId, id, dto);
  }

  // Same activate/deactivate shape as products.controller.ts — archived
  // customers drop out of the default list but stay fully reachable by id.
  @Post(':id/archive')
  archive(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.directory.setArchived(user.organizationId, id, true);
  }

  @Post(':id/restore')
  restore(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.directory.setArchived(user.organizationId, id, false);
  }

  // Additional contacts on a customer beyond what the connected systems
  // already name (see customer-directory.service.ts's addContact comment).
  @Post(':id/contacts')
  addContact(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: AddCustomerContactDto) {
    return this.directory.addContact(user.organizationId, id, dto);
  }

  @Delete(':id/contacts/:contactId')
  removeContact(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('contactId') contactId: string) {
    return this.directory.removeContact(user.organizationId, id, contactId);
  }

  // Hoops-parity Add/Edit Customer — multiple typed addresses (billing/
  // shipping/other), same additive/HaiVE-only shape as contacts above.
  @Post(':id/addresses')
  addAddress(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: CreateCustomerAddressDto) {
    return this.directory.addAddress(user.organizationId, id, dto);
  }

  @Delete(':id/addresses/:addressId')
  removeAddress(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('addressId') addressId: string) {
    return this.directory.removeAddress(user.organizationId, id, addressId);
  }

  // A real, billed AI call — same per-employee switch as the chat.
  @Post(':id/analysis')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  analyze(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Query('refresh') refresh?: string) {
    if (user.aiAccessEnabled === false) {
      throw new ForbiddenException('AI access has been disabled for your account by an administrator.');
    }
    return this.directory.analyze(user, id, refresh === 'true');
  }
}
