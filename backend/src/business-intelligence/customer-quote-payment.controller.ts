import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { resolveBiDateRange, scopeBiFilters } from './bi-filter.util';
import { BiFilterQueryDto } from './dto/bi-filter-query.dto';
import { ListBiQuotesQueryDto } from './dto/list-bi-quotes-query.dto';
import { CustomerQuotePaymentService } from './customer-quote-payment.service';
import { Permission } from '../common/permissions/permission.decorator';

// Route order matters: 'summary'/'quotes' are static segments and must be
// registered before 'customer/:businessKey', same rule deals.controller.ts's
// own comment documents.
@UseGuards(JwtAuthGuard, RolesGuard)
@Permission('analytics')
@Controller('business-intelligence/customer-quote-payment')
export class CustomerQuotePaymentController {
  constructor(private customerQuotePaymentService: CustomerQuotePaymentService) {}

  @Get('summary')
  @Roles('owner', 'admin', 'manager', 'consultant')
  summary(@CurrentUser() user: JwtPayload, @Query() query: BiFilterQueryDto) {
    const scoped = scopeBiFilters(user, query);
    const { start, end } = resolveBiDateRange(scoped);
    return this.customerQuotePaymentService.getSummary(user.organizationId, start, end, scoped);
  }

  @Get('quotes')
  @Roles('owner', 'admin', 'manager', 'consultant')
  quotes(@CurrentUser() user: JwtPayload, @Query() query: ListBiQuotesQueryDto) {
    const scoped = scopeBiFilters(user, query);
    const { start, end } = resolveBiDateRange(scoped);
    return this.customerQuotePaymentService.listQuotes(
      user.organizationId,
      start,
      end,
      { ...scoped, clientApprovalStatus: query.clientApprovalStatus },
      query.page ?? 1,
      query.pageSize ?? 25,
    );
  }

  @Get('customer/:businessKey')
  @Roles('owner', 'admin', 'manager', 'consultant')
  customerDetail(@CurrentUser() user: JwtPayload, @Param('businessKey') businessKey: string) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    if (!canOverride && user.roles.includes('consultant')) {
      return this.customerQuotePaymentService.getCustomerDetail(user, businessKey, undefined, true);
    }
    const storeConstraint = !canOverride && user.roles.includes('manager') ? user.storeId : undefined;
    return this.customerQuotePaymentService.getCustomerDetail(user, businessKey, storeConstraint, false);
  }
}
