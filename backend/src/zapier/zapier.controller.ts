import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ZapierService } from './zapier.service';

export class ConnectZapierDto {
  @IsString()
  @MinLength(8)
  @MaxLength(2000)
  connectionToken: string;
}

// Owners and admins connect Zapier; everyone uses it through the AI.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin')
@Controller('zapier')
export class ZapierController {
  constructor(private zapier: ZapierService) {}

  @Get('status')
  status(@CurrentUser() user: JwtPayload) {
    return this.zapier.status(user.organizationId);
  }

  @Post('connect')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  connect(@CurrentUser() user: JwtPayload, @Body() dto: ConnectZapierDto) {
    return this.zapier.connect(user.organizationId, dto.connectionToken);
  }

  @Post('refresh')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  refresh(@CurrentUser() user: JwtPayload) {
    return this.zapier.refresh(user.organizationId);
  }

  @Delete('connect')
  async disconnect(@CurrentUser() user: JwtPayload) {
    await this.zapier.disconnect(user.organizationId);
    return { connected: false };
  }
}
