import { Body, Controller, ForbiddenException, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsObject, IsOptional } from 'class-validator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { MappingIntelligenceService } from '../data-sources/mapping-intelligence.service';
import type { FieldMappings, StatusMapping } from '../data-sources/provider-catalog';
import { CrmIntegrationsService } from './crm-integrations.service';

export class ConnectCrmDto {
  // Whatever the chosen CRM's setup asks for (see CrmIntegrationsService SETUP) — validated there, per provider.
  @IsOptional() @IsObject() credentials?: Record<string, string>;
}

export class MappingDto {
  @IsObject() fieldMappings: FieldMappings;
  @IsOptional() @IsObject() statusMapping?: StatusMapping;
}

// CRM integrations for the Integrations page — owners and admins only. The
// organization always comes from the signed-in user, never from the request.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin')
@Controller('crm-integrations')
export class CrmIntegrationsController {
  constructor(
    private crm: CrmIntegrationsService,
    private mapping: MappingIntelligenceService,
  ) {}

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.crm.list(user.organizationId);
  }

  @Post(':provider/connect')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  connect(@CurrentUser() user: JwtPayload, @Param('provider') provider: string, @Body() dto: ConnectCrmDto) {
    return this.crm.connect(user.organizationId, provider, dto.credentials ?? {});
  }

  @Post(':provider/disconnect')
  disconnect(@CurrentUser() user: JwtPayload, @Param('provider') provider: string) {
    return this.crm.disconnect(user.organizationId, provider);
  }

  @Post(':provider/discover')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  discover(@CurrentUser() user: JwtPayload, @Param('provider') provider: string) {
    return this.crm.rediscover(user.organizationId, provider);
  }

  @Post(':provider/rotate-key')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  rotateKey(@CurrentUser() user: JwtPayload, @Param('provider') provider: string) {
    return this.crm.rotateKey(user.organizationId, provider);
  }

  @Post(':provider/sync')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  sync(@CurrentUser() user: JwtPayload, @Param('provider') provider: string) {
    return this.crm.syncNow(user.organizationId, provider);
  }

  @Get(':provider/sync-history')
  history(@CurrentUser() user: JwtPayload, @Param('provider') provider: string) {
    return this.crm.history(user.organizationId, provider);
  }

  @Post(':provider/make-default')
  makeDefault(@CurrentUser() user: JwtPayload, @Param('provider') provider: string) {
    return this.crm.makeDefault(user.organizationId, provider);
  }

  // ---- field mapping (by data-source id, as returned in each integration's `source.id`) ----

  // `ai=true` also asks the AI about fields a name match left unsure — a billed AI call.
  @Get('mapping/:sourceId')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  suggest(@CurrentUser() user: JwtPayload, @Param('sourceId') sourceId: string, @Query('ai') ai?: string) {
    if (ai === 'true' && user.aiAccessEnabled === false) {
      throw new ForbiddenException('AI access has been disabled for your account by an administrator.');
    }
    return this.mapping.suggest(user, sourceId, ai === 'true');
  }

  @Post('mapping/:sourceId/preview')
  preview(@CurrentUser() user: JwtPayload, @Param('sourceId') sourceId: string, @Body() dto: MappingDto) {
    return this.mapping.preview(user.organizationId, sourceId, dto.fieldMappings, dto.statusMapping);
  }

  @Put('mapping/:sourceId')
  save(@CurrentUser() user: JwtPayload, @Param('sourceId') sourceId: string, @Body() dto: MappingDto) {
    return this.mapping.save(user, sourceId, dto.fieldMappings, dto.statusMapping);
  }

  @Get('mapping/:sourceId/versions')
  versions(@CurrentUser() user: JwtPayload, @Param('sourceId') sourceId: string) {
    return this.mapping.versions(user.organizationId, sourceId);
  }

  @Post('mapping/:sourceId/versions/:version/restore')
  restore(@CurrentUser() user: JwtPayload, @Param('sourceId') sourceId: string, @Param('version', ParseIntPipe) version: number) {
    return this.mapping.restore(user, sourceId, version);
  }
}
