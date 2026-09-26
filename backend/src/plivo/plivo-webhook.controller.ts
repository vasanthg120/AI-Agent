import { Body, Controller, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { PlivoWebhooksService, WebhookResult } from './plivo-webhooks.service';

// Called by Plivo, not by a signed-in user, so there is deliberately no
// JwtAuthGuard: every request is authenticated by its Plivo signature instead
// (see PlivoWebhooksService). Not throttled — Plivo legitimately bursts on a
// busy line, and a refused webhook is a lost recording. A request that fails
// verification gets a bare 403 and no explanation.
@SkipThrottle()
@Controller('plivo/webhooks')
export class PlivoWebhookController {
  constructor(private webhooks: PlivoWebhooksService) {}

  @Post('answer')
  @HttpCode(200)
  async answer(@Req() req: Request, @Res() res: Response, @Query('callId') callId?: string, @Body() _body?: Record<string, unknown>) {
    return this.send(res, await this.webhooks.answer(req, callId));
  }

  @Post('recording')
  @HttpCode(200)
  async recording(@Req() req: Request, @Res() res: Response, @Query('callId') callId?: string, @Body() _body?: Record<string, unknown>) {
    return this.send(res, await this.webhooks.recordingReady(req, callId));
  }

  @Post('hangup')
  @HttpCode(200)
  async hangup(@Req() req: Request, @Res() res: Response, @Query('callId') callId?: string, @Body() _body?: Record<string, unknown>) {
    return this.send(res, await this.webhooks.hangup(req, callId));
  }

  private send(res: Response, result: WebhookResult) {
    if (result.status === 200) return res.status(200).type('text/xml').send(result.xml);
    return res.sendStatus(result.status);
  }
}
