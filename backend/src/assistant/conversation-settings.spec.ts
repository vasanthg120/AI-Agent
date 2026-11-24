import { BadRequestException } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Connection, Types } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { DEFAULT_QUESTIONS, cleanSettings, defaultSettings, inQuietHours, localClock } from './conversation-settings';
import { ConversationSettingsService } from './conversation-settings.service';
import { UpdateConversationSettingsDto } from './dto/update-conversation-settings.dto';

// AI Conversations settings: each person's own, a company default from an owner
// or admin, Haive's defaults underneath — and the helpers the scheduler uses.

describe('AI Conversations settings (real Mongo)', () => {
  let connection: Connection;
  let service: ConversationSettingsService;
  const org = new Types.ObjectId().toString();
  const owner = { sub: 'jest-settings-owner', organizationId: org, roles: ['owner'], email: 'o@example.com' } as JwtPayload;
  const staff = { sub: 'jest-settings-staff', organizationId: org, roles: ['agent_user'], email: 's@example.com' } as JwtPayload;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({ imports: [MongooseModule.forRoot(uri)] }).compile();
    connection = moduleRef.get(getConnectionToken());
    service = new ConversationSettingsService(connection);
    await service.onModuleInit();
  });

  beforeEach(async () => {
    await connection.collection('ai_conversation_settings').deleteMany({ organizationId: org });
  });

  afterAll(async () => {
    await connection.collection('ai_conversation_settings').deleteMany({ organizationId: org });
    await connection.close();
  });

  it('with nothing saved: Haive’s defaults (first sign-in greeting, the 8 questions, everything followed)', async () => {
    const view = await service.view(staff);
    expect(view.source).toBe('default');
    expect(view.settings).toEqual(defaultSettings());
    expect(view.settings.greeting).toBe('first_of_day');
    expect(view.settings.questions.map((q) => q.text)).toEqual(DEFAULT_QUESTIONS);
    expect(view.canSetOrganization).toBe(false);
    expect((await service.view(owner)).canSetOrganization).toBe(true);
  });

  it('the company default applies to everyone without their own; their own wins; reset goes back', async () => {
    await service.updateOrganization(owner, { language: 'hi', style: 'detailed' });
    expect(await service.resolve(staff)).toMatchObject({ source: 'organization', settings: { language: 'hi', style: 'detailed' } });

    // Their own change starts from what applied to them (the company's Hindi stays).
    const mine = await service.updateMine(staff, { greeting: 'tap' });
    expect(mine.source).toBe('mine');
    expect(mine.settings).toMatchObject({ greeting: 'tap', language: 'hi', style: 'detailed' });
    expect(mine.organization).toMatchObject({ language: 'hi' });

    // A later company change doesn't override what they chose.
    await service.updateOrganization(owner, { language: 'ta' });
    expect((await service.resolve(staff)).settings.language).toBe('hi');

    const reset = await service.resetMine(staff);
    expect(reset.source).toBe('organization');
    expect(reset.settings.language).toBe('ta');
    expect(reset.settings.greeting).toBe('first_of_day');
  });

  it('only what is sent changes; one person’s settings never touch another’s', async () => {
    await service.updateMine(staff, { metrics: { calls: false } });
    await service.updateMine(staff, { quietHours: { enabled: true, start: '21:00', end: '07:30' } });
    const { settings } = await service.resolve(staff);
    expect(settings.metrics).toMatchObject({ calls: false, revenue: true, emails: true });
    expect(settings.quietHours).toEqual({ enabled: true, start: '21:00', end: '07:30' });
    expect((await service.resolve(owner)).source).toBe('default');
    // Another business's people aren't affected either.
    expect((await service.resolve({ ...staff, organizationId: new Types.ObjectId().toString() })).source).toBe('default');
  });

  it('schedules get ids and sorted days; an unknown time zone is refused in words', async () => {
    const view = await service.updateMine(staff, {
      timeZone: 'Australia/Sydney',
      schedules: [
        { label: 'End of day', time: '17:30', days: [5, 1, 1, 3], enabled: true },
        { label: 'Morning', time: '08:45', days: [], enabled: true },
      ],
    });
    expect(view.settings.timeZone).toBe('Australia/Sydney');
    expect(view.settings.schedules.map((s) => [s.label, s.time, s.days])).toEqual([
      ['Morning', '08:45', [1, 2, 3, 4, 5]],
      ['End of day', '17:30', [1, 3, 5]],
    ]);
    expect(view.settings.schedules.every((s) => /^[a-z0-9-]+$/i.test(s.id))).toBe(true);
    await expect(service.updateMine(staff, { timeZone: 'Mars/Olympus' })).rejects.toBeInstanceOf(BadRequestException);
    // Back to the business's own time zone.
    expect((await service.updateMine(staff, { timeZone: null })).settings.timeZone).toBeNull();
  });
});

describe('cleanSettings', () => {
  it('fills what’s missing, drops what isn’t understood, removes blank and repeated questions', () => {
    const s = cleanSettings({
      greeting: 'sometimes' as never,
      language: 'xx' as never,
      maxPerDay: 99,
      questions: [
        { text: '  Which deals   close this week? ', enabled: true },
        { text: 'which deals close this week?', enabled: false },
        { text: '   ', enabled: true },
      ],
      quietHours: { enabled: true, start: '25:00', end: '06:00' },
    });
    expect(s.greeting).toBe('first_of_day');
    expect(s.language).toBe('en');
    expect(s.maxPerDay).toBe(3);
    expect(s.questions).toEqual([{ text: 'Which deals close this week?', enabled: true }]);
    expect(s.quietHours).toEqual({ enabled: true, start: '20:00', end: '06:00' });
    expect(s.metrics.revenue).toBe(true);
  });

  it('an empty question list stays empty (no suggestions wanted)', () => {
    expect(cleanSettings({ questions: [] }).questions).toEqual([]);
  });
});

describe('quiet hours and the local clock', () => {
  const overnight = { enabled: true, start: '20:00', end: '08:00' };
  it('overnight quiet hours run past midnight', () => {
    expect(inQuietHours(overnight, '22:15')).toBe(true);
    expect(inQuietHours(overnight, '03:00')).toBe(true);
    expect(inQuietHours(overnight, '08:00')).toBe(false);
    expect(inQuietHours(overnight, '13:00')).toBe(false);
  });
  it('daytime quiet hours, and switched off', () => {
    const lunch = { enabled: true, start: '13:00', end: '14:00' };
    expect(inQuietHours(lunch, '13:30')).toBe(true);
    expect(inQuietHours(lunch, '14:00')).toBe(false);
    expect(inQuietHours({ ...overnight, enabled: false }, '23:00')).toBe(false);
  });
  it('the clock in the person’s own time zone', () => {
    const at = new Date('2026-11-23T22:40:00Z'); // Monday 22:40 UTC
    expect(localClock('Asia/Kolkata', at)).toEqual({ time: '04:10', weekday: 2 });
    expect(localClock('Australia/Sydney', at)).toEqual({ time: '09:40', weekday: 2 });
    expect(localClock('UTC', at)).toEqual({ time: '22:40', weekday: 1 });
  });
});

describe('UpdateConversationSettingsDto', () => {
  const check = async (body: object) => {
    const errors = await validate(plainToInstance(UpdateConversationSettingsDto, body), { whitelist: true, forbidNonWhitelisted: true });
    return errors.map((e) => e.property);
  };
  it('accepts a sensible change', async () => {
    expect(
      await check({
        greeting: 'every_login',
        language: 'ta',
        schedules: [{ label: 'Morning', time: '09:00', days: [1, 2, 3], enabled: true }],
        quietHours: { enabled: true, start: '20:00', end: '08:00' },
        metrics: { calls: false },
        timeZone: null,
      }),
    ).toEqual([]);
  });
  it('refuses bad times, unknown fields, an unknown greeting and too many proactive conversations', async () => {
    expect(await check({ schedules: [{ label: 'x', time: '9am', days: [1], enabled: true }] })).toEqual(['schedules']);
    expect(await check({ quietHours: { enabled: true, start: '20:00', end: '8' } })).toEqual(['quietHours']);
    expect(await check({ metrics: { weather: true } })).toEqual(['metrics']);
    expect(await check({ greeting: 'sometimes' })).toEqual(['greeting']);
    expect(await check({ maxPerDay: 50 })).toEqual(['maxPerDay']);
    expect(await check({ isAdmin: true })).toEqual(['isAdmin']);
  });
});
