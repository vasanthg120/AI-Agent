import { Controller, ForbiddenException, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Feature } from '../common/app-features';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CustomerDirectoryService } from './customer-directory.service';

// Customers: one row per customer, built from every connected CRM and the
// mailbox together. Same audience as New Inquiries (owner/admin/manager, or an
// AI role that includes it); every query is scoped to the caller's organization.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin', 'manager')
@Feature('inquiries')
@Controller('customers')
export class CustomersController {
  constructor(private directory: CustomerDirectoryService) {}

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
  ) {
    return this.directory.list(user.organizationId, {
      ...{ source, from, to, view, search, sort, direction, page: Number(page), pageSize: Number(pageSize) },
      ...{ owner, type, quote, payment, mail, channel },
    });
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

  @Get(':id')
  detail(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.directory.detail(user.organizationId, id);
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
