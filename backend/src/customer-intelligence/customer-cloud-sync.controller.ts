import { Controller, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CloudErrorFilter } from '../cloud-files/cloud-error.filter';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CustomerCloudSyncService } from './customer-cloud-sync.service';

// "Sync now" for one connected Google Drive / OneDrive account (Integrations page):
// anyone who may open the account may ask for it; the sync itself only reads.
@UseGuards(JwtAuthGuard)
@UseFilters(CloudErrorFilter)
@Controller('cloud-files')
export class CustomerCloudSyncController {
  constructor(private sync: CustomerCloudSyncService) {}

  @Post('connections/:id/sync')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  syncNow(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.sync.syncNow(user, id);
  }
}
