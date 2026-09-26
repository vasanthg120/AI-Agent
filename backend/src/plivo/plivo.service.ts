import { HttpService } from '@nestjs/axios';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { AxiosError } from 'axios';
import { Model, isValidObjectId } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ConnectIntegrationDto } from '../integrations/dto/connect-integration.dto';
import { IntegrationsService } from '../integrations/integrations.service';
import { UsersService } from '../users/users.service';
import { StartPlivoCallDto, UpsertPlivoLineDto } from './dto/plivo.dto';
import { maskPhone, normalizePhone } from './plivo-phone';
import { PlivoCall, PlivoCallDocument } from './schemas/plivo-call.schema';
import { PlivoLine, PlivoLineDocument } from './schemas/plivo-line.schema';

const PROVIDER = 'plivo';
// A second click while one call is still being set up would ring the agent's
// phone twice and bill two calls.
const CALL_IN_PROGRESS_WINDOW_MS = 2 * 60_000;
const CALL_LOG_LIMIT = 30;

export interface PlivoCredentials {
  authId: string;
  authToken: string;
}

export interface PlivoLineView {
  id: string;
  plivoNumber: string;
  userId: string;
  userName: string;
  agentPhone: string;
  languageCode: string;
  label?: string;
  active: boolean;
}

// What Plivo's errors look like to a person: the actionable part of its own
// message ("...is not a verified number", "compliance application ..."), never
// a raw HTTP dump.
function plivoErrorMessage(err: unknown): string {
  const axiosErr = err as AxiosError<{ error?: unknown; message?: unknown }>;
  const response = axiosErr.response;
  if (!response) return 'Could not reach Plivo. Check the connection and try again.';
  if (response.status === 401 || response.status === 403) {
    return 'Plivo rejected the saved Auth ID / Auth Token. Reconnect them in Settings → Calling.';
  }
  const detail = response.data?.error ?? response.data?.message;
  return typeof detail === 'string' && detail.trim()
    ? `Plivo: ${detail.trim().slice(0, 300)}`
    : `Plivo returned an error (HTTP ${response.status}).`;
}

// Everything about talking to Plivo that a signed-in user does: connecting the
// account, mapping Plivo numbers to agents, placing a call, and seeing the call
// log. Plivo's own callbacks are handled separately (PlivoWebhooksService).
@Injectable()
export class PlivoService {
  private readonly logger = new Logger(PlivoService.name);

  constructor(
    @InjectModel(PlivoLine.name) private lineModel: Model<PlivoLineDocument>,
    @InjectModel(PlivoCall.name) private callModel: Model<PlivoCallDocument>,
    private integrations: IntegrationsService,
    private users: UsersService,
    private http: HttpService,
    private config: ConfigService,
  ) {}

  get apiBaseUrl(): string {
    return this.config.get<string>('plivo.apiBaseUrl') ?? 'https://api.plivo.com';
  }

  /** Where Plivo can reach this backend from the internet; '' when not set up. */
  get publicBaseUrl(): string {
    return this.config.get<string>('plivo.publicBaseUrl') ?? '';
  }

  get defaultCountryCode(): string {
    return this.config.get<string>('plivo.defaultCountryCode') ?? '91';
  }

  normalize(input: string): string | null {
    return normalizePhone(input, this.defaultCountryCode);
  }

  /** The URLs to give Plivo (its Application's Answer / Hangup URLs). null until
   * the public base URL is configured — without it Plivo cannot reach us and
   * every webhook would be refused anyway. */
  webhookUrls(): { answer: string; hangup: string } | null {
    const base = this.publicBaseUrl;
    return base ? { answer: `${base}/plivo/webhooks/answer`, hangup: `${base}/plivo/webhooks/hangup` } : null;
  }

  // ---- account connection ------------------------------------------------

  async getCredentials(organizationId: string): Promise<PlivoCredentials | null> {
    const auth = await this.integrations.resolveAuth(organizationId, PROVIDER);
    if (!auth || auth.authType !== 'basic' || !auth.credentials.username || !auth.credentials.password) return null;
    return { authId: auth.credentials.username, authToken: auth.credentials.password };
  }

  async status(organizationId: string): Promise<{ connected: boolean; authIdMasked?: string }> {
    const creds = await this.getCredentials(organizationId);
    if (!creds) return { connected: false };
    const { authId } = creds;
    return { connected: true, authIdMasked: authId.length > 6 ? `${authId.slice(0, 4)}${'•'.repeat(authId.length - 6)}${authId.slice(-2)}` : '••••' };
  }

  /** Verifies the pair with a free read of the account, and only then saves it —
   * so a typo is caught here, not on the first customer call. */
  async connect(organizationId: string, authId: string, authToken: string): Promise<{ connected: boolean; authIdMasked?: string }> {
    try {
      await firstValueFrom(
        this.http.get(`${this.apiBaseUrl}/v1/Account/${encodeURIComponent(authId)}/`, {
          auth: { username: authId, password: authToken },
          timeout: 15_000,
        }),
      );
    } catch (err) {
      const status = (err as AxiosError).response?.status;
      throw new BadRequestException(
        status === 401 || status === 403 || status === 404
          ? 'Plivo did not accept this Auth ID and Auth Token. Copy both from the top of the Plivo console overview page.'
          : plivoErrorMessage(err),
      );
    }
    await this.integrations.connectWithAuth(organizationId, PROVIDER, {
      authType: 'basic',
      credentials: { username: authId, password: authToken },
      baseUrl: this.apiBaseUrl,
    } as ConnectIntegrationDto);
    return this.status(organizationId);
  }

  disconnect(organizationId: string): Promise<void> {
    return this.integrations.disconnect(organizationId, PROVIDER);
  }

  // ---- lines: which Plivo number rings which agent's phone ------------------

  async listLines(organizationId: string, onlyUserId?: string): Promise<PlivoLineView[]> {
    const lines = await this.lineModel.find({ organizationId, ...(onlyUserId ? { userId: onlyUserId } : {}) }).sort({ createdAt: 1 }).exec();
    const names = new Map((await this.users.findAll(organizationId)).map((u) => [u._id.toString(), u.name]));
    return lines.map((line) => ({
      id: line._id.toString(),
      plivoNumber: line.plivoNumber,
      userId: line.userId,
      userName: names.get(line.userId) ?? 'Unknown user',
      agentPhone: line.agentPhone,
      languageCode: line.languageCode,
      label: line.label,
      active: line.active,
    }));
  }

  async upsertLine(organizationId: string, dto: UpsertPlivoLineDto): Promise<PlivoLineView[]> {
    const plivoNumber = this.normalize(dto.plivoNumber);
    const agentPhone = this.normalize(dto.agentPhone);
    if (!plivoNumber) throw new BadRequestException('Enter the Plivo number with its country code, e.g. 91 80 1234 5678.');
    if (!agentPhone) throw new BadRequestException("Enter the agent's phone number with its country code, e.g. 91 98765 43210.");
    if (plivoNumber === agentPhone) throw new BadRequestException("The agent's phone must be different from the Plivo number — Plivo forwards calls from one to the other.");

    const user = await this.users.findById(dto.userId);
    if (!user || user.organizationId !== organizationId) throw new BadRequestException('That user is not in this organization.');

    const existing = await this.lineModel.findOne({ plivoNumber }).exec();
    if (existing && existing.organizationId !== organizationId) {
      throw new ConflictException('This Plivo number is already registered to another organization.');
    }

    await this.lineModel
      .updateOne(
        { plivoNumber },
        {
          $set: {
            organizationId,
            userId: dto.userId,
            agentPhone,
            languageCode: dto.languageCode ?? existing?.languageCode ?? 'en',
            label: dto.label?.trim() || undefined,
            active: dto.active ?? existing?.active ?? true,
          },
        },
        { upsert: true },
      )
      .exec();
    return this.listLines(organizationId);
  }

  async deleteLine(organizationId: string, id: string): Promise<PlivoLineView[]> {
    if (!isValidObjectId(id)) throw new NotFoundException('Line not found.');
    const result = await this.lineModel.deleteOne({ _id: id, organizationId }).exec();
    if (result.deletedCount === 0) throw new NotFoundException('Line not found.');
    return this.listLines(organizationId);
  }

  // ---- placing a call -------------------------------------------------------

  /**
   * Click-to-call. Plivo first rings the agent's own phone from their Plivo
   * number; when the agent answers, Plivo asks our Answer webhook what to do
   * next and we answer with "record, and dial the customer" (see
   * PlivoWebhooksService.answer). The customer sees the Plivo number — which is
   * also what makes the call recordable, since it goes through Plivo.
   */
  async startCall(user: JwtPayload, dto: StartPlivoCallDto): Promise<PlivoCallDocument> {
    const creds = await this.getCredentials(user.organizationId);
    if (!creds) throw new BadRequestException('Plivo is not connected yet. Ask an administrator to connect it in Settings → Calling.');
    const urls = this.webhookUrls();
    if (!urls) {
      throw new BadRequestException('Calling is not fully set up: the server has no public address for Plivo to call back (PLIVO_PUBLIC_BASE_URL).');
    }

    const line = await this.lineModel.findOne({ organizationId: user.organizationId, userId: user.sub, active: true }).sort({ createdAt: 1 }).exec();
    if (!line) throw new BadRequestException('You do not have a Plivo line yet. Ask an administrator to link a Plivo number and your phone to you in Settings → Calling.');

    const customerNumber = this.normalize(dto.customerNumber);
    if (!customerNumber) throw new BadRequestException('Enter the customer number with its country code, e.g. 91 98765 43210.');
    if (customerNumber === line.agentPhone || customerNumber === line.plivoNumber) {
      throw new BadRequestException('That is your own number. Enter the customer’s number.');
    }

    const recent = await this.callModel
      .findOne({ userId: user.sub, status: { $in: ['initiated', 'in_progress'] }, createdAt: { $gte: new Date(Date.now() - CALL_IN_PROGRESS_WINDOW_MS) } })
      .exec();
    if (recent) throw new ConflictException('A call is already being set up. Answer your phone, or wait a minute before trying again.');

    const call = await this.callModel.create({
      organizationId: user.organizationId,
      userId: user.sub,
      direction: 'outbound',
      plivoNumber: line.plivoNumber,
      agentPhone: line.agentPhone,
      customerNumber,
      dealId: dto.dealId,
      languageCode: line.languageCode,
      status: 'initiated',
    });

    const callId = call._id.toString();
    try {
      const { data } = await firstValueFrom(
        this.http.post<{ request_uuid?: string }>(
          `${this.apiBaseUrl}/v1/Account/${encodeURIComponent(creds.authId)}/Call/`,
          {
            from: line.plivoNumber,
            to: line.agentPhone,
            answer_url: `${urls.answer}?callId=${callId}`,
            answer_method: 'POST',
            hangup_url: `${urls.hangup}?callId=${callId}`,
            hangup_method: 'POST',
            ring_timeout: 45,
          },
          { auth: { username: creds.authId, password: creds.authToken }, timeout: 20_000 },
        ),
      );
      call.requestUuid = data.request_uuid;
      await call.save();
      return call;
    } catch (err) {
      const message = plivoErrorMessage(err);
      this.logger.warn(`Plivo call for user ${user.sub} failed to start: ${message}`);
      call.status = 'failed';
      call.failureReason = message;
      await call.save();
      throw new BadRequestException(message);
    }
  }

  // ---- call log -------------------------------------------------------------

  /** Recent calls: the caller's own, or the whole organization's for an admin. */
  listCalls(user: JwtPayload, orgWide: boolean): Promise<PlivoCallDocument[]> {
    return this.callModel
      .find({ organizationId: user.organizationId, ...(orgWide ? {} : { userId: user.sub }) })
      .sort({ createdAt: -1 })
      .limit(CALL_LOG_LIMIT)
      .exec();
  }

  async getCallForUser(user: JwtPayload, id: string, orgWide: boolean): Promise<PlivoCallDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Call not found.');
    const call = await this.callModel.findOne({ _id: id, organizationId: user.organizationId, ...(orgWide ? {} : { userId: user.sub }) }).exec();
    if (!call) throw new NotFoundException('Call not found.');
    return call;
  }

  mask(digits: string): string {
    return maskPhone(digits);
  }
}
