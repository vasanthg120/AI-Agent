import { Body, Controller, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { TwilioWebhookResult, TwilioWebhooksService } from './twilio-webhooks.service';

// Called by Twilio, not by a signed-in user: no JwtAuthGuard — every request is
// authenticated by its X-Twilio-Signature instead (TwilioWebhooksService). Not
// throttled: a refused webhook is a lost call or recording.
@SkipThrottle()
@Controller('twilio/webhooks')
export class TwilioWebhookController {
  constructor(private webhooks: TwilioWebhooksService) {}

  @Post('voice')
  @HttpCode(200)
  async voice(@Req() req: Request, @Res() res: Response, @Query('callId') callId?: string, @Body() _body?: Record<string, unknown>) {
    return this.send(res, await this.webhooks.voice(req, callId));
  }

  @Post('announce')
  @HttpCode(200)
  async announce(@Req() req: Request, @Res() res: Response, @Query('callId') callId?: string, @Body() _body?: Record<string, unknown>) {
    return this.send(res, await this.webhooks.announce(req, callId));
  }

  @Post('dial-status')
  @HttpCode(200)
  async dialStatus(@Req() req: Request, @Res() res: Response, @Query('callId') callId?: string, @Body() _body?: Record<string, unknown>) {
    return this.send(res, await this.webhooks.dialStatus(req, callId));
  }

  @Post('status')
  @HttpCode(200)
  async status(@Req() req: Request, @Res() res: Response, @Query('callId') callId?: string, @Body() _body?: Record<string, unknown>) {
    return this.send(res, await this.webhooks.callStatus(req, callId));
  }

  @Post('recording')
  @HttpCode(200)
  async recording(@Req() req: Request, @Res() res: Response, @Query('callId') callId?: string, @Body() _body?: Record<string, unknown>) {
    return this.send(res, await this.webhooks.recordingReady(req, callId));
  }

  private send(res: Response, result: TwilioWebhookResult) {
    if (result.status === 200) return res.status(200).type('text/xml').send(result.xml);
    return res.sendStatus(result.status);
  }
}
