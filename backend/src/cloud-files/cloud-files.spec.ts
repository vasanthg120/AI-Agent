import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { promises as fs } from 'fs';
import { Connection, Model, Types } from 'mongoose';
import * as os from 'os';
import * as path from 'path';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { EncryptionService } from '../common/encryption/encryption.service';
import { CloudAccessService } from './cloud-access.service';
import { CloudConnectionsService } from './cloud-connections.service';
import { CloudFilesService } from './cloud-files.service';
import { ROOT_REF, SHARED_REF } from './cloud-files.types';
import { fakeDrive } from '../../test/fake-cloud-drive';
import { CloudConnection, CloudConnectionDocument, CloudConnectionSchema } from './schemas/cloud-connection.schema';
import { CloudFolderGrant, CloudFolderGrantDocument, CloudFolderGrantSchema } from './schemas/cloud-folder-grant.schema';

const PREFIX = `jest-cloud-${Date.now()}`;

describe('Cloud files: who may open what (real Mongo)', () => {
  let connection: Connection;
  let connections: Model<CloudConnectionDocument>;
  let grants: Model<CloudFolderGrantDocument>;
  let encryption: EncryptionService;
  let seq = 0;
  let org: string;
  let google: ReturnType<typeof fakeDrive>;
  let onedrive: ReturnType<typeof fakeDrive>;
  let connectionsService: CloudConnectionsService;
  let access: CloudAccessService;
  let files: CloudFilesService;
  const audit = { log: jest.fn() };
  const jwt = { sign: (payload: object) => JSON.stringify(payload), verify: (token: string) => JSON.parse(token) };
  const config = { get: (key: string) => (key === 'corsOrigin' ? 'http://app.test' : key === 'encryptionKey' ? 'test-key' : undefined) };

  const user = (id: string, roles: string[], organizationId = org): JwtPayload => ({ sub: id, email: `${id}@acme.test`, roles, organizationId });

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({ imports: [MongooseModule.forRoot(uri)] }).compile();
    connection = moduleRef.get(getConnectionToken());
    connections = connection.model(CloudConnection.name, CloudConnectionSchema) as unknown as Model<CloudConnectionDocument>;
    grants = connection.model(CloudFolderGrant.name, CloudFolderGrantSchema) as unknown as Model<CloudFolderGrantDocument>;
    await connections.syncIndexes();
    await grants.syncIndexes();
    encryption = new EncryptionService(config as never);
  });

  beforeEach(async () => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    jest.clearAllMocks();
    google = fakeDrive('google_drive');
    onedrive = fakeDrive('onedrive');
    connectionsService = new CloudConnectionsService(
      google as unknown as never,
      onedrive as unknown as never,
      connections,
      grants,
      connection,
      encryption,
      jwt as never,
      config as never,
      audit as never,
    );
    access = new CloudAccessService(connectionsService, grants);
    files = new CloudFilesService(connectionsService, access, audit as never, grants);
    await connection.collection('users').insertMany([
      { _id: new Types.ObjectId(), organizationId: org, email: `owner-${seq}@acme.test`, name: 'Olga Owner', roles: ['owner'] },
    ]);
  });

  afterAll(async () => {
    await connection.collection('cloud_connections').deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.collection('cloud_folder_grants').deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.collection('users').deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  const connect = async (ownership: 'personal' | 'company', userId: string, provider: 'google_drive' | 'onedrive' = 'google_drive', expiresInMs = 3_600_000) =>
    (
      await connections.create({
        organizationId: org,
        provider,
        ownership,
        userId,
        accountId: `acct-${ownership}-${userId}`,
        accountEmail: `${ownership}@drive.test`,
        accessToken: encryption.encrypt('access-1'),
        refreshToken: encryption.encrypt('refresh-1'),
        expiresAt: new Date(Date.now() + expiresInMs),
        scope: 'files',
      })
    )._id.toString();

  it('a personal account is only ever opened by the person who connected it', async () => {
    const mine = await connect('personal', 'u-priya');
    const priya = user('u-priya', ['manager']);
    expect((await files.list(priya, mine, 'sales', {})).items.map((i) => i.name)).toEqual(['Acme']);
    // A colleague — even the owner — and anyone in another organization: as if it didn't exist.
    await expect(files.list(user('u-olga', ['owner']), mine, 'sales', {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(files.list(user('u-priya', ['manager'], `${org}-other`), mine, 'sales', {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(connectionsService.disconnect(user('u-olga', ['owner']), mine)).rejects.toBeInstanceOf(NotFoundException);
    // Their own listing of what is connected shows it to them and to nobody else.
    expect((await connectionsService.overview(priya)).find((p) => p.id === 'google_drive')!.mine.map((c) => c.id)).toEqual([mine]);
    expect((await connectionsService.overview(user('u-arun', ['manager']))).find((p) => p.id === 'google_drive')!.mine).toEqual([]);
  });

  it('the company account opens to other roles only below the folders granted to them, and only as far as granted', async () => {
    const company = await connect('company', 'u-olga');
    const owner = user('u-olga', ['owner']);
    const manager = user('u-mia', ['manager']);
    const consultant = user('u-carl', ['consultant']);

    // Nothing shared yet: a manager can't open it and doesn't see it.
    await expect(files.roots(manager, company)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await connectionsService.overview(manager)).find((p) => p.id === 'google_drive')!.company).toBeNull();

    // Only owners and admins share folders; never a file, never the whole drive.
    await expect(files.setGrants(manager, company, [{ folderId: 'sales', roles: ['manager'], access: 'view' }])).rejects.toBeInstanceOf(ForbiddenException);
    await expect(files.setGrants(owner, company, [{ folderId: 'quote', roles: ['manager'], access: 'view' }])).rejects.toBeInstanceOf(BadRequestException);
    await expect(files.setGrants(owner, company, [{ folderId: ROOT_REF, roles: ['manager'], access: 'view' }])).rejects.toBeInstanceOf(BadRequestException);
    const saved = await files.setGrants(owner, company, [{ folderId: 'sales', roles: ['manager', 'owner'], access: 'view' }]);
    expect(saved).toEqual([{ folderId: 'sales', name: 'Sales', path: 'My Drive / Sales', roles: ['manager'], access: 'view' }]);

    // The manager starts at Sales, can go down into it and download from it…
    expect((await files.roots(manager, company)).map((r) => r.name)).toEqual(['Sales']);
    expect((await files.list(manager, company, 'acme', {})).items.map((i) => i.name)).toEqual(['quote.pdf']);
    expect((await files.download(manager, company, 'quote')).name).toBe('quote.pdf');
    expect((await files.item(manager, company, 'quote', true)).path!.map((p) => p.name)).toEqual(['Sales', 'Acme']);
    // …but HR, the drive's top and a search across it show nothing outside Sales.
    await expect(files.list(manager, company, 'hr', {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(files.download(manager, company, 'payroll')).rejects.toBeInstanceOf(NotFoundException);
    await expect(files.list(manager, company, ROOT_REF, {})).rejects.toBeInstanceOf(ForbiddenException);
    // "a" matches Sales, Acme and payroll.xlsx in the drive — the manager gets only what is in Sales.
    expect((await files.search(owner, company, { query: 'a' })).items.map((i) => i.name).sort()).toEqual(['Acme', 'Sales', 'payroll.xlsx']);
    expect((await files.search(manager, company, { query: 'a' })).items.map((i) => i.name).sort()).toEqual(['Acme', 'Sales']);
    // View only: no uploads, folders, renames or deletes; and never the granted folder itself.
    await expect(files.createFolder(manager, company, 'acme', 'Orders')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(files.update(manager, company, 'quote', { name: 'q.pdf' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(files.remove(manager, company, 'sales')).rejects.toBeInstanceOf(BadRequestException);
    // Another role has nothing.
    await expect(files.roots(consultant, company)).rejects.toBeInstanceOf(ForbiddenException);

    // Edit on Acme only: folders there, nothing in Sales itself.
    await files.setGrants(owner, company, [
      { folderId: 'sales', roles: ['manager'], access: 'view' },
      { folderId: 'acme', roles: ['manager'], access: 'edit' },
    ]);
    const orders = await files.createFolder(manager, company, 'acme', 'Orders');
    expect(orders.name).toBe('Orders');
    // Made again (a retry, a double click): the same folder, not a second one.
    expect((await files.createFolder(manager, company, 'acme', 'Orders')).id).toBe(orders.id);
    await expect(files.createFolder(manager, company, 'sales', 'Elsewhere')).rejects.toBeInstanceOf(ForbiddenException);
    // A move needs edit at both ends.
    await expect(files.update(manager, company, 'quote', { parentId: 'sales' })).rejects.toBeInstanceOf(ForbiddenException);

    // The owner sees the whole account.
    expect((await files.list(owner, company, ROOT_REF, {})).items.map((i) => i.name).sort()).toEqual(['HR', 'Sales']);
    // Every change was audited with what changed.
    expect(audit.log.mock.calls.map(([entry]) => entry.action)).toEqual(expect.arrayContaining(['cloud.grant_change', 'cloud.folder_create', 'cloud.download']));
  });

  it('a folder is never moved into itself, and the drive itself and "Shared with me" are not changed from HaiVE', async () => {
    const mine = await connect('personal', 'u-priya');
    const priya = user('u-priya', ['manager']);
    await expect(files.update(priya, mine, 'sales', { parentId: 'acme' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(files.remove(priya, mine, ROOT_REF)).rejects.toBeInstanceOf(BadRequestException);
    await expect(files.createFolder(priya, mine, SHARED_REF, 'x')).rejects.toBeInstanceOf(BadRequestException);
    // A file renamed to something that runs is refused.
    await expect(files.update(priya, mine, 'quote', { name: 'quote.exe' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an upload goes to the folder chosen, refuses what runs, and never leaves its temporary file behind', async () => {
    const mine = await connect('personal', 'u-priya');
    const priya = user('u-priya', ['manager']);
    const temp = async (name: string) => {
      const file = path.join(os.tmpdir(), `${PREFIX}-${name}`);
      await fs.writeFile(file, 'hello');
      return { path: file, originalname: name, size: 5, mimetype: 'text/plain' } as Express.Multer.File;
    };
    const ok = await temp('notes.txt');
    const uploaded = await files.upload(priya, mine, 'acme', ok);
    expect(google.nodes[uploaded.id]).toMatchObject({ name: 'notes.txt', parent: 'acme' });
    await expect(fs.access(ok.path)).rejects.toThrow();

    const bad = await temp('setup.exe');
    await expect(files.upload(priya, mine, 'acme', bad)).rejects.toBeInstanceOf(BadRequestException);
    await expect(fs.access(bad.path)).rejects.toThrow();

    // Someone else's account: refused, and still cleaned up.
    const theirs = await temp('a.txt');
    await expect(files.upload(user('u-arun', ['manager']), mine, 'acme', theirs)).rejects.toBeInstanceOf(NotFoundException);
    await expect(fs.access(theirs.path)).rejects.toThrow();
  });

  it('tokens are refreshed before they run out, retried once when refused, and a revoked account asks to be reconnected', async () => {
    const mine = await connect('personal', 'u-priya', 'onedrive', 30_000);
    const priya = user('u-priya', ['manager']);
    // About to expire: refreshed first, and the new (rotated) tokens are stored encrypted.
    await files.list(priya, mine, ROOT_REF, {});
    expect(onedrive.refreshes).toBe(1);
    expect(onedrive.tokens.at(-1)).toBe('access-2');
    const stored = await connections.findById(mine).lean();
    expect(stored!.accessToken).not.toContain('access-2');
    expect(encryption.decrypt(stored!.accessToken)).toBe('access-2');
    expect(encryption.decrypt(stored!.refreshToken!)).toBe('refresh-2');

    // The provider turns a still-valid-looking token down: one refresh, one retry.
    onedrive.rejectToken = 'access-2';
    await files.list(priya, mine, ROOT_REF, {});
    expect(onedrive.refreshes).toBe(2);
    expect(onedrive.tokens.at(-1)).toBe('access-3');

    // Consent withdrawn: the refresh fails, the account says so, and nothing more is tried until reconnected.
    onedrive.rejectToken = 'access-3';
    onedrive.failRefresh = true;
    await expect(files.list(priya, mine, ROOT_REF, {})).rejects.toMatchObject({ kind: 'auth' });
    expect((await connections.findById(mine).lean())!.status).toBe('needs_reauth');
    const calls = onedrive.refreshes;
    await expect(files.list(priya, mine, ROOT_REF, {})).rejects.toMatchObject({ kind: 'auth' });
    expect(onedrive.refreshes).toBe(calls);
    expect((await connectionsService.overview(priya)).find((p) => p.id === 'onedrive')!.mine[0].status).toBe('needs_reauth');
  });

  it('connecting: the company account needs an owner or admin, replacing it clears the old account’s shared folders, and disconnecting forgets the tokens', async () => {
    const ownerDoc = await connection.collection('users').findOne({ organizationId: org });
    const ownerId = ownerDoc!._id.toString();
    const managerId = (
      await connection.collection('users').insertOne({ organizationId: org, email: `mia-${seq}@acme.test`, name: 'Mia', roles: ['manager'] })
    ).insertedId.toString();

    expect(() => connectionsService.connectUrl(user(managerId, ['manager']), 'google_drive', 'company')).toThrow(ForbiddenException);
    const url = connectionsService.connectUrl(user(ownerId, ['owner']), 'google_drive', 'company');
    const state = connectionsService.readState(decodeURIComponent(url.split('state=')[1]))!;
    expect(state).toMatchObject({ purpose: 'cloud_files', provider: 'google_drive', ownership: 'company' });
    // A state from another flow (Outlook's) is not this flow's.
    expect(connectionsService.readState(JSON.stringify({ sub: ownerId, organizationId: org }))).toBeNull();

    // A manager who somehow got a company state is still refused at the end.
    expect(await connectionsService.finish({ ...state, sub: managerId }, 'code')).toBe('http://app.test/integrations?cloud=google_drive&result=forbidden');
    expect(await connectionsService.finish(state, undefined, 'access_denied')).toBe('http://app.test/integrations?cloud=google_drive&result=cancelled');
    expect(await connectionsService.finish(state, 'code')).toBe('http://app.test/integrations?cloud=google_drive&result=connected');
    const company = (await connections.findOne({ organizationId: org, ownership: 'company' }).lean())!;
    expect(encryption.decrypt(company.refreshToken!)).toBe('refresh-1');
    await files.setGrants(user(ownerId, ['owner']), company._id.toString(), [{ folderId: 'sales', roles: ['manager'], access: 'view' }]);

    // Reconnected with a different account: still one company account, its old shared folders gone.
    google.account = async () => ({ accountId: 'acct-2', email: 'other@drive.test', name: 'Other' });
    await connectionsService.finish(state, 'code');
    expect(await connections.countDocuments({ organizationId: org, ownership: 'company' })).toBe(1);
    expect(await grants.countDocuments({ connectionId: company._id.toString() })).toBe(0);

    await connectionsService.disconnect(user(ownerId, ['owner']), company._id.toString());
    expect(google.revoke).toHaveBeenCalledWith({ refreshToken: 'refresh-1', accessToken: 'access-1' });
    expect(await connections.countDocuments({ organizationId: org })).toBe(0);
  });
});
