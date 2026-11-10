import { Controller, Get, Param } from '@nestjs/common';
import { PermissionExempt } from '../common/permissions/permission.decorator';
import { QuotesService } from './quotes.service';

// The public side of "Copy Guest View Link" — deliberately its own
// controller with NO guard at all (same convention as outlook.controller.ts's
// bare `callback` route: a public route is just a route with no
// @UseGuards, never a class-level guard fought with a decorator), so this
// never shares a class with QuotesController's own @UseGuards(JwtAuthGuard,
// RolesGuard). A token here stands in for auth entirely — see
// QuotesService.getByGuestToken's own comment on why it's opaque and
// unguessable, and why this never falls back to the authenticated getOne.
@PermissionExempt('public')
@Controller('crm/quotes/guest')
export class QuoteGuestController {
  constructor(private quotesService: QuotesService) {}

  @Get(':token')
  async view(@Param('token') token: string) {
    const quote = await this.quotesService.getByGuestToken(token);
    // A deliberately narrow projection — a guest must never receive
    // organizationId, ownerUserId, createdByUserId, or any internal status
    // field a client was never meant to see.
    return {
      quoteNumber: quote.quoteNumber,
      quoteName: quote.quoteName,
      quoteStatus: quote.quoteStatus,
      clientApprovalStatus: quote.clientApprovalStatus,
      quoteAmount: quote.quoteAmount,
      currency: quote.currency,
      expirationDate: quote.expirationDate,
      dueDate: quote.dueDate,
      deliveryDate: quote.deliveryDate,
      clientDetails: quote.clientDetails,
      items: quote.items,
      subtotal: quote.subtotal,
      discountAmount: quote.discountAmount,
      taxAmount: quote.taxAmount,
      paidAmount: quote.paidAmount,
    };
  }
}
