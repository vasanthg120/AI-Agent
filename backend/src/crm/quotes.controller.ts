import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { ListQuotesQueryDto } from './dto/list-quotes-query.dto';
import { UpdateQuoteDto } from './dto/update-quote.dto';
import { RecordQuotePaymentDto } from './dto/record-quote-payment.dto';
import { VoidQuotePaymentDto } from './dto/void-quote-payment.dto';
import { QuotesService } from './quotes.service';
import { QuotePaymentsService } from './quote-payments.service';

// Phase 19 — the Unified Analytics Dashboard's quote drill-down. Same
// role/scope shape as DealsController's own /query route: owner/admin see
// the whole org, manager is store-constrained (via the linked deal),
// consultant is self-constrained (via the linked deal's ownerId) —
// server-forced, never client-supplied.
//
// Route order matters: 'query' is a static segment and must be registered
// before ':id', same rule deals.controller.ts's own comment documents.
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('crm/quotes')
export class QuotesController {
  constructor(
    private quotesService: QuotesService,
    private quotePaymentsService: QuotePaymentsService,
  ) {}

  @Get('query')
  @Roles('owner', 'admin', 'manager', 'consultant')
  listFiltered(@CurrentUser() user: JwtPayload, @Query() query: ListQuotesQueryDto) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    // Owner/admin may optionally narrow to one store (matches the dashboard's
    // own store-select override); a manager's store is always server-forced.
    const storeConstraint = canOverride ? query.storeId : user.roles.includes('manager') ? user.storeId : undefined;
    const ownerConstraint = !canOverride && user.roles.includes('consultant') ? user.sub : undefined;
    return this.quotesService.listFiltered(user.organizationId, query, storeConstraint, ownerConstraint);
  }

  // The first native "build a priced quote" entry point this app has had —
  // same write tier (owner/admin/manager, consultant excluded) as every
  // other mutation route below.
  @Post()
  @Roles('owner', 'admin', 'manager')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateQuoteDto) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.quotesService.createQuote(user.organizationId, dto, user.sub, storeConstraint);
  }

  // Section 7 (Business Intelligence: Customer Quote & Payment Tracking) —
  // the first genuinely writable path this app has for Quote (see plan
  // finding #3). Consultant is deliberately excluded from every write route
  // below — read-only for that role, matching the plan's own RBAC table.
  @Patch(':id')
  @Roles('owner', 'admin', 'manager')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateQuoteDto) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.quotesService.updateQuote(user.organizationId, id, dto, storeConstraint);
  }

  @Get(':id')
  @Roles('owner', 'admin', 'manager', 'consultant')
  getOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = !canOverride && user.roles.includes('manager') ? user.storeId : undefined;
    const ownerConstraint = !canOverride && user.roles.includes('consultant') ? user.sub : undefined;
    return this.quotesService.getOne(user.organizationId, id, storeConstraint, ownerConstraint);
  }

  @Post(':id/payments')
  @Roles('owner', 'admin', 'manager')
  recordPayment(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: RecordQuotePaymentDto) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.quotePaymentsService.recordPayment(user.organizationId, id, dto, user.sub, storeConstraint);
  }

  @Get(':id/payments')
  @Roles('owner', 'admin', 'manager', 'consultant')
  listPayments(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = !canOverride && user.roles.includes('manager') ? user.storeId : undefined;
    const ownerConstraint = !canOverride && user.roles.includes('consultant') ? user.sub : undefined;
    return this.quotePaymentsService.listPayments(user.organizationId, id, storeConstraint, ownerConstraint);
  }

  // Corrections never hard-delete a financial record — void only, same
  // ethos as quote-payment.schema.ts's own comment.
  @Post(':id/payments/:paymentId/void')
  @Roles('owner', 'admin', 'manager')
  voidPayment(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @Body() dto: VoidQuotePaymentDto,
  ) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.quotePaymentsService.voidPayment(user.organizationId, id, paymentId, user.sub, dto.reason, storeConstraint);
  }
}
