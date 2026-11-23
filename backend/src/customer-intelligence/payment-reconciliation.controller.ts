import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Permission } from '../common/permissions/permission.decorator';
import { PaymentReconciliationService } from './payment-reconciliation.service';

// Owner/admin only, and always scoped to the caller's own organization — the organization id comes from the token,
// never from the request, so no call can read or change another organization's data.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin')
@Permission('customers')
@Controller('payment-reconciliation')
export class PaymentReconciliationController {
  constructor(private reconciliation: PaymentReconciliationService) {}

  /** Read-only preview: what a reconciliation would find (payments scanned/linked, quotes paid/partial) — writes nothing. */
  @Get('preview')
  preview(@CurrentUser() user: JwtPayload) {
    return this.reconciliation.reconcileOrganization(user.organizationId, { dryRun: true });
  }

  /** Reconciles every quote of this organization now and stores the result on the quotes. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('run')
  run(@CurrentUser() user: JwtPayload) {
    return this.reconciliation.reconcileOrganization(user.organizationId);
  }

  /** Historical reconciliation: re-reads this organization's full Square history, then reconciles every quote. */
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  @Post('history')
  history(@CurrentUser() user: JwtPayload) {
    return this.reconciliation.reconcileHistory(user.organizationId);
  }
}
