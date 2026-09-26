import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { of, throwError } from 'rxjs';
import { computePlivoSignatureV3 } from './plivo-signature';
import { PlivoWebhooksService, WebhookRequest } from './plivo-webhooks.service';
import { PlivoService } from './plivo.service';
import { PlivoCall, PlivoCallDocument, PlivoCallSchema } from './schemas/plivo-call.schema';
import { PlivoLine, PlivoLineDocument, PlivoLineSchema } from './schemas/plivo-line.schema';

// The SSRF guard resolves hostnames over DNS. IP-literal and localhost URLs still
// go through the REAL guard (that is the case that matters, and needs no
// network); named hosts skip the lookup so this spec passes offline and never
// waits on DNS.
jest.mock('../common/security/ssrf-guard', () => {
  const actual = jest.requireActual('../common/security/ssrf-guard');
  return {
    ...actual,
    assertPublicHttpUrl: (url: string) =>
      /^https?:\/\/((\d{1,3}\.){3}\d{1,3}|localhost|\[)/i.test(url) ? actual.assertPublicHttpUrl(url) : Promise.resolve(),
  };
});

const BASE = 'https://hooks.example.com';
const TOKEN = 'org-auth-token-abc';
const PREFIX = `jest-plivo-${Date.now()}`;

// Plivo's webhooks against the real service and a real Mongo; only the things
// outside this process — Plivo's media host, Call Copilot, notifications — are
// stubbed. Requests are signed exactly as Plivo signs them, so the signature
// check is exercised for real rather than bypassed.
describe('Plivo webhooks (real Mongo)', () => {
  let connection: Connection;
  let calls: Model<PlivoCallDocument>;
  let lines: Model<PlivoLineDocument>;
  let service: PlivoWebhooksService;
  let httpGet: jest.Mock;
  let startSession: jest.Mock;
  let notify: jest.Mock;
  let publicBase: string;
  let credentialsFor: (org: string) => Promise<{ authId: string; authToken: string } | null>;
  let seq = 0;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: PlivoCall.name, schema: PlivoCallSchema },
          { name: PlivoLine.name, schema: PlivoLineSchema },
        ]),
      ],
    }).compile();
    calls = moduleRef.get(getModelToken(PlivoCall.name));
    lines = moduleRef.get(getModelToken(PlivoLine.name));
    connection = calls.db;
    await Promise.all([calls.init(), lines.init()]);
  });

  beforeEach(() => {
    seq += 1;
    orgId = `${PREFIX}-org-${seq}`;
    userId = `${PREFIX}-user-${seq}`;
    publicBase = BASE;
    credentialsFor = async (org) => (org === orgId ? { authId: 'MAXXXXXXXXXXXXXXXXXX', authToken: TOKEN } : null);
    httpGet = jest.fn(() => of({ data: new Uint8Array([1, 2, 3, 4]).buffer }));
    startSession = jest.fn(async () => ({ _id: { toString: () => 'session-123' } }));
    notify = jest.fn(async () => undefined);
    const plivo = {
      get publicBaseUrl() {
        return publicBase;
      },
      normalize: (n: string) => {
        const d = (n ?? '').replace(/\D/g, '');
        return d.length >= 8 ? d : null;
      },
      getCredentials: (org: string) => credentialsFor(org),
    } as unknown as PlivoService;
    service = new PlivoWebhooksService(calls, lines, plivo, { get: httpGet } as never, { startSessionFromRecording: startSession } as never, { create: notify } as never);
    (service as unknown as { retryDelayMs: number }).retryDelayMs = 0;
  });

  afterAll(async () => {
    await calls.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await lines.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  /** A request exactly as Plivo would send it, signed with `token`. */
  function signed(path: string, body: Record<string, string>, token = TOKEN): WebhookRequest {
    const nonce = `nonce-${Math.random().toString(36).slice(2)}`;
    return {
      originalUrl: path,
      body,
      headers: { 'x-plivo-signature-v3-nonce': nonce, 'x-plivo-signature-v3': computePlivoSignatureV3('POST', `${BASE}${path}`, nonce, token, body) },
    };
  }
  const unsigned = (path: string, body: Record<string, string>): WebhookRequest => ({ originalUrl: path, body, headers: {} });

  async function outboundCall(extra: Record<string, unknown> = {}) {
    return calls.create({
      organizationId: orgId,
      userId,
      direction: 'outbound',
      plivoNumber: '918012345678',
      agentPhone: '919876543210',
      customerNumber: '919000000001',
      languageCode: 'hi',
      dealId: 'deal-1',
      status: 'initiated',
      ...extra,
    });
  }
  async function line() {
    const plivoNumber = `9180${String(seq).padStart(2, '0')}${Math.floor(Math.random() * 1e6)}`;
    await lines.create({ organizationId: orgId, plivoNumber, userId, agentPhone: '919876543210', languageCode: 'ta', active: true });
    return plivoNumber;
  }
  const xmlOf = (r: { status: number; xml?: string }) => (r as { xml?: string }).xml ?? '';
  // The import runs in the background after the webhook has been answered: wait
  // for the call to reach an end state rather than guessing how long that takes.
  async function importFinished(id: unknown) {
    for (let i = 0; i < 100; i++) {
      const status = (await calls.findById(id))?.importStatus;
      if (status === 'imported' || status === 'failed') return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('import never finished');
  }
  // For "nothing should happen" cases: a short beat for any (wrongly) started work to show up.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  describe('answer — outbound (the agent picked up their phone)', () => {
    it('records the call and dials the customer, from the Plivo number', async () => {
      const call = await outboundCall();
      const path = `/plivo/webhooks/answer?callId=${call._id}`;

      const result = await service.answer(signed(path, { CallUUID: 'uuid-1', From: '918012345678', To: '919876543210' }), String(call._id));

      expect(result.status).toBe(200);
      expect(xmlOf(result)).toContain('<Number>919000000001</Number>');
      expect(xmlOf(result)).toContain('callerId="918012345678"');
      expect(xmlOf(result)).toContain(`${BASE}/plivo/webhooks/recording?callId=${call._id}`);
      const after = await calls.findById(call._id);
      expect(after?.status).toBe('in_progress');
      expect(after?.callUuid).toBe('uuid-1');
    });

    it('refuses a request that is not signed, or signed with the wrong token, and does not touch the call', async () => {
      const call = await outboundCall();
      const path = `/plivo/webhooks/answer?callId=${call._id}`;
      expect(await service.answer(unsigned(path, { CallUUID: 'x' }), String(call._id))).toEqual({ status: 403 });
      expect(await service.answer(signed(path, { CallUUID: 'x' }, 'forged-token'), String(call._id))).toEqual({ status: 403 });
      expect((await calls.findById(call._id))?.status).toBe('initiated');
    });

    it('cannot be replayed against another call id (the id is part of what is signed)', async () => {
      const a = await outboundCall();
      const b = await outboundCall();
      const forged = signed(`/plivo/webhooks/answer?callId=${a._id}`, { CallUUID: 'x' });
      forged.originalUrl = `/plivo/webhooks/answer?callId=${b._id}`;
      expect(await service.answer(forged, String(b._id))).toEqual({ status: 403 });
    });

    it('is a 404 for an unknown or malformed call id', async () => {
      expect(await service.answer(signed('/plivo/webhooks/answer?callId=nope', {}), 'nope')).toEqual({ status: 404 });
      expect(await service.answer(signed('/plivo/webhooks/answer?callId=665f1c2e9b1d4a0012ab34cd', {}), '665f1c2e9b1d4a0012ab34cd')).toEqual({ status: 404 });
    });

    it('refuses everything while the public URL is not configured (it cannot know what Plivo signed)', async () => {
      const call = await outboundCall();
      publicBase = '';
      expect(await service.answer(signed(`/plivo/webhooks/answer?callId=${call._id}`, { CallUUID: 'x' }), String(call._id))).toEqual({ status: 403 });
    });

    it('refuses when the organization has disconnected Plivo', async () => {
      const call = await outboundCall();
      credentialsFor = async () => null;
      expect(await service.answer(signed(`/plivo/webhooks/answer?callId=${call._id}`, { CallUUID: 'x' }), String(call._id))).toEqual({ status: 403 });
    });
  });

  describe('answer — inbound (a customer dialed a Plivo number)', () => {
    it("forwards to the agent's phone, records it, and logs the call for that agent", async () => {
      const plivoNumber = await line();

      const result = await service.answer(signed('/plivo/webhooks/answer', { CallUUID: 'in-1', From: '+91 90000 00002', To: plivoNumber }), undefined);

      expect(result.status).toBe(200);
      expect(xmlOf(result)).toContain('<Number>919876543210</Number>');
      expect(xmlOf(result)).toContain('startOnDialAnswer="true"');
      const logged = await calls.findOne({ organizationId: orgId, callUuid: 'in-1' });
      expect(logged).toMatchObject({ direction: 'inbound', userId, plivoNumber, agentPhone: '919876543210', customerNumber: '919000000002', languageCode: 'ta', status: 'in_progress' });
    });

    it("logs a retried webhook once, not twice", async () => {
      const plivoNumber = await line();
      const body = { CallUUID: 'in-retry', From: '919000000003', To: plivoNumber };
      await service.answer(signed('/plivo/webhooks/answer', body), undefined);
      await service.answer(signed('/plivo/webhooks/answer', body), undefined);
      expect(await calls.countDocuments({ organizationId: orgId, callUuid: 'in-retry' })).toBe(1);
    });

    it('says the number is not set up for a number that is not ours, without revealing anything', async () => {
      const result = await service.answer(unsigned('/plivo/webhooks/answer', { CallUUID: 'x', To: '919999999999' }), undefined);
      expect(result.status).toBe(200);
      expect(xmlOf(result)).toContain('<Hangup/>');
      expect(xmlOf(result)).not.toContain('<Dial');
    });

    it('refuses an unsigned or wrongly-signed request to a real number, and an inactive line', async () => {
      const plivoNumber = await line();
      expect(await service.answer(unsigned('/plivo/webhooks/answer', { CallUUID: 'x', To: plivoNumber }), undefined)).toEqual({ status: 403 });
      expect(await service.answer(signed('/plivo/webhooks/answer', { CallUUID: 'x', To: plivoNumber }, 'forged'), undefined)).toEqual({ status: 403 });
      await lines.updateOne({ plivoNumber }, { active: false });
      expect(xmlOf(await service.answer(signed('/plivo/webhooks/answer', { CallUUID: 'y', To: plivoNumber }), undefined))).toContain('<Hangup/>');
    });

    it('rejects a call with no CallUUID (there would be nothing to key it on)', async () => {
      const plivoNumber = await line();
      expect(await service.answer(signed('/plivo/webhooks/answer', { To: plivoNumber, From: '919000000004' }), undefined)).toEqual({ status: 400 });
    });
  });

  describe('recording ready', () => {
    // A real recording id is unique to its recording (and the schema enforces it, which is
    // what makes a redelivered webhook harmless), so every test gets its own.
    const recId = () => `${PREFIX}-rec-${seq}`;
    const recordingBody = (id = recId()) => ({
      RecordUrl: `https://media.plivo.com/Recording/MAXXXXXXXXXXXXXXXXXX/${id}.mp3`,
      RecordingID: id,
      RecordingDuration: '187',
    });

    it('imports the recording into Call Copilot, links the session, and tells the agent', async () => {
      const call = await outboundCall();
      const path = `/plivo/webhooks/recording?callId=${call._id}`;

      const result = await service.recordingReady(signed(path, recordingBody()), String(call._id));
      await importFinished(call._id);

      expect(result).toEqual({ status: 200, xml: '<Response></Response>' });
      expect(httpGet).toHaveBeenCalledWith(recordingBody().RecordUrl, expect.objectContaining({ responseType: 'arraybuffer' }));
      expect(startSession).toHaveBeenCalledWith(orgId, userId, expect.any(Buffer), `plivo-${recId()}.mp3`, { dealId: 'deal-1', languageCode: 'hi' });
      const after = await calls.findById(call._id);
      expect(after).toMatchObject({ recordingId: recId(), importStatus: 'imported', sessionId: 'session-123', recordingDurationSeconds: 187 });
      expect(notify).toHaveBeenCalledWith(userId, expect.objectContaining({ title: 'Call recording ready', source: 'call-copilot' }), orgId);
    });

    it('imports a redelivered webhook only once', async () => {
      const call = await outboundCall();
      const path = `/plivo/webhooks/recording?callId=${call._id}`;

      await service.recordingReady(signed(path, recordingBody()), String(call._id));
      const again = await service.recordingReady(signed(path, recordingBody()), String(call._id));
      await importFinished(call._id);
      await settle(); // and long enough for a (wrong) second import to have started

      expect(again.status).toBe(200); // acknowledged, so Plivo stops retrying
      expect(startSession).toHaveBeenCalledTimes(1);
    });

    it('never fetches anything for an unsigned or forged request', async () => {
      const call = await outboundCall();
      const path = `/plivo/webhooks/recording?callId=${call._id}`;
      expect(await service.recordingReady(unsigned(path, recordingBody()), String(call._id))).toEqual({ status: 403 });
      expect(await service.recordingReady(signed(path, recordingBody(), 'forged'), String(call._id))).toEqual({ status: 403 });
      await settle();
      expect(httpGet).not.toHaveBeenCalled();
      expect((await calls.findById(call._id))?.recordingId).toBeUndefined();
    });

    it('rejects a callback missing its recording fields', async () => {
      const call = await outboundCall();
      const path = `/plivo/webhooks/recording?callId=${call._id}`;
      expect(await service.recordingReady(signed(path, { RecordingID: 'x' }), String(call._id))).toEqual({ status: 400 });
    });

    it('does not fetch a recording URL that points inside the network (SSRF)', async () => {
      const call = await outboundCall();
      const path = `/plivo/webhooks/recording?callId=${call._id}`;

      await service.recordingReady(signed(path, { RecordingID: `${recId()}-evil`, RecordUrl: 'http://127.0.0.1:8000/secrets.mp3' }), String(call._id));
      await importFinished(call._id);

      expect(httpGet).not.toHaveBeenCalled();
      expect(startSession).not.toHaveBeenCalled();
      const after = await calls.findById(call._id);
      expect(after?.importStatus).toBe('failed');
      expect(after?.importError).toBeTruthy();
    });

    it('sends the account credentials only to Plivo, never to another host', async () => {
      const plivoCall = await outboundCall();
      await service.recordingReady(signed(`/plivo/webhooks/recording?callId=${plivoCall._id}`, recordingBody(`${recId()}-auth`)), String(plivoCall._id));
      await importFinished(plivoCall._id);
      expect(httpGet.mock.calls[0][1]).toMatchObject({ auth: { username: 'MAXXXXXXXXXXXXXXXXXX', password: TOKEN } });

      httpGet.mockClear();
      const s3Call = await outboundCall();
      await service.recordingReady(
        signed(`/plivo/webhooks/recording?callId=${s3Call._id}`, { RecordingID: `${recId()}-s3`, RecordUrl: 'https://s3.amazonaws.com/recordings_2013/x.mp3' }),
        String(s3Call._id),
      );
      await importFinished(s3Call._id);
      expect(httpGet).toHaveBeenCalled();
      expect(httpGet.mock.calls[0][1]).not.toHaveProperty('auth');
    });

    it('retries a download that is not ready yet, then succeeds', async () => {
      httpGet.mockReturnValueOnce(throwError(() => Object.assign(new Error('nope'), { response: { status: 404 } }))).mockReturnValueOnce(of({ data: new Uint8Array([9]).buffer }));
      const call = await outboundCall();
      await service.recordingReady(signed(`/plivo/webhooks/recording?callId=${call._id}`, recordingBody(`${recId()}-late`)), String(call._id));
      await importFinished(call._id);
      expect(httpGet).toHaveBeenCalledTimes(2);
      expect((await calls.findById(call._id))?.importStatus).toBe('imported');
    });

    it('records a failed import with a readable reason, tells the agent, and can be retried', async () => {
      httpGet.mockReturnValue(throwError(() => Object.assign(new Error('boom'), { response: { status: 500 } })));
      const call = await outboundCall();
      await service.recordingReady(signed(`/plivo/webhooks/recording?callId=${call._id}`, recordingBody(`${recId()}-bad`)), String(call._id));
      await importFinished(call._id);

      const failed = await calls.findById(call._id);
      expect(failed?.importStatus).toBe('failed');
      expect(failed?.importError).toContain('Could not download the recording from Plivo (HTTP 500)');
      expect(notify).toHaveBeenCalledWith(userId, expect.objectContaining({ title: 'Call recording could not be processed' }), orgId);
      expect(startSession).not.toHaveBeenCalled();

      httpGet.mockReturnValue(of({ data: new Uint8Array([1]).buffer }));
      await service.importRecording(failed!);
      const retried = await calls.findById(call._id);
      expect(retried).toMatchObject({ importStatus: 'imported', sessionId: 'session-123' });
      expect(retried?.importError).toBeUndefined();
    });

    it("surfaces Call Copilot's own refusal (e.g. out of credits) instead of hiding it", async () => {
      startSession.mockRejectedValueOnce(new Error('Insufficient credits to process this recording.'));
      const call = await outboundCall();
      await service.recordingReady(signed(`/plivo/webhooks/recording?callId=${call._id}`, recordingBody(`${recId()}-broke`)), String(call._id));
      await importFinished(call._id);
      expect((await calls.findById(call._id))).toMatchObject({ importStatus: 'failed', importError: 'Insufficient credits to process this recording.' });
    });
  });

  describe('hangup', () => {
    it.each([
      ['completed', 'completed'],
      ['busy', 'busy'],
      ['no-answer', 'no_answer'],
      ['timeout', 'no_answer'],
      ['cancel', 'cancelled'],
      ['failed', 'failed'],
    ])('maps Plivo status %s to %s and keeps the duration', async (plivoStatus, expected) => {
      const call = await outboundCall({ status: 'in_progress' });
      const path = `/plivo/webhooks/hangup?callId=${call._id}`;

      const result = await service.hangup(signed(path, { DialStatus: plivoStatus, Duration: '42' }), String(call._id));

      expect(result).toEqual({ status: 200, xml: '<Response></Response>' });
      const after = await calls.findById(call._id);
      expect(after?.status).toBe(expected);
      expect(after?.durationSeconds).toBe(42);
      if (expected !== 'completed') expect(after?.failureReason).toBeTruthy();
    });

    it("finds an inbound call by Plivo's call id when the Application's own Hangup URL is used (no callId)", async () => {
      const call = await outboundCall({ direction: 'inbound', callUuid: 'in-hangup', status: 'in_progress' });
      await service.hangup(signed('/plivo/webhooks/hangup', { CallUUID: 'in-hangup', CallStatus: 'completed', Duration: '9' }), undefined);
      expect(await calls.findById(call._id)).toMatchObject({ status: 'completed', durationSeconds: 9 });
    });

    it('acknowledges a call it does not know without error, and refuses a forged one', async () => {
      expect(await service.hangup(unsigned('/plivo/webhooks/hangup', { CallUUID: 'nobody' }), undefined)).toEqual({ status: 200, xml: '<Response></Response>' });
      const call = await outboundCall({ status: 'in_progress' });
      expect(await service.hangup(unsigned(`/plivo/webhooks/hangup?callId=${call._id}`, { DialStatus: 'failed' }), String(call._id))).toEqual({ status: 403 });
      expect((await calls.findById(call._id))?.status).toBe('in_progress');
    });
  });
});
