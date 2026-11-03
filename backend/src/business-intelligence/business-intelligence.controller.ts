import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Permission } from '../common/permissions/permission.decorator';

// Stub health-check route only, for Phase 1 (foundation) wiring
// verification — real per-section controllers (email-analytics,
// employee-productivity, enquiry-conversion, vendor-profitability,
// ai-followup-summary, customer-quote-payment) land in later build phases.
@Permission('analytics')
@Controller('business-intelligence')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin', 'manager', 'consultant')
export class BusinessIntelligenceController {
  @Get('health')
  health() {
    return { status: 'ok' };
  }
}
