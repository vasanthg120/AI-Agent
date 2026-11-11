import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { EncryptionService } from '../common/encryption/encryption.service';
import { assertPublicHttpUrl } from '../common/security/ssrf-guard';
import { SaveLangfuseConfigDto } from './dto/save-langfuse-config.dto';
import { LangfuseConfig, LangfuseConfigDocument } from './schemas/langfuse-config.schema';

const PLATFORM_ID = 'platform';
const MASKED = '••••••••••••';

export interface LangfuseConfigStatus {
  enabled: boolean;
  publicKeyMasked: string | null;
  secretConfigured: boolean;
  baseUrl: string;
  environment: 'development' | 'staging' | 'production';
  samplingRate: number;
  captureInputOutput: boolean;
  connectionStatus: 'untested' | 'connected' | 'error';
  lastTestedAt: Date | null;
  lastSuccessfulTraceAt: Date | null;
  errorMessage: string | null;
}

@Injectable()
export class LangfuseConfigService {
  private readonly logger = new Logger(LangfuseConfigService.name);

  constructor(
    @InjectModel(LangfuseConfig.name) private model: Model<LangfuseConfigDocument>,
    private encryption: EncryptionService,
    private http: HttpService,
  ) {}

  /** The admin-facing shape — never the decrypted secret, only whether one
   * is on file and a fixed masked placeholder, same "don't even decrypt just
   * to mask" approach IntegrationsService.getOAuthAppCredentialsStatus uses. */
  async getStatus(): Promise<LangfuseConfigStatus> {
    const doc = await this.model.findOne({ organizationId: PLATFORM_ID });
    return {
      enabled: doc?.enabled ?? false,
      publicKeyMasked: doc?.publicKeyEncrypted ? MASKED : null,
      secretConfigured: !!doc?.secretKeyEncrypted,
      baseUrl: doc?.baseUrl ?? 'https://cloud.langfuse.com',
      environment: doc?.environment ?? 'production',
      samplingRate: doc?.samplingRate ?? 100,
      captureInputOutput: doc?.captureInputOutput ?? true,
      connectionStatus: doc?.connectionStatus ?? 'untested',
      lastTestedAt: doc?.lastTestedAt ?? null,
      lastSuccessfulTraceAt: doc?.lastSuccessfulTraceAt ?? null,
      errorMessage: doc?.errorMessage ?? null,
    };
  }

  /** Partial update — a field omitted from dto is left exactly as it was,
   * so saving a new sampling rate alone can never wipe out the secret key
   * already on file. Validates baseUrl against SSRF (private/loopback/
   * link-local targets) before persisting a changed one — the same guard
   * dynamic-executor.service.ts/integrations.service.ts already use for
   * this exact "admin types an arbitrary URL this server will later call"
   * shape. */
  async saveConfig(dto: SaveLangfuseConfigDto): Promise<void> {
    if (dto.baseUrl) await assertPublicHttpUrl(dto.baseUrl);
    // Langfuse's own well-documented, stable prefix convention (pk-lf-.../
    // sk-lf-...) — a definite, unambiguous signal the Public Key/Secret Key
    // fields were swapped (confirmed as the real-world cause of a live
    // "Langfuse rejected this public/secret key pair" report: the stored
    // "public" key decrypted to an sk-lf- value and vice versa). Only
    // rejects the one unambiguous case; a key that simply doesn't start
    // with pk-lf- (an older or self-hosted format) is never second-guessed.
    if (dto.publicKey?.startsWith('sk-lf-') || dto.secretKey?.startsWith('pk-lf-')) {
      throw new BadRequestException('The Public Key and Secret Key look swapped — Public Key should start with "pk-lf-", Secret Key with "sk-lf-".');
    }

    const update: Record<string, unknown> = {};
    if (dto.publicKey) update.publicKeyEncrypted = this.encryption.encrypt(dto.publicKey);
    if (dto.secretKey) update.secretKeyEncrypted = this.encryption.encrypt(dto.secretKey);
    if (dto.baseUrl) update.baseUrl = dto.baseUrl;
    if (dto.environment) update.environment = dto.environment;
    if (dto.captureInputOutput !== undefined) update.captureInputOutput = dto.captureInputOutput;
    if (dto.samplingRate !== undefined) update.samplingRate = dto.samplingRate;

    // A credential/base-URL change invalidates whatever the last Test
    // Connection found — never leave a stale "connected" badge showing
    // against credentials that were just replaced.
    if (dto.publicKey || dto.secretKey || dto.baseUrl) {
      update.connectionStatus = 'untested';
      update.lastTestedAt = null;
      update.errorMessage = null;
    }

    await this.model.updateOne({ organizationId: PLATFORM_ID }, { $set: update }, { upsert: true });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.model.updateOne({ organizationId: PLATFORM_ID }, { $set: { enabled } }, { upsert: true });
  }

  /** "Configured" (a DB-existence check, see getStatus above) vs "actually
   * reachable right now" — a minimal authenticated GET against Langfuse's
   * own public API (HTTP Basic auth, public key as username, secret key as
   * password — https://langfuse.com/faq/all/api-authentication): 200 means
   * the key pair is valid, 401/anything else means it isn't. Never throws;
   * never persists "connected" on a failed test — same shape
   * IntegrationsService.verifyPlatformProvider already uses. */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const doc = await this.model.findOne({ organizationId: PLATFORM_ID });
    if (!doc?.publicKeyEncrypted || !doc?.secretKeyEncrypted) {
      return { ok: false, message: 'Save a public key and secret key before testing the connection.' };
    }

    const baseUrl = doc.baseUrl || 'https://cloud.langfuse.com';
    let result: { ok: boolean; message: string };
    try {
      await assertPublicHttpUrl(baseUrl);
      const publicKey = this.encryption.decrypt(doc.publicKeyEncrypted);
      const secretKey = this.encryption.decrypt(doc.secretKeyEncrypted);
      await firstValueFrom(
        this.http.get(`${baseUrl.replace(/\/$/, '')}/api/public/projects`, {
          auth: { username: publicKey, password: secretKey },
          timeout: 10_000,
        }),
      );
      result = { ok: true, message: 'Connected — the key pair was accepted by Langfuse.' };
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const message =
        status === 401 || status === 403
          ? 'Langfuse rejected this public/secret key pair.'
          : `Could not reach Langfuse at this base URL (${(err as Error).message}).`;
      this.logger.warn(`Langfuse test connection failed: ${message}`);
      result = { ok: false, message };
    }

    await this.model.updateOne(
      { organizationId: PLATFORM_ID },
      { $set: { connectionStatus: result.ok ? 'connected' : 'error', lastTestedAt: new Date(), errorMessage: result.ok ? null : result.message } },
    );
    return result;
  }
}
