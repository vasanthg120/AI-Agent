import { BadGatewayException, Body, Controller, Delete, Get, HttpException, HttpStatus, Logger, NotFoundException, Param, Post, Query, Redirect, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Permission, PermissionExempt } from '../common/permissions/permission.decorator';
import { ConnectSquareDto } from './dto/connect-square.dto';
import { CreateSquarePaymentDto } from './dto/create-square-payment.dto';
import { SaveSquareAppCredentialsDto } from './dto/save-square-app-credentials.dto';
import { TestSquareConnectionDto } from './dto/test-square-connection.dto';
import { extractSquarePaymentDetails } from './square-payment-details';
import { SquareReconciliationService } from './square-reconciliation.service';
import { SquareService } from './square.service';

// Primary connect path, surfaced in the UI (see square.service.ts's class
// comment): a direct access-token + Application ID paste (POST connect —
// Square's "Personal Access Token" model, for an org's own account), with
// a test-connection route to validate credentials before committing. The
// OAuth path (connect-url/app-credentials/callback below — for a DIFFERENT
// merchant account, using this org's own saved app credentials) still
// exists and works, kept per the user's own "do not silently break an
// existing OAuth dependency on Application Secret" instruction, but is no
// longer exposed in the simplified connect form. Payment-write routes get
// the same admin-only gate integrations.controller.ts's crm/sync uses for
// money-moving actions; read routes (status/list/get) are open to any
// authenticated org member.
@Permission('integrations')
@Controller('square')
export class SquareController {
  private readonly logger = new Logger(SquareController.name);

  constructor(
    private square: SquareService,
    private reconciliation: SquareReconciliationService,
    private config: ConfigService,
  ) {}

  // Fire-and-forget: a brand-new connection's first payment pull covers the
  // last year of history (initialSync) and can take a while with
  // pagination — the connect response shouldn't wait on it. Never silently
  // dropped on failure either way: reconcileAll's own 30-minute cron will
  // pick this org up and retry regardless (same resilience precedent this
  // file's own class comment describes for providers without webhooks).
  private kickOffInitialSync(organizationId: string): void {
    void this.reconciliation.initialSync(organizationId).catch((err) => {
      this.logger.error(`Square initial sync failed for org ${organizationId}: ${(err as Error).message}`);
    });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Post('connect')
  async connect(@CurrentUser() user: JwtPayload, @Body() dto: ConnectSquareDto) {
    const result = await this.square.connect(user.organizationId, dto.applicationId.trim(), dto.accessToken.trim(), dto.environment);
    this.kickOffInitialSync(user.organizationId);
    return result;
  }

  // Validates credentials against Square (ListLocations) WITHOUT saving
  // anything — lets the user confirm the Application ID/Access Token/
  // Environment combination works before committing to Connect.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Post('test-connection')
  testConnection(@Body() dto: TestSquareConnectionDto) {
    return this.square.testConnection(dto.accessToken.trim(), dto.environment);
  }

  // This organization's own Square Developer Console app (Application ID/
  // Secret) — collected before the first OAuth redirect. Never returns the
  // secret back (see SquareService.getAppCredentialsStatus), only whether
  // one is on file.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Post('app-credentials')
  saveAppCredentials(@CurrentUser() user: JwtPayload, @Body() dto: SaveSquareAppCredentialsDto) {
    return this.square.saveAppCredentials(user.organizationId, dto.applicationId.trim(), dto.applicationSecret.trim(), dto.webhookSecret?.trim());
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Get('app-credentials')
  getAppCredentialsStatus(@CurrentUser() user: JwtPayload) {
    return this.square.getAppCredentialsStatus(user.organizationId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Get('connect-url')
  async getConnectUrl(@CurrentUser() user: JwtPayload, @Query('environment') environment: 'sandbox' | 'production' = 'sandbox') {
    return { url: await this.square.buildAuthorizeUrl(user.organizationId, environment) };
  }

  // Called by Square, not a signed-in browser — the state param (a signed
  // JWT, verified inside handleCallback) is what actually authenticates
  // this request, same as Zoho/Xero's callbacks.
  @Get('callback')
  @Redirect()
  @PermissionExempt('public')
  async callback(@Query('code') code?: string, @Query('state') state?: string, @Query('error') error?: string) {
    const frontendUrl = this.config.get<string>('corsOrigin');
    if (error || !code || !state) {
      this.logger.warn(`Square callback missing params (error=${error})`);
      return { url: `${frontendUrl}/settings/integrations?square=error`, statusCode: 302 };
    }
    try {
      const result = await this.square.handleCallback(code, state);
      const outcome = result.countrySupported === false ? 'unsupported_country' : 'connected';
      if (result.organizationId) this.kickOffInitialSync(result.organizationId);
      return { url: `${frontendUrl}/settings/integrations?square=${outcome}`, statusCode: 302 };
    } catch (err) {
      this.logger.error(`Square callback failed: ${(err as Error).message}`);
      return { url: `${frontendUrl}/settings/integrations?square=error`, statusCode: 302 };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('status')
  getStatus(@CurrentUser() user: JwtPayload) {
    return this.square.getStatus(user.organizationId);
  }

  // Safe historical reconciliation: re-reads this org's own Square payments (full history) and re-links each to the
  // Square Invoice that billed it. Idempotent on providerPaymentId; writes ONLY square_payment_transactions — never
  // a quote, invoice or existing payment record. Which quote a payment settles is then derived from exact
  // identifiers at read time (see quote-payment-status.ts), so a payment with no identifier stays unmatched.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Post('reconcile-history')
  reconcileHistory(@CurrentUser() user: JwtPayload) {
    return this.reconciliation.initialSync(user.organizationId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Delete('disconnect')
  disconnect(@CurrentUser() user: JwtPayload) {
    return this.square.disconnect(user.organizationId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Post('payments')
  createPayment(@CurrentUser() user: JwtPayload, @Body() dto: CreateSquarePaymentDto) {
    return this.square.createPayment(user.organizationId, {
      sourceId: dto.sourceId,
      amount: dto.amount,
      currency: dto.currency,
      idempotencyKey: dto.idempotencyKey,
      customerId: dto.customerId,
      orderId: dto.orderId,
      referenceId: dto.referenceId,
      note: dto.note,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Get('payments')
  listPayments(@CurrentUser() user: JwtPayload, @Query('beginTime') beginTime?: string, @Query('endTime') endTime?: string, @Query('cursor') cursor?: string) {
    return this.square.listPayments(user.organizationId, { beginTime, endTime, cursor });
  }

  // Sanitized detail view for one payment (org-scoped through the org's own
  // Square credentials): the allowlisted fields only, so card fingerprints
  // and the like never reach the browser. Used for rows synced before
  // details were stored; one call per click, never per list row.
  @UseGuards(JwtAuthGuard)
  @Get('payments/:paymentId/details')
  async getPaymentDetails(@CurrentUser() user: JwtPayload, @Param('paymentId') paymentId: string) {
    try {
      const payment = await this.square.getPayment(user.organizationId, paymentId);
      return { id: paymentId, details: extractSquarePaymentDetails(payment) };
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 429) throw new HttpException('Square is rate-limiting requests — try again in a moment.', HttpStatus.TOO_MANY_REQUESTS);
      if (status === 404) throw new NotFoundException('Square has no such payment.');
      if (err instanceof HttpException) throw err;
      this.logger.warn(`Square payment detail fetch failed: ${(err as Error).message}`);
      throw new BadGatewayException('Could not load payment details from Square.');
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('payments/:paymentId')
  getPayment(@CurrentUser() user: JwtPayload, @Param('paymentId') paymentId: string) {
    return this.square.getPayment(user.organizationId, paymentId);
  }
}
