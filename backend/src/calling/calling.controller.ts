import { Body, Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CallingProvider } from './calling-routing';
import { CallingService } from './calling.service';

const PROVIDERS: CallingProvider[] = ['plivo', 'twilio'];
const canManage = (user: JwtPayload) => user.roles.some((role) => role === 'owner' || role === 'admin');

export class StartCallDto {
  // With its country code ("+44 7700 900123"); a bare national number is taken
  // to be domestic.
  @IsString()
  @MaxLength(32)
  customerNumber: string;

  @IsOptional()
  @IsString()
  dealId?: string;

  // Leave out to route automatically (domestic -> Plivo, international -> Twilio).
  @IsOptional()
  @IsIn(PROVIDERS)
  provider?: CallingProvider;
}

@UseGuards(JwtAuthGuard)
@Controller('calling')
export class CallingController {
  constructor(private calling: CallingService) {}

  @Get('overview')
  overview(@CurrentUser() user: JwtPayload) {
    return this.calling.overview(user, canManage(user));
  }

  // Each call is a real, billed phone call.
  @Post('calls')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  startCall(@CurrentUser() user: JwtPayload, @Body() dto: StartCallDto) {
    return this.calling.startCall(user, dto.customerNumber, dto.dealId, dto.provider);
  }

  @Get('calls')
  calls(@CurrentUser() user: JwtPayload, @Query('scope') scope?: string) {
    return this.calling.listCalls(user, scope === 'org' && canManage(user));
  }

  @Post('calls/:provider/:id/retry-import')
  retry(@CurrentUser() user: JwtPayload, @Param('provider') provider: string, @Param('id') id: string) {
    if (!PROVIDERS.includes(provider as CallingProvider)) throw new NotFoundException('Call not found.');
    return this.calling.retryImport(user, provider as CallingProvider, id, canManage(user));
  }
}
