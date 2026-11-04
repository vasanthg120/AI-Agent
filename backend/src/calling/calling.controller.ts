import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Feature } from '../common/app-features';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FeatureGuard } from '../common/guards/feature.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CallingProvider } from './calling-routing';
import { CallingService } from './calling.service';
import { Permission } from '../common/permissions/permission.decorator';

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

  // The Dialer's key for one tap of its call button (a UUID): sending the same
  // key again returns the call it started instead of placing a second one.
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9-]{8,64}$/)
  requestKey?: string;

  // Who is being called, as picked from Contacts — shown back in the call log.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerName?: string;
}

function providerOf(value: string): CallingProvider {
  if (!PROVIDERS.includes(value as CallingProvider)) throw new NotFoundException('Call not found.');
  return value as CallingProvider;
}

// Call Copilot's own gate as well as its permission: an AI role without Call
// Copilot can't place or list calls, the same as it can't open the page.
@UseGuards(JwtAuthGuard, FeatureGuard)
@Feature('call_copilot')
@Permission('call_copilot')
@Controller('calling')
export class CallingController {
  constructor(private calling: CallingService) {}

  // `recheck` asks again whether Plivo/Twilio can reach the server, instead of
  // trusting the last minute's answer ("Check again" on the Dialer).
  @Get('overview')
  overview(@CurrentUser() user: JwtPayload, @Query('recheck') recheck?: string) {
    return this.calling.overview(user, canManage(user), recheck === '1' || recheck === 'true');
  }

  // Customers to call — for people who may place calls.
  @Get('contacts')
  @Permission('call_copilot', 'create')
  contacts(@CurrentUser() user: JwtPayload, @Query('search') search?: string) {
    return this.calling.searchContacts(user, search ?? '');
  }

  // Each call is a real, billed phone call.
  @Post('calls')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  startCall(@CurrentUser() user: JwtPayload, @Body() dto: StartCallDto) {
    return this.calling.startCall(user, dto.customerNumber, {
      dealId: dto.dealId,
      provider: dto.provider,
      requestKey: dto.requestKey,
      customerName: dto.customerName,
    });
  }

  // `before` (an ISO time) pages back through older calls.
  @Get('calls')
  calls(@CurrentUser() user: JwtPayload, @Query('scope') scope?: string, @Query('before') before?: string) {
    const until = before ? new Date(before) : undefined;
    if (until && Number.isNaN(until.getTime())) throw new BadRequestException('Invalid "before" time.');
    return this.calling.listCalls(user, scope === 'org' && canManage(user), until);
  }

  // One of the caller's own calls, as it stands now (the Dialer's live screen).
  @Get('calls/:provider/:id')
  call(@CurrentUser() user: JwtPayload, @Param('provider') provider: string, @Param('id') id: string) {
    return this.calling.getCall(user, providerOf(provider), id);
  }

  @Post('calls/:provider/:id/retry-import')
  retry(@CurrentUser() user: JwtPayload, @Param('provider') provider: string, @Param('id') id: string) {
    return this.calling.retryImport(user, providerOf(provider), id, canManage(user));
  }
}
