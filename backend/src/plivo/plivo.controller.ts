import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ConnectPlivoDto, StartPlivoCallDto, UpsertPlivoLineDto } from './dto/plivo.dto';
import { PlivoWebhooksService } from './plivo-webhooks.service';
import { PlivoCallDocument } from './schemas/plivo-call.schema';
import { PlivoService } from './plivo.service';

const canManage = (user: JwtPayload) => user.roles.some((role) => role === 'owner' || role === 'admin');

// What a call looks like to the browser — the fields it shows, with the ids it
// needs to link into Call Library. Never the recording URL.
function toCallView(call: PlivoCallDocument) {
  return {
    id: call._id.toString(),
    direction: call.direction,
    customerNumber: call.customerNumber,
    plivoNumber: call.plivoNumber,
    status: call.status,
    failureReason: call.failureReason,
    durationSeconds: call.durationSeconds ?? call.recordingDurationSeconds,
    importStatus: call.importStatus,
    importError: call.importError,
    sessionId: call.sessionId,
    userId: call.userId,
    createdAt: call.createdAt,
    updatedAt: call.updatedAt,
  };
}

// An import runs inside this process, so a restart mid-import leaves it marked
// "pending" for good. Past this long without a change it is treated as lost and
// may be retried, exactly like a failed one.
const IMPORT_STUCK_AFTER_MS = 15 * 60_000;

// Owners and admins connect the Plivo account and decide which Plivo number
// rings whose phone; every signed-in user can see their own line and place a
// call from it.
@UseGuards(JwtAuthGuard)
@Controller('plivo')
export class PlivoController {
  constructor(
    private plivo: PlivoService,
    private webhooks: PlivoWebhooksService,
  ) {}

  @Get('config')
  async config(@CurrentUser() user: JwtPayload) {
    const manage = canManage(user);
    const [status, lines] = await Promise.all([
      this.plivo.status(user.organizationId),
      this.plivo.listLines(user.organizationId, manage ? undefined : user.sub),
    ]);
    return {
      ...status,
      canManage: manage,
      // Where Plivo must be pointed (only useful to whoever configures it).
      webhookUrls: manage ? this.plivo.webhookUrls() : null,
      publicUrlConfigured: this.plivo.publicBaseUrl !== '',
      defaultCountryCode: this.plivo.defaultCountryCode,
      lines,
      // Whether *this* person can place a call right now.
      canCall: status.connected && this.plivo.publicBaseUrl !== '' && lines.some((l) => l.userId === user.sub && l.active),
    };
  }

  @Post('connect')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  connect(@CurrentUser() user: JwtPayload, @Body() dto: ConnectPlivoDto) {
    return this.plivo.connect(user.organizationId, dto.authId.trim(), dto.authToken.trim());
  }

  @Delete('connect')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  async disconnect(@CurrentUser() user: JwtPayload) {
    await this.plivo.disconnect(user.organizationId);
    return { connected: false };
  }

  @Put('lines')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  upsertLine(@CurrentUser() user: JwtPayload, @Body() dto: UpsertPlivoLineDto) {
    return this.plivo.upsertLine(user.organizationId, dto);
  }

  @Delete('lines/:id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  deleteLine(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.plivo.deleteLine(user.organizationId, id);
  }

  // Each call is a real, billed phone call — a tight limit on top of the
  // service's own "one call being set up at a time".
  @Post('calls')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async startCall(@CurrentUser() user: JwtPayload, @Body() dto: StartPlivoCallDto) {
    return toCallView(await this.plivo.startCall(user, dto));
  }

  @Get('calls')
  async calls(@CurrentUser() user: JwtPayload, @Query('scope') scope?: string) {
    const calls = await this.plivo.listCalls(user, scope === 'org' && canManage(user));
    return calls.map(toCallView);
  }

  // A recording that failed to import (e.g. the organization was out of credits
  // at the time), or whose import was lost part-way (e.g. the server restarted),
  // can be tried again once the cause is fixed.
  @Post('calls/:id/retry-import')
  async retryImport(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const call = await this.plivo.getCallForUser(user, id, canManage(user));
    const stuck = call.importStatus === 'pending' && Date.now() - call.updatedAt.getTime() > IMPORT_STUCK_AFTER_MS;
    if (call.importStatus !== 'failed' && !stuck) return toCallView(call);
    await this.webhooks.importRecording(call);
    return toCallView(await this.plivo.getCallForUser(user, id, canManage(user)));
  }
}
