import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AuditService } from './audit.service';

// Split out of AuditController — platform-wide, unscoped by organization
// (Admin-haive's Audit Logs page). Gated by the separate admin credential
// (AdminJwtAuthGuard), never the customer JwtAuthGuard AuditController's own
// GET /audit-logs uses; NestJS accumulates controller + method guards
// rather than overriding them, so this had to be its own controller rather
// than a method-level guard on AuditController.
@UseGuards(AdminJwtAuthGuard)
@Controller('audit-logs')
export class AdminAuditController {
  constructor(private auditService: AuditService) {}

  @Get('all')
  listAll(@Query('userId') userId?: string, @Query('route') route?: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.auditService.listAll({
      userId,
      route,
      page: page ? Number.parseInt(page, 10) : undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
  }
}
