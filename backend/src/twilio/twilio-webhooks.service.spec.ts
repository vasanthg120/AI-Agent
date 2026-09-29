import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { of, throwError } from 'rxjs';

import { computeTwilioSignature } from './twilio-signature';
import {
  RECORDING_NOTICE,
  TwilioWebhookRequest,
  TwilioWebhooksService,
} from './twilio-webhooks.service';
import { TwilioService } from './twilio.service';
import {
  TwilioCall,
  TwilioCallDocument,
  TwilioCallSchema,
} from './schemas/twilio-call.schema';
import {
  TwilioLine,
  TwilioLineDocument,
  TwilioLineSchema,
} from './schemas/twilio-line.schema';

// Named hosts skip the DNS lookup (offline-safe); IP literals still hit the real SSRF guard.
jest.mock('../common/security/ssrf-guard', () => {
  const actual = jest.requireActual('../common/security/ssrf-guard');

  return {
    ...actual,
    assertPublicHttpUrl: (url: string) =>
      (/^https?:\/\/((\d{1,3}\.){3}\d{1,3}|localhost|\[)/i.test(url)
        ? actual.assertPublicHttpUrl(url)
        : Promise.resolve()),
  };
});

const BASE = 'https://hooks.example.com';

// Test-only placeholders.
// Do NOT use real Twilio credentials in source code.
const SID = 'AC_TEST_ACCOUNT_SID';
const TOKEN = 'test-auth-token';

const PREFIX = `jest-twilio-${Date.now()}`;

// Twilio's webhooks against the real service and a real Mongo; only things
// outside this process (Twilio's media host, Call Copilot, notifications) are
// stubbed. Requests are signed exactly as Twilio signs them.
describe('Twilio webhooks (real Mongo)', () => {
  let connection: Connection;
  let calls: Model<TwilioCallDocument>;
  let lines: Model<TwilioLineDocument>;
  let service: TwilioWebhooksService;

  let httpGet: jest.Mock;
  let startSession: jest.Mock;

  let seq = 0;
  let orgId: string;
  let userId: string;
  let twilioNumber: string;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;

    if (!uri) {
      throw new Error(
        'MONGODB_URI/MONGO_URI must be set to run these integration tests.',
      );
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          {
            name: TwilioCall.name,
            schema: TwilioCallSchema,
          },
          {
            name: TwilioLine.name,
            schema: TwilioLineSchema,
          },
        ]),
      ],
    }).compile();

    calls = moduleRef.get(getModelToken(TwilioCall.name));
    lines = moduleRef.get(getModelToken(TwilioLine.name));

    connection = calls.db;

    await Promise.all([calls.init(), lines.init()]);
  });

  beforeEach(() => {
    seq += 1;

    orgId = `${PREFIX}-org-${seq}`;
    userId = `${PREFIX}-user-${seq}`;

    // A number unique to this test (the collection's index is global).
    twilioNumber = `1415${String(Date.now()).slice(-6)}${seq}`.slice(0, 13);

    httpGet = jest.fn(() =>
      of({
        data: new Uint8Array([1, 2, 3, 4]).buffer,
      }),
    );

    startSession = jest.fn(async () => ({
      _id: {
        toString: () => 'session-123',
      },
    }));

    const twilio = {
      publicBaseUrl: BASE,

      normalize: (n: string) => {
        const d = (n ?? '').replace(/\D/g, '');
        return d.length >= 8 ? d : null;
      },

      getCredentials: async (org: string) =>
        org === orgId
          ? {
              accountSid: SID,
              authToken: TOKEN,
            }
          : null,
    } as unknown as TwilioService;

    service = new TwilioWebhooksService(
      calls,
      lines,
      twilio,
      { get: httpGet } as never,
      { startSessionFromRecording: startSession } as never,
      {
        create: jest.fn(async () => undefined),
      } as never,
    );

    (
      service as unknown as {
        retryDelayMs: number;
      }
    ).retryDelayMs = 0;
  });

  afterAll(async () => {
    await calls.deleteMany({
      organizationId: {
        $regex: `^${PREFIX}`,
      },
    });

    await lines.deleteMany({
      organizationId: {
        $regex: `^${PREFIX}`,
      },
    });

    await connection.close();
  });

  function signed(
    path: string,
    body: Record<string, string>,
    token = TOKEN,
  ): TwilioWebhookRequest {
    const params = {
      AccountSid: SID,
      ...body,
    };

    return {
      originalUrl: path,
      body: params,
      headers: {
        'x-twilio-signature': computeTwilioSignature(
          token,
          `${BASE}${path}`,
          params,
        ),
      },
    };
  }

  const line = (extra: Record<string, unknown> = {}) =>
    lines.create({
      organizationId: orgId,
      twilioNumber,
      userId,
      agentPhone: '447700900111',
      languageCode: 'en',
      ...extra,
    });

  const outboundCall = (extra: Record<string, unknown> = {}) =>
    calls.create({
      organizationId: orgId,
      userId,
      direction: 'outbound',
      twilioNumber,
      agentPhone: '447700900111',
      customerNumber: '447700900222',
      status: 'initiated',
      ...extra,
    });

  async function importFinished(id: unknown) {
    for (let i = 0; i < 100; i++) {
      const status = (await calls.findById(id))?.importStatus;

      if (status === 'imported' || status === 'failed') {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error('import never finished');
  }

  describe('voice', () => {
    it('outbound: agent answered -> greet, announce to the customer, record and dial them', async () => {
      await line();

      const call = await outboundCall();

      const path = `/twilio/webhooks/voice?callId=${call._id}`;

      const result = await service.voice(
        signed(path, {
          CallSid: 'CAagent1',
        }),
        String(call._id),
      );

      expect(result.status).toBe(200);

      const xml = (result as { xml: string }).xml;

      expect(xml).toContain(`callerId="+${twilioNumber}"`);
      expect(xml).toContain('>+447700900222</Number>');
      expect(xml).toContain(
        `/twilio/webhooks/announce?callId=${call._id}`,
      );
      expect(xml).toContain('record="record-from-answer-dual"');

      const fresh = await calls.findById(call._id);

      expect(fresh?.status).toBe('in_progress');
      expect(fresh?.callSid).toBe('CAagent1');
    });

    it('outbound: no announcement when the line has it turned off', async () => {
      await line({
        announceRecording: false,
      });

      const call = await outboundCall();

      const path = `/twilio/webhooks/voice?callId=${call._id}`;

      const result = await service.voice(
        signed(path, {
          CallSid: 'CAagent2',
        }),
        String(call._id),
      );

      expect((result as { xml: string }).xml).not.toContain('announce');
    });

    it('refuses an unsigned, wrongly signed or other-account request', async () => {
      const call = await outboundCall();

      const path = `/twilio/webhooks/voice?callId=${call._id}`;

      expect(
        await service.voice(
          {
            originalUrl: path,
            body: {
              CallSid: 'x',
            },
            headers: {},
          },
          String(call._id),
        ),
      ).toEqual({
        status: 403,
      });

      expect(
        await service.voice(
          signed(
            path,
            {
              CallSid: 'x',
            },
            'f'.repeat(32),
          ),
          String(call._id),
        ),
      ).toEqual({
        status: 403,
      });

      const otherAccount = {
        AccountSid: `AC${'f'.repeat(32)}`,
        CallSid: 'x',
      };

      const forged = {
        originalUrl: path,
        body: otherAccount,
        headers: {
          'x-twilio-signature': computeTwilioSignature(
            TOKEN,
            `${BASE}${path}`,
            otherAccount,
          ),
        },
      };

      expect(
        await service.voice(
          forged,
          String(call._id),
        ),
      ).toEqual({
        status: 403,
      });
    });

    it('inbound: logs the call once (retries included), plays the notice and forwards to the agent', async () => {
      await line();

      const body = {
        CallSid: 'CAinbound1',
        From: '+12025550199',
        To: `+${twilioNumber}`,
      };

      const first = await service.voice(
        signed('/twilio/webhooks/voice', body),
        undefined,
      );

      const again = await service.voice(
        signed('/twilio/webhooks/voice', body),
        undefined,
      );

      const xml = (first as { xml: string }).xml;

      expect(xml).toContain(
        `<Say>${RECORDING_NOTICE}</Say>`,
      );

      expect(xml).toContain('>+447700900111</Number>');
      expect(again.status).toBe(200);

      const logged = await calls.find({
        organizationId: orgId,
        callSid: 'CAinbound1',
      });

      expect(logged).toHaveLength(1);
      expect(logged[0].direction).toBe('inbound');
      expect(logged[0].customerNumber).toBe('12025550199');
    });

    it('inbound to an unknown number: polite message, nothing logged', async () => {
      const result = await service.voice(
        {
          originalUrl: '/twilio/webhooks/voice',
          body: {
            To: '+19999999999',
            CallSid: 'CAz',
          },
          headers: {},
        },
        undefined,
      );

      expect((result as { xml: string }).xml).toContain(
        'not set up',
      );

      expect(
        await calls.countDocuments({
          callSid: 'CAz',
        }),
      ).toBe(0);
    });
  });

  describe('outcomes', () => {
    it("the customer's 'no answer' survives the agent leg later reporting 'completed'", async () => {
      const call = await outboundCall({
        status: 'in_progress',
      });

      await service.dialStatus(
        signed(
          `/twilio/webhooks/dial-status?callId=${call._id}`,
          {
            DialCallStatus: 'no-answer',
          },
        ),
        String(call._id),
      );

      await service.callStatus(
        signed(
          `/twilio/webhooks/status?callId=${call._id}`,
          {
            CallStatus: 'completed',
            CallDuration: '20',
          },
        ),
        String(call._id),
      );

      const fresh = await calls.findById(call._id);

      expect(fresh?.status).toBe('no_answer');
      expect(fresh?.failureReason).toMatch(/customer/i);
    });

    it('the agent not answering is reported as such', async () => {
      const call = await outboundCall();

      await service.callStatus(
        signed(
          `/twilio/webhooks/status?callId=${call._id}`,
          {
            CallStatus: 'no-answer',
          },
        ),
        String(call._id),
      );

      const fresh = await calls.findById(call._id);

      expect(fresh?.status).toBe('no_answer');
      expect(fresh?.failureReason).toMatch(
        /Your phone was not answered/,
      );
    });

    it('a completed dial records its duration', async () => {
      const call = await outboundCall({
        status: 'in_progress',
      });

      await service.dialStatus(
        signed(
          `/twilio/webhooks/dial-status?callId=${call._id}`,
          {
            DialCallStatus: 'completed',
            DialCallDuration: '95',
          },
        ),
        String(call._id),
      );

      const fresh = await calls.findById(call._id);

      expect(fresh?.status).toBe('completed');
      expect(fresh?.durationSeconds).toBe(95);
    });
  });

  describe('recording', () => {
    const recBody = (sid: string) => ({
      CallSid: 'CAx',
      RecordingSid: sid,
      RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${SID}/Recordings/${sid}`,
      RecordingStatus: 'completed',
      RecordingDuration: '61',
    });

    it('imports once, as mp3, authenticated to Twilio, into Call Copilot', async () => {
      const call = await outboundCall({
        status: 'completed',
        dealId: 'deal-9',
      });

      const sid = `RE${PREFIX}${seq}a`;

      const path = `/twilio/webhooks/recording?callId=${call._id}`;

      await service.recordingReady(
        signed(path, recBody(sid)),
        String(call._id),
      );

      await service.recordingReady(
        signed(path, recBody(sid)),
        String(call._id),
      ); // redelivery

      await importFinished(call._id);

      const fresh = await calls.findById(call._id);

      expect(fresh?.importStatus).toBe('imported');
      expect(fresh?.sessionId).toBe('session-123');
      expect(fresh?.recordingDurationSeconds).toBe(61);

      expect(startSession).toHaveBeenCalledTimes(1);

      expect(startSession.mock.calls[0][3]).toBe(
        `twilio-${sid}.mp3`,
      );

      expect(startSession.mock.calls[0][4]).toEqual({
        dealId: 'deal-9',
        languageCode: 'en',
      });

      const [url, options] = httpGet.mock.calls[0];

      expect(url).toMatch(/\.mp3$/);

      expect(options.auth).toEqual({
        username: SID,
        password: TOKEN,
      });
    });

    it('never sends the credentials to a non-Twilio host, and refuses internal addresses', async () => {
      const call = await outboundCall({
        status: 'completed',
      });

      const path = `/twilio/webhooks/recording?callId=${call._id}`;

      await service.recordingReady(
        signed(path, {
          ...recBody(`RE${PREFIX}${seq}b`),
          RecordingUrl: 'http://127.0.0.1:8000/secret',
        }),
        String(call._id),
      );

      await importFinished(call._id);

      expect(
        (await calls.findById(call._id))?.importStatus,
      ).toBe('failed');

      expect(httpGet).not.toHaveBeenCalled();
    });

    it('a failed Twilio recording is marked failed without downloading', async () => {
      const call = await outboundCall({
        status: 'completed',
      });

      const path = `/twilio/webhooks/recording?callId=${call._id}`;

      await service.recordingReady(
        signed(path, {
          ...recBody(`RE${PREFIX}${seq}c`),
          RecordingStatus: 'failed',
        }),
        String(call._id),
      );

      const fresh = await calls.findById(call._id);

      expect(fresh?.importStatus).toBe('failed');
      expect(httpGet).not.toHaveBeenCalled();
    });

    it('a download that keeps failing ends as a retryable failure', async () => {
      httpGet.mockImplementation(() =>
        throwError(() =>
          Object.assign(new Error('nope'), {
            response: {
              status: 404,
            },
          }),
        ),
      );

      const call = await outboundCall({
        status: 'completed',
      });

      const path = `/twilio/webhooks/recording?callId=${call._id}`;

      await service.recordingReady(
        signed(
          path,
          recBody(`RE${PREFIX}${seq}d`),
        ),
        String(call._id),
      );

      await importFinished(call._id);

      const fresh = await calls.findById(call._id);

      expect(fresh?.importStatus).toBe('failed');
      expect(fresh?.importError).toMatch(/HTTP 404/);
      expect(httpGet).toHaveBeenCalledTimes(3);
    });
  });
});