import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PermissionExempt } from '../common/permissions/permission.decorator';

// Exempt from the app-wide rate limit (see ThrottlerModule.forRoot in
// app.module.ts) — load balancers/orchestrators poll this frequently by
// design, and it shouldn't compete with real traffic for the same budget.
@SkipThrottle()
@PermissionExempt('public')
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok', service: 'backend' };
  }
}
