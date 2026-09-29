import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ConnectTwilioDto, UpsertTwilioLineDto } from './dto/twilio.dto';
import { TwilioService } from './twilio.service';

// Setting Twilio up — owners and admins only. Placing calls and the call log go
// through /calling, which covers Plivo and Twilio together.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin')
@Controller('twilio')
export class TwilioController {
  constructor(private twilio: TwilioService) {}

  @Get('config')
  async config(@CurrentUser() user: JwtPayload) {
    const [status, lines] = await Promise.all([this.twilio.status(user.organizationId, true), this.twilio.listLines(user.organizationId)]);
    return {
      ...status,
      webhookUrls: this.twilio.webhookUrls(),
      publicUrlConfigured: this.twilio.publicBaseUrl !== '',
      lines,
    };
  }

  @Post('connect')
  connect(@CurrentUser() user: JwtPayload, @Body() dto: ConnectTwilioDto) {
    return this.twilio.connect(user.organizationId, dto.accountSid.trim(), dto.authToken.trim());
  }

  @Delete('connect')
  async disconnect(@CurrentUser() user: JwtPayload) {
    await this.twilio.disconnect(user.organizationId);
    return { connected: false };
  }

  @Get('numbers')
  numbers(@CurrentUser() user: JwtPayload) {
    return this.twilio.listNumbers(user.organizationId);
  }

  // Re-point a number's incoming calls at HaiVE (e.g. after the public address changed).
  @Post('numbers/:sid/configure')
  async configure(@CurrentUser() user: JwtPayload, @Param('sid') sid: string) {
    await this.twilio.configureNumber(user.organizationId, sid);
    return this.twilio.listNumbers(user.organizationId);
  }

  @Put('lines')
  upsertLine(@CurrentUser() user: JwtPayload, @Body() dto: UpsertTwilioLineDto) {
    return this.twilio.upsertLine(user.organizationId, dto);
  }

  @Delete('lines/:id')
  deleteLine(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.twilio.deleteLine(user.organizationId, id);
  }
}
