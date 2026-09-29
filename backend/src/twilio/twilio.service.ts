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
import { normalizePhone } from '../plivo/plivo-phone';
import { UsersService } from '../users/users.service';
import { UpsertTwilioLineDto } from './dto/twilio.dto';
import { TwilioCall, TwilioCallDocument } from './schemas/twilio-call.schema';
import { TwilioLine, TwilioLineDocument } from './schemas/twilio-line.schema';

const PROVIDER = 'twilio';
const CALL_IN_PROGRESS_WINDOW_MS = 2 * 60_000;
const CALL_LOG_LIMIT = 30;

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

export interface TwilioAccountInfo {
  friendlyName?: string;
  // 'Trial' accounts can only call phone numbers verified in the Twilio console.
  type?: string;
  status?: string;
}

export interface TwilioLineView {
  id: string;
  twilioNumber: string;
  numberSid?: string;
  userId: string;
  userName: string;
  agentPhone: string;
  languageCode: string;
  label?: string;
  announceRecording: boolean;
  active: boolean;
}

export interface TwilioNumberView {
  sid: string;
  // Digits only, country code included.
  number: string;
  friendlyName: string;
  voiceCapable: boolean;
  // Where the number sends incoming calls today, and whether that is HaiVE.
  voiceUrl: string;
  pointsToHaive: boolean;
  // The HaiVE line using it, if any.
  lineId?: string;
}

interface TwilioApiNumber {
  sid: string;
  phone_number: string;
  friendly_name?: string;
  voice_url?: string | null;
  capabilities?: { voice?: boolean };
}

// Twilio's errors carry a numeric code; the common ones get a sentence that says
// what to do about it, everything else Twilio's own message.
const TWILIO_ERROR_HINTS: Record<number, string> = {
  20003: 'Twilio rejected the saved Account SID / Auth Token. Reconnect them in Settings → Calling.',
  21210: 'The Twilio number is not verified or not on this account.',
  21211: 'That phone number is not valid. Check the country code and the number.',
  21214: 'That phone number cannot be reached.',
  21215: 'Your Twilio account is not allowed to call this country yet. Turn it on in the Twilio console under Voice → Settings → Geo permissions.',
  21216: 'Your Twilio account is not allowed to call this number (it may be a premium or blocked number).',
  21217: 'That phone number is not valid for calling.',
  21219:
    'This is a Twilio trial account, which can only call numbers verified in the Twilio console (Phone Numbers → Verified Caller IDs). Verify the number there, or upgrade the account.',
};

export function twilioErrorMessage(err: unknown): string {
  const axiosErr = err as AxiosError<{ code?: number; message?: unknown }>;
  const response = axiosErr.response;
  if (!response) return 'Could not reach Twilio. Check the connection and try again.';
  const code = response.data?.code;
  if (code && TWILIO_ERROR_HINTS[code]) return TWILIO_ERROR_HINTS[code];
  if (response.status === 401 || response.status === 403) return TWILIO_ERROR_HINTS[20003];
  const detail = response.data?.message;
  return typeof detail === 'string' && detail.trim() ? `Twilio: ${detail.trim().slice(0, 300)}` : `Twilio returned an error (HTTP ${response.status}).`;
}

const form = (fields: Record<string, string | number | undefined>) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) body.append(key, String(value));
  return body.toString();
};

const e164 = (digits: string) => `+${digits}`;

// Everything a signed-in user does with Twilio: connecting the account, choosing
// numbers, mapping them to people, placing a call, the call log. Twilio's own
// callbacks are handled by TwilioWebhooksService.
@Injectable()
export class TwilioService {
  private readonly logger = new Logger(TwilioService.name);

  constructor(
    @InjectModel(TwilioLine.name) private lineModel: Model<TwilioLineDocument>,
    @InjectModel(TwilioCall.name) private callModel: Model<TwilioCallDocument>,
    private integrations: IntegrationsService,
    private users: UsersService,
    private http: HttpService,
    private config: ConfigService,
  ) {}

  get apiBaseUrl(): string {
    return this.config.get<string>('twilio.apiBaseUrl') ?? 'https://api.twilio.com';
  }

  /** Where Twilio can reach this backend from the internet; '' when not set up. */
  get publicBaseUrl(): string {
    return this.config.get<string>('twilio.publicBaseUrl') ?? '';
  }

  get defaultCountryCode(): string {
    return this.config.get<string>('twilio.defaultCountryCode') ?? '91';
  }

  normalize(input: string): string | null {
    // A number typed with a leading "+" already carries its country code — never
    // prepend the default to it, whatever its length.
    const trimmed = (input ?? '').trim();
    if (trimmed.startsWith('+')) {
      const digits = trimmed.replace(/\D/g, '');
      return digits.length >= 8 && digits.length <= 15 ? digits : null;
    }
    return normalizePhone(input, this.defaultCountryCode);
  }

  webhookUrls(): { voice: string; status: string } | null {
    const base = this.publicBaseUrl;
    return base ? { voice: `${base}/twilio/webhooks/voice`, status: `${base}/twilio/webhooks/status` } : null;
  }

  private accountUrl(creds: TwilioCredentials, path = ''): string {
    return `${this.apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}${path}.json`;
  }

  private auth(creds: TwilioCredentials) {
    return { username: creds.accountSid, password: creds.authToken };
  }

  // ---- account connection ------------------------------------------------

  async getCredentials(organizationId: string): Promise<TwilioCredentials | null> {
    const auth = await this.integrations.resolveAuth(organizationId, PROVIDER);
    if (!auth || auth.authType !== 'basic' || !auth.credentials.username || !auth.credentials.password) return null;
    return { accountSid: auth.credentials.username, authToken: auth.credentials.password };
  }

  private async fetchAccount(creds: TwilioCredentials): Promise<TwilioAccountInfo> {
    const { data } = await firstValueFrom(
      this.http.get<{ friendly_name?: string; type?: string; status?: string }>(this.accountUrl(creds), {
        auth: this.auth(creds),
        timeout: 15_000,
      }),
    );
    return { friendlyName: data.friendly_name, type: data.type, status: data.status };
  }

  async status(organizationId: string, withAccount = false): Promise<{ connected: boolean; accountSidMasked?: string; account?: TwilioAccountInfo | null }> {
    const creds = await this.getCredentials(organizationId);
    if (!creds) return { connected: false };
    const sid = creds.accountSid;
    const masked = `${sid.slice(0, 4)}${'•'.repeat(Math.max(0, sid.length - 8))}${sid.slice(-4)}`;
    if (!withAccount) return { connected: true, accountSidMasked: masked };
    // The account type (Trial / Full) changes what can be called; a failed read
    // is not fatal here — the page just can't show it.
    const account = await this.fetchAccount(creds).catch(() => null);
    return { connected: true, accountSidMasked: masked, account };
  }

  /** Verifies the pair with a free read of the account, and only then saves it. */
  async connect(organizationId: string, accountSid: string, authToken: string) {
    const creds = { accountSid, authToken };
    try {
      await this.fetchAccount(creds);
    } catch (err) {
      const status = (err as AxiosError).response?.status;
      throw new BadRequestException(
        status === 401 || status === 403 || status === 404
          ? 'Twilio did not accept this Account SID and Auth Token. Copy both from the "Account Info" box on the Twilio console home page.'
          : twilioErrorMessage(err),
      );
    }
    await this.integrations.connectWithAuth(organizationId, PROVIDER, {
      authType: 'basic',
      credentials: { username: accountSid, password: authToken },
      baseUrl: this.apiBaseUrl,
    } as ConnectIntegrationDto);
    return this.status(organizationId, true);
  }

  disconnect(organizationId: string): Promise<void> {
    return this.integrations.disconnect(organizationId, PROVIDER);
  }

  private async requireCredentials(organizationId: string): Promise<TwilioCredentials> {
    const creds = await this.getCredentials(organizationId);
    if (!creds) throw new BadRequestException('Twilio is not connected yet. Connect it in Settings → Calling.');
    return creds;
  }

  // ---- numbers on the Twilio account ---------------------------------------

  private async fetchNumbers(creds: TwilioCredentials): Promise<TwilioApiNumber[]> {
    try {
      const { data } = await firstValueFrom(
        this.http.get<{ incoming_phone_numbers?: TwilioApiNumber[] }>(this.accountUrl(creds, '/IncomingPhoneNumbers'), {
          auth: this.auth(creds),
          params: { PageSize: 200 },
          timeout: 20_000,
        }),
      );
      return data.incoming_phone_numbers ?? [];
    } catch (err) {
      throw new BadRequestException(twilioErrorMessage(err));
    }
  }

  /** The numbers on the account, with whether each already sends its calls to HaiVE. */
  async listNumbers(organizationId: string): Promise<TwilioNumberView[]> {
    const creds = await this.requireCredentials(organizationId);
    const [numbers, lines] = await Promise.all([this.fetchNumbers(creds), this.lineModel.find({ organizationId }).exec()]);
    const voiceUrl = this.webhookUrls()?.voice;
    const lineByNumber = new Map(lines.map((l) => [l.twilioNumber, l._id.toString()]));
    return numbers.map((n) => {
      const digits = n.phone_number.replace(/\D/g, '');
      return {
        sid: n.sid,
        number: digits,
        friendlyName: n.friendly_name ?? n.phone_number,
        voiceCapable: n.capabilities?.voice !== false,
        voiceUrl: n.voice_url ?? '',
        pointsToHaive: !!voiceUrl && n.voice_url === voiceUrl,
        lineId: lineByNumber.get(digits),
      };
    });
  }

  /** Points a number's incoming calls (and their status reports) at HaiVE — the
   * step that is done by hand in the Plivo console, done here in one call. */
  async configureNumber(organizationId: string, numberSid: string): Promise<void> {
    const creds = await this.requireCredentials(organizationId);
    const urls = this.webhookUrls();
    if (!urls) throw new BadRequestException('This server has no public address yet, so Twilio could not reach it (TWILIO_PUBLIC_BASE_URL).');
    if (!/^PN[0-9a-fA-F]{32}$/.test(numberSid)) throw new BadRequestException('That is not a Twilio number id.');
    try {
      await firstValueFrom(
        this.http.post(
          this.accountUrl(creds, `/IncomingPhoneNumbers/${numberSid}`),
          form({ VoiceUrl: urls.voice, VoiceMethod: 'POST', StatusCallback: urls.status, StatusCallbackMethod: 'POST' }),
          { auth: this.auth(creds), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20_000 },
        ),
      );
    } catch (err) {
      throw new BadRequestException(twilioErrorMessage(err));
    }
  }

  // ---- lines ---------------------------------------------------------------

  async listLines(organizationId: string, onlyUserId?: string): Promise<TwilioLineView[]> {
    const lines = await this.lineModel
      .find({ organizationId, ...(onlyUserId ? { userId: onlyUserId } : {}) })
      .sort({ createdAt: 1 })
      .exec();
    const names = new Map((await this.users.findAll(organizationId)).map((u) => [u._id.toString(), u.name]));
    return lines.map((line) => ({
      id: line._id.toString(),
      twilioNumber: line.twilioNumber,
      numberSid: line.numberSid,
      userId: line.userId,
      userName: names.get(line.userId) ?? 'Unknown user',
      agentPhone: line.agentPhone,
      languageCode: line.languageCode,
      label: line.label,
      announceRecording: line.announceRecording !== false,
      active: line.active,
    }));
  }

  async upsertLine(organizationId: string, dto: UpsertTwilioLineDto): Promise<TwilioLineView[]> {
    const twilioNumber = this.normalize(dto.twilioNumber);
    const agentPhone = this.normalize(dto.agentPhone);
    if (!twilioNumber) throw new BadRequestException('Choose a Twilio number.');
    if (!agentPhone) throw new BadRequestException("Enter the person's phone with its country code, e.g. +44 7700 900123.");
    if (twilioNumber === agentPhone)
      throw new BadRequestException("The person's phone must be different from the Twilio number — Twilio forwards calls from one to the other.");

    const user = await this.users.findById(dto.userId);
    if (!user || user.organizationId !== organizationId) throw new BadRequestException('That user is not in this organization.');

    const existing = await this.lineModel.findOne({ twilioNumber }).exec();
    if (existing && existing.organizationId !== organizationId) {
      throw new ConflictException('This Twilio number is already registered to another organization.');
    }

    // The number must really be on the connected account — also where its id
    // (needed to point it at HaiVE) comes from.
    const creds = await this.requireCredentials(organizationId);
    const onAccount = (await this.fetchNumbers(creds)).find((n) => n.phone_number.replace(/\D/g, '') === twilioNumber);
    if (!onAccount) throw new BadRequestException(`${e164(twilioNumber)} is not a number on the connected Twilio account.`);

    if (dto.configureNumber !== false && (dto.active ?? existing?.active ?? true)) {
      await this.configureNumber(organizationId, onAccount.sid);
    }

    await this.lineModel
      .updateOne(
        { twilioNumber },
        {
          $set: {
            organizationId,
            numberSid: onAccount.sid,
            userId: dto.userId,
            agentPhone,
            languageCode: dto.languageCode ?? existing?.languageCode ?? 'en',
            label: dto.label?.trim() || undefined,
            announceRecording: dto.announceRecording ?? existing?.announceRecording ?? true,
            active: dto.active ?? existing?.active ?? true,
          },
        },
        { upsert: true },
      )
      .exec();
    return this.listLines(organizationId);
  }

  async deleteLine(organizationId: string, id: string): Promise<TwilioLineView[]> {
    if (!isValidObjectId(id)) throw new NotFoundException('Line not found.');
    const result = await this.lineModel.deleteOne({ _id: id, organizationId }).exec();
    if (result.deletedCount === 0) throw new NotFoundException('Line not found.');
    return this.listLines(organizationId);
  }

  findActiveLineFor(organizationId: string, userId: string): Promise<TwilioLineDocument | null> {
    return this.lineModel.findOne({ organizationId, userId, active: true }).sort({ createdAt: 1 }).exec();
  }

  // ---- placing a call -------------------------------------------------------

  /**
   * Click-to-call. Twilio rings the agent's own phone from their Twilio number;
   * when they answer, Twilio asks our voice webhook what to do and we answer
   * "record, and dial the customer" (TwilioWebhooksService.voice).
   * `customerNumber` is already normalized (digits with country code).
   */
  async startCall(user: JwtPayload, customerNumber: string, dealId?: string): Promise<TwilioCallDocument> {
    const creds = await this.requireCredentials(user.organizationId);
    const base = this.publicBaseUrl;
    if (!base) throw new BadRequestException('Calling is not fully set up: the server has no public address for Twilio to call back (TWILIO_PUBLIC_BASE_URL).');

    const line = await this.findActiveLineFor(user.organizationId, user.sub);
    if (!line)
      throw new BadRequestException(
        'You do not have a Twilio line yet. Ask an administrator to link a Twilio number and your phone to you in Settings → Calling.',
      );
    if (customerNumber === line.agentPhone || customerNumber === line.twilioNumber) {
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
      twilioNumber: line.twilioNumber,
      agentPhone: line.agentPhone,
      customerNumber,
      dealId,
      languageCode: line.languageCode,
      status: 'initiated',
    });

    const callId = call._id.toString();
    try {
      const { data } = await firstValueFrom(
        this.http.post<{ sid?: string }>(
          this.accountUrl(creds, '/Calls'),
          form({
            To: e164(line.agentPhone),
            From: e164(line.twilioNumber),
            Url: `${base}/twilio/webhooks/voice?callId=${callId}`,
            Method: 'POST',
            StatusCallback: `${base}/twilio/webhooks/status?callId=${callId}`,
            StatusCallbackMethod: 'POST',
            Timeout: 45,
          }),
          { auth: this.auth(creds), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20_000 },
        ),
      );
      call.callSid = data.sid;
      await call.save();
      return call;
    } catch (err) {
      const message = twilioErrorMessage(err);
      this.logger.warn(`Twilio call for user ${user.sub} failed to start: ${message}`);
      call.status = 'failed';
      call.failureReason = message;
      await call.save();
      throw new BadRequestException(message);
    }
  }

  // ---- call log -------------------------------------------------------------

  listCalls(user: JwtPayload, orgWide: boolean): Promise<TwilioCallDocument[]> {
    return this.callModel
      .find({ organizationId: user.organizationId, ...(orgWide ? {} : { userId: user.sub }) })
      .sort({ createdAt: -1 })
      .limit(CALL_LOG_LIMIT)
      .exec();
  }

  async getCallForUser(user: JwtPayload, id: string, orgWide: boolean): Promise<TwilioCallDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Call not found.');
    const call = await this.callModel.findOne({ _id: id, organizationId: user.organizationId, ...(orgWide ? {} : { userId: user.sub }) }).exec();
    if (!call) throw new NotFoundException('Call not found.');
    return call;
  }

  hasCallInProgress(userId: string): Promise<boolean> {
    return this.callModel
      .exists({ userId, status: { $in: ['initiated', 'in_progress'] }, createdAt: { $gte: new Date(Date.now() - CALL_IN_PROGRESS_WINDOW_MS) } })
      .then((doc) => !!doc);
  }
}
