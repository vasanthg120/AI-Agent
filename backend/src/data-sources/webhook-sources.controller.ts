import { Body, Controller, Delete, Headers, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { MirroredModule } from './provider-catalog';
import { WEBHOOK_MODULES } from './webhook-info';
import { WebhookSourcesService } from './webhook-sources.service';

class WebhookTerminologyDto {
  @IsOptional() @IsString() @MaxLength(40) deal?: string;
  @IsOptional() @IsString() @MaxLength(40) contact?: string;
  @IsOptional() @IsString() @MaxLength(40) account?: string;
}

export class CreateWebhookSourceDto {
  @IsString() @MinLength(1) @MaxLength(60) label: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(WEBHOOK_MODULES, { each: true })
  modules?: MirroredModule[];

  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookTerminologyDto)
  terminology?: WebhookTerminologyDto;
}

// Owners and admins add apps that push records into HaiVE (via Zapier).
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin')
@Controller('data-sources/webhook-sources')
export class WebhookSourcesController {
  constructor(private webhooks: WebhookSourcesService) {}

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateWebhookSourceDto) {
    return this.webhooks.create(user.organizationId, dto);
  }

  @Post(':id/rotate-key')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  rotate(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.webhooks.rotateKey(user.organizationId, id);
  }

  @Delete(':id')
  disconnect(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.webhooks.disconnect(user.organizationId, id);
  }
}

// Called by Zapier ("Webhooks by Zapier" -> POST), not by a signed-in user: no
// JwtAuthGuard — the source's own webhook key (X-HaiVE-Key header, or ?key=)
// authenticates it and decides the one organization and source it writes to.
@Controller('data-source-webhooks')
export class WebhookIngestController {
  constructor(private webhooks: WebhookSourcesService) {}

  @Post(':id/:module')
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  ingest(
    @Param('id') id: string,
    @Param('module') module: string,
    @Body() body: unknown,
    @Headers('x-haive-key') headerKey?: string,
    @Query('key') queryKey?: string,
  ) {
    return this.webhooks.ingest(id, module, (headerKey || queryKey || '').trim() || undefined, body);
  }
}
