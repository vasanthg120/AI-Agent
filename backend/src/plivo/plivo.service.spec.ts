import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { of, throwError } from 'rxjs';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { PlivoService } from './plivo.service';
import { PlivoCall, PlivoCallDocument, PlivoCallSchema } from './schemas/plivo-call.schema';
import { PlivoLine, PlivoLineDocument, PlivoLineSchema } from './schemas/plivo-line.schema';

const PREFIX = `jest-plivo-svc-${Date.now()}`;
const CONFIG: Record<string, string> = {
  'plivo.publicBaseUrl': 'https://hooks.example.com',
  'plivo.apiBaseUrl': 'https://api.plivo.com',
  'plivo.defaultCountryCode': '91',
};

const httpError = (status: number, data: unknown = {}) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

describe('PlivoService (real Mongo)', () => {
  let connection: Connection;
  let lines: Model<PlivoLineDocument>;
  let calls: Model<PlivoCallDocument>;
  let service: PlivoService;
  let httpGet: jest.Mock;
  let httpPost: jest.Mock;
  let integrations: { resolveAuth: jest.Mock; connectWithAuth: jest.Mock; disconnect: jest.Mock };
  let users: Map<string, { _id: { toString(): string }; name: string; organizationId: string }>;
  let config: Record<string, string>;
  let seq = 0;
  let orgId: string;
  let agent: JwtPayload;
  let plivoNumber: string;

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
    agent = { sub: `${PREFIX}-agent-${seq}`, email: 'agent@example.com', roles: ['user'], organizationId: orgId };
    plivoNumber = `9180${String(seq).padStart(2, '0')}${Date.now().toString().slice(-6)}`;
    config = { ...CONFIG };
    httpGet = jest.fn(() => of({ data: {} }));
    httpPost = jest.fn(() => of({ data: { request_uuid: 'req-uuid-1', message: 'call fired' } }));
    integrations = {
      resolveAuth: jest.fn(async () => ({ authType: 'basic', credentials: { username: 'MAXXXXXXXXXXXXXXXXXX', password: 'secret-token' } })),
      connectWithAuth: jest.fn(async () => ({ connected: true })),
      disconnect: jest.fn(async () => undefined),
    };
    users = new Map([[agent.sub, { _id: { toString: () => agent.sub }, name: 'Asha Agent', organizationId: orgId }]]);
    service = new PlivoService(
      lines,
      calls,
      integrations as never,
      { findById: async (id: string) => users.get(id) ?? null, findAll: async () => [...users.values()] } as never,
      { get: httpGet, post: httpPost } as never,
      { get: (key: string) => config[key] } as never,
    );
  });

  afterAll(async () => {
    await calls.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await lines.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  const addLine = (extra: Record<string, unknown> = {}) =>
    lines.create({ organizationId: orgId, plivoNumber, userId: agent.sub, agentPhone: '919876543210', languageCode: 'en', active: true, ...extra });

  describe('connecting the account', () => {
    it('verifies the Auth ID / Token with Plivo first, then stores them as encrypted Basic credentials', async () => {
      const status = await service.connect(orgId, 'MAXXXXXXXXXXXXXXXXXX', 'secret-token');

      expect(httpGet).toHaveBeenCalledWith('https://api.plivo.com/v1/Account/MAXXXXXXXXXXXXXXXXXX/', expect.objectContaining({ auth: { username: 'MAXXXXXXXXXXXXXXXXXX', password: 'secret-token' } }));
      expect(integrations.connectWithAuth).toHaveBeenCalledWith(orgId, 'plivo', expect.objectContaining({ authType: 'basic', credentials: { username: 'MAXXXXXXXXXXXXXXXXXX', password: 'secret-token' } }));
      expect(status.connected).toBe(true);
    });

    it('never returns or logs the token — only a masked Auth ID', async () => {
      const status = await service.status(orgId);
      expect(status).toEqual({ connected: true, authIdMasked: 'MAXX••••••••••••••XX' });
      expect(JSON.stringify(status)).not.toContain('secret-token');
    });

    it.each([401, 403, 404])('rejects a pair Plivo answers with HTTP %s, and saves nothing', async (status) => {
      httpGet.mockReturnValueOnce(throwError(() => httpError(status)));
      await expect(service.connect(orgId, 'MAXXXXXXXXXXXXXXXXXX', 'wrong')).rejects.toThrow(/did not accept this Auth ID and Auth Token/);
      expect(integrations.connectWithAuth).not.toHaveBeenCalled();
    });

    it('says so plainly when Plivo cannot be reached', async () => {
      httpGet.mockReturnValueOnce(throwError(() => new Error('ECONNREFUSED')));
      await expect(service.connect(orgId, 'MAXXXXXXXXXXXXXXXXXX', 'x')).rejects.toThrow(/Could not reach Plivo/);
      expect(integrations.connectWithAuth).not.toHaveBeenCalled();
    });

    it('reports not-connected when nothing (or a different kind of credential) is stored', async () => {
      integrations.resolveAuth.mockResolvedValueOnce(null);
      expect(await service.status(orgId)).toEqual({ connected: false });
      integrations.resolveAuth.mockResolvedValueOnce({ authType: 'apiKey', credentials: { apiKey: 'k' } });
      expect(await service.status(orgId)).toEqual({ connected: false });
    });

    it('hands out the webhook URLs only once the public base URL is configured', () => {
      expect(service.webhookUrls()).toEqual({ answer: 'https://hooks.example.com/plivo/webhooks/answer', hangup: 'https://hooks.example.com/plivo/webhooks/hangup' });
      config['plivo.publicBaseUrl'] = '';
      expect(service.webhookUrls()).toBeNull();
    });
  });

  describe('lines (which Plivo number rings whose phone)', () => {
    it('normalizes both numbers and links the line to a user of this organization', async () => {
      const result = await service.upsertLine(orgId, { plivoNumber: `+${plivoNumber.slice(0, 2)} ${plivoNumber.slice(2)}`, userId: agent.sub, agentPhone: '98765 43210', languageCode: 'hi', label: 'Sales' });

      expect(result).toEqual([expect.objectContaining({ plivoNumber, userName: 'Asha Agent', agentPhone: '919876543210', languageCode: 'hi', label: 'Sales', active: true })]);
    });

    it('updates an existing line in place instead of duplicating it', async () => {
      await service.upsertLine(orgId, { plivoNumber, userId: agent.sub, agentPhone: '9876543210' });
      const result = await service.upsertLine(orgId, { plivoNumber, userId: agent.sub, agentPhone: '9123456789', active: false });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ agentPhone: '919123456789', active: false, languageCode: 'en' });
    });

    it('rejects numbers that are not numbers, and a phone identical to the Plivo number', async () => {
      await expect(service.upsertLine(orgId, { plivoNumber: 'abc', userId: agent.sub, agentPhone: '9876543210' })).rejects.toThrow(BadRequestException);
      await expect(service.upsertLine(orgId, { plivoNumber, userId: agent.sub, agentPhone: 'nope' })).rejects.toThrow(BadRequestException);
      await expect(service.upsertLine(orgId, { plivoNumber, userId: agent.sub, agentPhone: plivoNumber })).rejects.toThrow(/must be different/);
    });

    it('will not link a number to a user from another organization', async () => {
      users.set('outsider', { _id: { toString: () => 'outsider' }, name: 'Out Sider', organizationId: `${orgId}-other` });
      await expect(service.upsertLine(orgId, { plivoNumber, userId: 'outsider', agentPhone: '9876543210' })).rejects.toThrow(/not in this organization/);
      await expect(service.upsertLine(orgId, { plivoNumber, userId: 'ghost', agentPhone: '9876543210' })).rejects.toThrow(/not in this organization/);
    });

    it('will not take a Plivo number another organization already registered', async () => {
      await addLine({ organizationId: `${orgId}-other` });
      await expect(service.upsertLine(orgId, { plivoNumber, userId: agent.sub, agentPhone: '9876543210' })).rejects.toThrow(ConflictException);
    });

    it("lists only the caller's own lines when asked, and deletes only within the organization", async () => {
      await addLine();
      expect(await service.listLines(orgId, agent.sub)).toHaveLength(1);
      expect(await service.listLines(orgId, 'someone-else')).toHaveLength(0);
      const id = (await lines.findOne({ plivoNumber }))!._id.toString();
      await expect(service.deleteLine(`${orgId}-other`, id)).rejects.toThrow(NotFoundException);
      await expect(service.deleteLine(orgId, 'not-an-id')).rejects.toThrow(NotFoundException);
      expect(await service.deleteLine(orgId, id)).toEqual([]);
    });
  });

  describe('placing a call (click-to-call)', () => {
    it("rings the agent's phone from their Plivo number, pointing Plivo back at our webhooks", async () => {
      await addLine({ languageCode: 'hi' });

      const call = await service.startCall(agent, { customerNumber: '98000 00001', dealId: 'deal-9' });

      expect(httpPost).toHaveBeenCalledTimes(1);
      const [url, body, options] = httpPost.mock.calls[0];
      expect(url).toBe('https://api.plivo.com/v1/Account/MAXXXXXXXXXXXXXXXXXX/Call/');
      expect(body).toMatchObject({
        from: plivoNumber,
        to: '919876543210',
        answer_url: `https://hooks.example.com/plivo/webhooks/answer?callId=${call._id}`,
        answer_method: 'POST',
        hangup_url: `https://hooks.example.com/plivo/webhooks/hangup?callId=${call._id}`,
      });
      expect(options.auth).toEqual({ username: 'MAXXXXXXXXXXXXXXXXXX', password: 'secret-token' });
      expect(call).toMatchObject({ direction: 'outbound', customerNumber: '919800000001', agentPhone: '919876543210', dealId: 'deal-9', languageCode: 'hi', status: 'initiated', requestUuid: 'req-uuid-1', userId: agent.sub });
    });

    it('does nothing until Plivo is connected, the public URL is set, and the user has a line', async () => {
      integrations.resolveAuth.mockResolvedValueOnce(null);
      await expect(service.startCall(agent, { customerNumber: '9800000001' })).rejects.toThrow(/not connected/);

      config['plivo.publicBaseUrl'] = '';
      await expect(service.startCall(agent, { customerNumber: '9800000001' })).rejects.toThrow(/PLIVO_PUBLIC_BASE_URL/);

      config['plivo.publicBaseUrl'] = CONFIG['plivo.publicBaseUrl'];
      await expect(service.startCall(agent, { customerNumber: '9800000001' })).rejects.toThrow(/do not have a Plivo line/);
      expect(httpPost).not.toHaveBeenCalled();
    });

    it("ignores an inactive line, and another user's line", async () => {
      await addLine({ active: false });
      await expect(service.startCall(agent, { customerNumber: '9800000001' })).rejects.toThrow(/do not have a Plivo line/);
      await lines.updateOne({ plivoNumber }, { active: true, userId: 'someone-else' });
      await expect(service.startCall(agent, { customerNumber: '9800000001' })).rejects.toThrow(/do not have a Plivo line/);
    });

    it('rejects a bad customer number, and the agent dialing their own phone or Plivo number', async () => {
      await addLine();
      await expect(service.startCall(agent, { customerNumber: '12' })).rejects.toThrow(/customer number/);
      await expect(service.startCall(agent, { customerNumber: '98765 43210' })).rejects.toThrow(/your own number/);
      await expect(service.startCall(agent, { customerNumber: plivoNumber })).rejects.toThrow(/your own number/);
      expect(httpPost).not.toHaveBeenCalled();
    });

    it('refuses a second call while one is still being set up (no double ring, no double bill)', async () => {
      await addLine();
      await service.startCall(agent, { customerNumber: '9800000001' });
      await expect(service.startCall(agent, { customerNumber: '9800000002' })).rejects.toThrow(ConflictException);
      expect(httpPost).toHaveBeenCalledTimes(1);
    });

    it("marks the call failed and shows Plivo's own reason when Plivo refuses it (e.g. a trial account's unverified number)", async () => {
      await addLine();
      httpPost.mockReturnValueOnce(throwError(() => httpError(400, { error: 'to number 919800000001 is not a verified sandbox number' })));

      await expect(service.startCall(agent, { customerNumber: '9800000001' })).rejects.toThrow('Plivo: to number 919800000001 is not a verified sandbox number');

      const logged = await calls.findOne({ userId: agent.sub });
      expect(logged).toMatchObject({ status: 'failed', failureReason: 'Plivo: to number 919800000001 is not a verified sandbox number' });
      // a failed attempt does not block the next one
      httpPost.mockReturnValueOnce(of({ data: { request_uuid: 'again' } }));
      await expect(service.startCall(agent, { customerNumber: '9800000001' })).resolves.toBeDefined();
    });

    it('tells the user to reconnect when Plivo rejects the saved credentials, and reports being unable to reach Plivo', async () => {
      await addLine();
      httpPost.mockReturnValueOnce(throwError(() => httpError(401)));
      await expect(service.startCall(agent, { customerNumber: '9800000001' })).rejects.toThrow(/Reconnect them in Settings/);
      httpPost.mockReturnValueOnce(throwError(() => new Error('socket hang up')));
      await expect(service.startCall(agent, { customerNumber: '9800000001' })).rejects.toThrow(/Could not reach Plivo/);
    });
  });

  describe('call log', () => {
    it("shows a user their own calls, and an admin the organization's", async () => {
      const make = (userId: string) => calls.create({ organizationId: orgId, userId, direction: 'outbound', plivoNumber, agentPhone: '919876543210', customerNumber: '919800000001' });
      await make(agent.sub);
      await make('someone-else');
      await calls.create({ organizationId: `${orgId}-other`, userId: agent.sub, direction: 'outbound', plivoNumber, agentPhone: '919876543210', customerNumber: '919800000001' });

      expect(await service.listCalls(agent, false)).toHaveLength(1);
      expect(await service.listCalls(agent, true)).toHaveLength(2); // this organization only
    });

    it("will not hand one user another user's call, or another organization's", async () => {
      const mine = await calls.create({ organizationId: orgId, userId: agent.sub, direction: 'outbound', plivoNumber, agentPhone: '919876543210', customerNumber: '919800000001' });
      const theirs = await calls.create({ organizationId: orgId, userId: 'someone-else', direction: 'outbound', plivoNumber, agentPhone: '919876543210', customerNumber: '919800000001' });

      await expect(service.getCallForUser(agent, mine._id.toString(), false)).resolves.toBeDefined();
      await expect(service.getCallForUser(agent, theirs._id.toString(), false)).rejects.toThrow(NotFoundException);
      await expect(service.getCallForUser(agent, theirs._id.toString(), true)).resolves.toBeDefined(); // an admin may
      await expect(service.getCallForUser({ ...agent, organizationId: `${orgId}-other` }, mine._id.toString(), true)).rejects.toThrow(NotFoundException);
      await expect(service.getCallForUser(agent, 'nope', false)).rejects.toThrow(NotFoundException);
    });
  });
});
