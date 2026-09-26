import { Body, Controller, Get, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { PreviewVoiceDto, UpdateVoiceOrganizationDto, UpdateVoicePreferenceDto } from './dto/update-voice-settings.dto';
import { assertVoiceAllowed } from './voice-access';
import { VoiceConfigService } from './voice-config.service';
import { VoiceSpeechService } from './voice-speech.service';

// Previews are served from cache after the first play of each voice, so this
// can be looser than the speak limit — a person auditioning voices clicks
// through many in a minute.
const PREVIEW_THROTTLE = { default: { limit: 60, ttl: 60_000 } };

// Any signed-in member may read the configuration and set their own voice
// (when the organization allows it); only an owner/admin changes the
// organization's defaults — the same split as the notification policy.
@UseGuards(JwtAuthGuard)
@Controller('voice/config')
export class VoiceConfigController {
  constructor(
    private config: VoiceConfigService,
    private speech: VoiceSpeechService,
  ) {}

  @Get()
  get(@CurrentUser() user: JwtPayload) {
    return this.config.getConfig(user);
  }

  @Put('organization')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  updateOrganization(@CurrentUser() user: JwtPayload, @Body() dto: UpdateVoiceOrganizationDto, @Req() req: Request) {
    return this.config.updateOrganization(user, dto, req.ip);
  }

  @Put('me')
  updateMine(@CurrentUser() user: JwtPayload, @Body() dto: UpdateVoicePreferenceDto, @Req() req: Request) {
    return this.config.updateMyPreference(user, dto, req.ip);
  }

  @Post('voices/:voiceId/preview')
  @Throttle(PREVIEW_THROTTLE)
  async preview(
    @CurrentUser() user: JwtPayload,
    @Param('voiceId') voiceId: string,
    @Body() dto: PreviewVoiceDto,
    @Res() res: Response,
  ) {
    assertVoiceAllowed(user);
    const { audio, contentType } = await this.speech.preview(user, voiceId, dto.personality);
    res.set({ 'Content-Type': contentType });
    res.send(audio);
  }
}
