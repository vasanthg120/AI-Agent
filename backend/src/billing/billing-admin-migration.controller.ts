import { Controller, Post, Query, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { BillingMigrationService } from './billing-migration.service';

// Phase 0 of the org-scoped billing extension — see
// billing-migration.service.ts and billing.controller.ts's tenantKey() for
// the full picture. platform_admin only, matching billing-admin.controller.ts's
// existing gate: this endpoint can rewrite real wallet balances across every
// organization in one call.
@UseGuards(AdminJwtAuthGuard)
@Controller('billing/admin')
export class BillingAdminMigrationController {
  constructor(private migrationService: BillingMigrationService) {}

  // dryRun defaults to true (only an explicit `?dryRun=false` performs real
  // writes) — always review a dry-run's plan first. organizationId narrows
  // to a single org for a staged rollout; omit it to plan/run every
  // organization at once.
  @Post('migrate-organization-wallets')
  migrate(@Query('dryRun') dryRun?: string, @Query('organizationId') organizationId?: string) {
    return this.migrationService.run({ dryRun: dryRun !== 'false', organizationId });
  }
}
