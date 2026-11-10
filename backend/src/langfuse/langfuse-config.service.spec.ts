import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of, throwError } from 'rxjs';
import { Connection, Model } from 'mongoose';
import { EncryptionService } from '../common/encryption/encryption.service';
import { SaveLangfuseConfigDto } from './dto/save-langfuse-config.dto';
import { LangfuseConfigService } from './langfuse-config.service';
import { LangfuseConfig, LangfuseConfigDocument, LangfuseConfigSchema } from './schemas/langfuse-config.schema';

const PREFIX = `jest-langfuse-${Date.now()}`;

describe('SaveLangfuseConfigDto validation', () => {
  // class-validator's @IsUrl, without require_protocol, accepted bare
  // strings like 'not-a-url' as "valid" — confirmed live via a standalone
  // validate() run against this exact DTO, a real bug found and fixed in
  // the same pass as this test (require_protocol: true added). Guards
  // against it regressing silently, since saveConfig()'s own service-level
  // tests below call the service directly and never exercise this DTO's
  // decorators (that only happens through the real HTTP ValidationPipe).
  it.each([
    ['https://cloud.langfuse.com', true],
    ['http://langfuse.internal.company.com:3000', true],
    ['not-a-url', false],
    ['ftp://cloud.langfuse.com', false],
    ['', false],
  ])('baseUrl %s is valid=%s', async (baseUrl, expectedValid) => {
    const dto = plainToInstance(SaveLangfuseConfigDto, { baseUrl });
    const errors = await validate(dto);
    expect(errors.length === 0).toBe(expectedValid);
  });
});

describe('LangfuseConfigService', () => {
  let model: Model<LangfuseConfigDocument>;
  let connection: Connection;
  let encryption: EncryptionService;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri), MongooseModule.forFeature([{ name: LangfuseConfig.name, schema: LangfuseConfigSchema }])],
    }).compile();

    model = moduleRef.get(getModelToken(LangfuseConfig.name));
    connection = moduleRef.get(getConnectionToken());
    encryption = new EncryptionService({ get: () => `${PREFIX}-key` } as never);
  });

  afterEach(async () => {
    await model.deleteMany({});
  });

  afterAll(async () => {
    await connection.close();
  });

  function service(http: { get: jest.Mock } = { get: jest.fn() }) {
    return new LangfuseConfigService(model, encryption, http as never);
  }

  it('starts unconfigured, with every secret-bearing field honestly absent', async () => {
    const status = await service().getStatus();
    expect(status).toMatchObject({ enabled: false, publicKeyMasked: null, secretConfigured: false, connectionStatus: 'untested' });
  });

  it('save/mask round-trip: the secret is never returned decrypted, only a fixed mask once configured', async () => {
    const svc = service();
    await svc.saveConfig({ publicKey: 'pk-live-123', secretKey: 'sk-live-456', baseUrl: 'https://cloud.langfuse.com' });
    const status = await svc.getStatus();
    expect(status.publicKeyMasked).toBe('••••••••••••');
    expect(status.secretConfigured).toBe(true);
    expect(JSON.stringify(status)).not.toContain('sk-live-456');

    const doc = await model.findOne({ organizationId: 'platform' });
    expect(doc!.secretKeyEncrypted).not.toBe('sk-live-456');
    expect(encryption.decrypt(doc!.secretKeyEncrypted!)).toBe('sk-live-456');
  });

  it('a partial save (sampling rate only) keeps the secret already on file', async () => {
    const svc = service();
    await svc.saveConfig({ publicKey: 'pk-1', secretKey: 'sk-1' });
    await svc.saveConfig({ samplingRate: 42 });
    const status = await svc.getStatus();
    expect(status.secretConfigured).toBe(true);
    expect(status.samplingRate).toBe(42);
  });

  it('rejects a baseUrl that resolves to a private/internal address (SSRF guard)', async () => {
    await expect(service().saveConfig({ baseUrl: 'http://127.0.0.1:9000' })).rejects.toThrow(/private|internal/i);
  });

  it('setEnabled toggles the flag without touching anything else', async () => {
    const svc = service();
    await svc.saveConfig({ publicKey: 'pk-1', secretKey: 'sk-1' });
    await svc.setEnabled(true);
    expect((await svc.getStatus()).enabled).toBe(true);
    await svc.setEnabled(false);
    expect((await svc.getStatus()).enabled).toBe(false);
  });

  it('testConnection never persists "connected" on a failed call, and reports the failure', async () => {
    const http = { get: jest.fn().mockReturnValue(throwError(() => ({ response: { status: 401 } }))) };
    const svc = service(http);
    await svc.saveConfig({ publicKey: 'pk-bad', secretKey: 'sk-bad' });

    const result = await svc.testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rejected/i);

    const status = await svc.getStatus();
    expect(status.connectionStatus).toBe('error');
    expect(status.errorMessage).toBeTruthy();
  });

  it('testConnection persists "connected" and clears any prior error on success', async () => {
    const http = { get: jest.fn().mockReturnValue(of({ status: 200, data: {} })) };
    const svc = service(http);
    await svc.saveConfig({ publicKey: 'pk-good', secretKey: 'sk-good' });

    const result = await svc.testConnection();
    expect(result.ok).toBe(true);

    const status = await svc.getStatus();
    expect(status.connectionStatus).toBe('connected');
    expect(status.lastTestedAt).not.toBeNull();
    expect(status.errorMessage).toBeNull();
  });

  it('testConnection refuses to run without a key pair on file first', async () => {
    const http = { get: jest.fn() };
    const result = await service(http).testConnection();
    expect(result.ok).toBe(false);
    expect(http.get).not.toHaveBeenCalled();
  });

  it('replacing the base URL resets connectionStatus back to untested', async () => {
    const svc = service({ get: jest.fn().mockReturnValue(of({ status: 200, data: {} })) });
    await svc.saveConfig({ publicKey: 'pk-1', secretKey: 'sk-1' });
    await svc.testConnection();
    expect((await svc.getStatus()).connectionStatus).toBe('connected');

    await svc.saveConfig({ baseUrl: 'https://us.cloud.langfuse.com' });
    expect((await svc.getStatus()).connectionStatus).toBe('untested');
  });
});
