import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { GorillaDashService } from './gorilladash.service';

export class ConnectGorillaDashDto {
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  apiKey: string;

  @IsString()
  @MinLength(8)
  @MaxLength(200)
  apiSecret: string;
}

// Owners and admins connect Gorilla Dash; everyone else sees its data
// through the dashboards and the AI tools.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin')
@Controller('gorilladash')
export class GorillaDashController {
  constructor(private gorilladash: GorillaDashService) {}

  @Get('status')
  status(@CurrentUser() user: JwtPayload) {
    return this.gorilladash.status(user.organizationId);
  }

  @Post('connect')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  connect(@CurrentUser() user: JwtPayload, @Body() dto: ConnectGorillaDashDto) {
    return this.gorilladash.connect(user.organizationId, dto.apiKey.trim(), dto.apiSecret.trim());
  }

  @Delete('connect')
  async disconnect(@CurrentUser() user: JwtPayload) {
    await this.gorilladash.disconnect(user.organizationId);
    return { connected: false };
  }
}
