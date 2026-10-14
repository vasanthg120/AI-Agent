import { Body, Controller, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { currentDataSourceScope } from './data-source-context';
import { DataSourcesService } from './data-sources.service';
import { HiddenMetricsDto, UpdateDataSourceDto } from './dto/update-data-source.dto';

@UseGuards(JwtAuthGuard)
@Controller('data-sources')
export class DataSourcesController {
  constructor(private dataSources: DataSourcesService) {}

  // What anyone needs to read the dashboard honestly: the sources, which one
  // this request is using, and where each metric comes from (or why it can't).
  @Get('overview')
  async overview(@CurrentUser() user: JwtPayload) {
    const scope = currentDataSourceScope() ?? (await this.dataSources.resolveScope(user.organizationId, undefined));
    return this.dataSources.overview(user, scope);
  }

  // Which metrics this person has hidden on their own dashboard.
  @Put('preferences')
  async preferences(@CurrentUser() user: JwtPayload, @Body() dto: HiddenMetricsDto) {
    return {
      hiddenMetrics: await this.dataSources.setHiddenMetrics(user.sub, dto.hiddenMetrics),
    };
  }

  // ---- administration ----

  @Get()
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  list(@CurrentUser() user: JwtPayload) {
    return this.dataSources.listForAdmin(user.organizationId);
  }

  @Get('catalog')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  catalog() {
    return this.dataSources.catalog();
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateDataSourceDto) {
    return this.dataSources.update(user.organizationId, id, dto);
  }

  @Post(':id/sync')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  sync(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.dataSources.syncNow(user.organizationId, id);
  }

  // Re-check connections (e.g. right after connecting or removing a CRM).
  @Post('reconcile')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  async reconcile(@CurrentUser() user: JwtPayload) {
    await this.dataSources.reconcile(user.organizationId);
    await this.dataSources.backfill(user.organizationId);
    return this.dataSources.listForAdmin(user.organizationId);
  }
}
