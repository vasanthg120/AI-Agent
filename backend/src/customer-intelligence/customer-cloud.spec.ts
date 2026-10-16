import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { promises as fs } from 'fs';
import { Connection, Model, Types } from 'mongoose';
import * as os from 'os';
import * as path from 'path';
import { fakeDrive } from '../../test/fake-cloud-drive';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CloudAccessService } from '../cloud-files/cloud-access.service';
import { CloudConnectionsService } from '../cloud-files/cloud-connections.service';
import { CloudConnection, CloudConnectionDocument, CloudConnectionSchema } from '../cloud-files/schemas/cloud-connection.schema';
import { CloudFolderGrant, CloudFolderGrantDocument, CloudFolderGrantSchema } from '../cloud-files/schemas/cloud-folder-grant.schema';
import { EncryptionService } from '../common/encryption/encryption.service';
import { CustomerCloudSyncService } from './customer-cloud-sync.service';
import { CLOUD_FOLDERS_COLLECTION, CLOUD_INDEX_COLLECTION, CLOUD_LINKS_COLLECTION, CustomerCloudService } from './customer-cloud.service';

const PREFIX = `jest-custcloud-${Date.now()}`;

// A customer's Google Drive / OneDrive documents, against a real Mongo and an
// in-memory drive: one folder is one customer's, a customer folder is made once,
// browsing stays inside it, and someone's own account is never borrowed.
describe('Customer cloud documents (real Mongo)', () => {
  let connection: Connection;
  let connections: Model<CloudConnectionDocument>;
  let grants: Model<CloudFolderGrantDocument>;
  let encryption: EncryptionService;
  let google: ReturnType<typeof fakeDrive>;
  let service: CustomerCloudService;
  let sync: CustomerCloudSyncService;
  let connectionsService: CloudConnectionsService;
  let seq = 0;
  let org: string;
  const audit = { log: jest.fn() };
  const config = { get: (key: string) => (key === 'encryptionKey' ? 'test-key' : key === 'corsOrigin' ? 'http://app.test' : undefined) };
  const jwt = { sign: (p: object) => JSON.stringify(p), verify: (t: string) => JSON.parse(t) };
  // Two customers whose names look alike — told apart by who they are (their email), never by name.
  const customers: Record<string, { id: string; name: string; keys: string[] }> = {
    'cust-a': { id: 'cust-a', name: 'Acme Traders', keys: ['e:buyer@acme.test'] },
    'cust-b': { id: 'cust-b', name: 'Acme Trading Co', keys: ['e:office@acmetrading.test'] },
  };
  const directory = {
    identity: async (_org: string, id: string) => {
      const c = customers[id];
      if (!c) throw new NotFoundException('Customer not found.');
      return { ...c, emails: [], dealIds: [], quoteIds: [] };
    },
    quotation: async (_org: string, customerId: string, quotationId: string) => {
      if (customerId === 'cust-a' && quotationId === 'q1') return { document: { number: 'Q-1' } };
      throw new NotFoundException('Quotation not found.');
    },
    customerIds: async () => new Map(Object.values(customers).flatMap((c) => c.keys.map((k) => [k, c.id] as [string, string]))),
  };
  const workspace = {
    canManage: (caller: JwtPayload) => caller.roles.includes('owner') || caller.roles.includes('admin'),
    nameOf: async (caller: JwtPayload) => caller.email,
    addFile: jest.fn(async (_caller: JwtPayload, _customerId: string, file: Express.Multer.File) => ({
      id: new Types.ObjectId().toString(),
      name: file.originalname,
      size: file.size,
      type: file.mimetype,
      uploadedBy: 'x',
      at: new Date(),
      mine: true,
      kind: 'file' as const,
    })),
  };
  const user = (id: string, roles: string[]): JwtPayload => ({ sub: id, email: `${id}@team.test`, roles, organizationId: org });
  const owner = () => user('u-olga', ['owner']);
  const priya = () => user('u-priya', ['manager']);
  const arun = () => user('u-arun', ['manager']);

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({ imports: [MongooseModule.forRoot(uri)] }).compile();
    connection = moduleRef.get(getConnectionToken());
    connections = connection.model(CloudConnection.name, CloudConnectionSchema) as unknown as Model<CloudConnectionDocument>;
    grants = connection.model(CloudFolderGrant.name, CloudFolderGrantSchema) as unknown as Model<CloudFolderGrantDocument>;
    encryption = new EncryptionService(config as never);
  });

  beforeEach(async () => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    jest.clearAllMocks();
    google = fakeDrive('google_drive');
    connectionsService = new CloudConnectionsService(
      google as unknown as never,
      fakeDrive('onedrive') as unknown as never,
      connections,
      grants,
      connection,
      encryption,
      jwt as never,
      config as never,
      audit as never,
    );
    const access = new CloudAccessService(connectionsService, grants);
    service = new CustomerCloudService(connection, directory as never, workspace as never, connectionsService, access, audit as never);
    await service.onModuleInit();
    sync = new CustomerCloudSyncService(connection, connectionsService, access);
  });

  afterAll(async () => {
    for (const name of ['cloud_connections', 'cloud_folder_grants', CLOUD_FOLDERS_COLLECTION, CLOUD_LINKS_COLLECTION, CLOUD_INDEX_COLLECTION])
      await connection.collection(name).deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  const connect = async (ownership: 'personal' | 'company', userId: string, token = `access-${userId}`) =>
    (
      await connections.create({
        organizationId: org,
        provider: 'google_drive',
        ownership,
        userId,
        accountId: `acct-${ownership}-${userId}`,
        accountEmail: `${userId}@drive.test`,
        accessToken: encryption.encrypt(token),
        refreshToken: encryption.encrypt('refresh'),
        expiresAt: new Date(Date.now() + 3_600_000),
        scope: 'drive',
      })
    )._id.toString();

  it('a folder is one customer’s: linking it again is one link, and a customer with a similar name can’t have it too', async () => {
    const company = await connect('company', 'u-olga');
    const linked = await service.linkFolder(owner(), 'cust-a', company, 'acme');
    expect(linked).toMatchObject({ name: 'Acme', ownership: 'company', reach: 'open' });
    await service.linkFolder(owner(), 'cust-a', company, 'acme');
    expect(await connection.collection(CLOUD_FOLDERS_COLLECTION).countDocuments({ organizationId: org })).toBe(1);
    await expect(service.linkFolder(owner(), 'cust-b', company, 'acme')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.linkFolder(owner(), 'cust-a', company, 'quote')).rejects.toBeInstanceOf(BadRequestException);
    // The other customer sees nothing of it.
    expect((await service.overview(owner(), 'cust-b')).folders).toEqual([]);
  });

  it('“Create a customer folder” makes it and its five folders once, however often it is asked', async () => {
    const company = await connect('company', 'u-olga');
    const first = await service.createFolder(owner(), 'cust-a', company, 'sales', 'Acme Traders', true);
    const again = await service.createFolder(owner(), 'cust-a', company, 'sales', 'Acme Traders', true);
    expect(again.folderId).toBe(first.folderId);
    expect(first.subfolders.map((s) => s.label)).toEqual(['Quotations', 'Invoices', 'Contracts', 'Orders', 'General Documents']);
    const made = Object.values(google.nodes).filter((n) => n.parent === first.folderId);
    expect(made).toHaveLength(5);
    expect(Object.values(google.nodes).filter((n) => n.name === 'Acme Traders')).toHaveLength(1);
    expect(await connection.collection(CLOUD_FOLDERS_COLLECTION).countDocuments({ organizationId: org })).toBe(1);
  });

  it('a company folder opens to whoever may open the customer — and only inside it', async () => {
    const company = await connect('company', 'u-olga');
    const folder = await service.linkFolder(owner(), 'cust-a', company, 'sales');
    // A manager with no company folders shared with their role still works the customer's folder…
    expect((await service.browse(priya(), 'cust-a', folder.id, {})).items.map((i) => i.name)).toEqual(['Acme']);
    expect((await service.browse(priya(), 'cust-a', folder.id, { folderId: 'acme' })).items.map((i) => i.name)).toEqual(['quote.pdf']);
    // …but nothing outside it, under any id.
    await expect(service.browse(priya(), 'cust-a', folder.id, { folderId: 'hr' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.folderItem(priya(), 'cust-a', folder.id, 'payroll', false)).rejects.toBeInstanceOf(NotFoundException);
    // Nor through the other customer.
    await expect(service.browse(priya(), 'cust-b', folder.id, {})).rejects.toBeInstanceOf(NotFoundException);

    const file = path.join(os.tmpdir(), `${PREFIX}-po.pdf`);
    await fs.writeFile(file, 'po');
    const uploaded = await service.upload(priya(), 'cust-a', folder.id, 'acme', { path: file, originalname: 'PO-17.pdf', size: 2, mimetype: 'application/pdf' } as Express.Multer.File);
    expect(google.nodes[uploaded.id]).toMatchObject({ name: 'PO-17.pdf', parent: 'acme' });
    await expect(fs.access(file)).rejects.toThrow();
    const outside = path.join(os.tmpdir(), `${PREFIX}-x.pdf`);
    await fs.writeFile(outside, 'x');
    await expect(service.upload(priya(), 'cust-a', folder.id, 'hr', { path: outside, originalname: 'x.pdf', size: 1, mimetype: 'application/pdf' } as Express.Multer.File)).rejects.toBeInstanceOf(NotFoundException);
    await expect(fs.access(outside)).rejects.toThrow();
  });

  it('a folder in someone’s own Drive opens only with the viewer’s own account, and only once it is shared with them', async () => {
    const mine = await connect('personal', 'u-priya');
    const folder = await service.linkFolder(priya(), 'cust-a', mine, 'acme');
    expect((await service.browse(priya(), 'cust-a', folder.id, {})).items.map((i) => i.name)).toEqual(['quote.pdf']);
    expect((await service.overview(arun(), 'cust-a')).folders[0]).toMatchObject({ ownerName: undefined, reach: 'disconnected' });

    // Arun has no Google Drive of his own: Priya's is never lent to him.
    await expect(service.browse(arun(), 'cust-a', folder.id, {})).rejects.toMatchObject({ kind: 'permission' });
    // He connects his own; Priya hasn't shared the folder with it.
    await connect('personal', 'u-arun', 'access-arun');
    google.canSee = (token, itemId) => token !== 'access-arun' || !['acme', 'quote'].includes(itemId);
    expect((await service.overview(arun(), 'cust-a')).folders[0].reach).toBe('own_account');
    await expect(service.browse(arun(), 'cust-a', folder.id, {})).rejects.toMatchObject({ kind: 'permission' });
    // Shared with him in Google Drive: now it opens, with his own token.
    google.canSee = () => true;
    expect((await service.browse(arun(), 'cust-a', folder.id, {})).items.map((i) => i.name)).toEqual(['quote.pdf']);
    expect(google.tokens.at(-1)).toBe('access-arun');
    // Only Priya (who linked it) or an admin may unlink it — and unlinking deletes nothing in the cloud.
    await expect(service.unlinkFolder(arun(), 'cust-a', folder.id)).rejects.toBeInstanceOf(ForbiddenException);
    await service.unlinkFolder(owner(), 'cust-a', folder.id);
    expect(google.nodes.acme).toBeDefined();
    expect((await service.overview(priya(), 'cust-a')).folders).toEqual([]);
  });

  it('attaching from the company account needs the file to be in a folder shared with your role', async () => {
    const company = await connect('company', 'u-olga');
    // Priya's role has no company folders: she can't pick files from the company account to attach.
    await expect(service.attach(priya(), 'cust-a', company, ['quote'], 'quotation', 'q1')).rejects.toBeInstanceOf(ForbiddenException);
    await grants.create({ organizationId: org, connectionId: company, folderId: 'acme', name: 'Acme', path: 'My Drive / Sales / Acme', roles: ['manager'], access: 'view' });
    const [link] = await service.attach(priya(), 'cust-a', company, ['quote']);
    expect(link).toMatchObject({ name: 'quote.pdf', category: 'other' });
    // Still nothing outside the shared folder.
    await expect(service.attach(priya(), 'cust-a', company, ['payroll'])).rejects.toBeInstanceOf(NotFoundException);
  });

  it('attaching, removing and copying a cloud file', async () => {
    const company = await connect('company', 'u-olga');
    const [link] = await service.attach(owner(), 'cust-a', company, ['quote'], 'quotation', 'q1');
    expect(link).toMatchObject({ name: 'quote.pdf', category: 'quotation', linkedTo: { label: 'Quotation Q-1' }, location: 'My Drive / Sales / Acme', status: 'available' });
    await service.attach(owner(), 'cust-a', company, ['quote']);
    expect(await connection.collection(CLOUD_LINKS_COLLECTION).countDocuments({ organizationId: org })).toBe(1);
    await expect(service.attach(owner(), 'cust-a', company, ['quote'], 'quotation', 'q-of-someone-else')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.attach(owner(), 'cust-a', company, ['quote'], 'bribe')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.attach(owner(), 'cust-a', company, ['acme'])).rejects.toBeInstanceOf(BadRequestException);
    expect((await service.overview(owner(), 'cust-b')).links).toEqual([]);

    // Copy into HaiVE: the file's bytes become the customer's own file.
    await service.copyIntoHaive(priya(), 'cust-a', link.id);
    expect(workspace.addFile).toHaveBeenCalledWith(expect.anything(), 'cust-a', expect.objectContaining({ originalname: 'quote.pdf', buffer: Buffer.from('content') }));

    // Deleted in the cloud: the customer says so once someone tries to open it.
    delete google.nodes.quote;
    await expect(service.linkContent(priya(), 'cust-a', link.id, false)).rejects.toMatchObject({ kind: 'not_found' });
    expect((await service.overview(priya(), 'cust-a')).links[0].status).toBe('deleted');

    // Only whoever attached it, or an admin, takes it off; nothing in the cloud changes.
    await expect(service.removeLink(priya(), 'cust-a', link.id)).rejects.toBeInstanceOf(ForbiddenException);
    await service.removeLink(owner(), 'cust-a', link.id);
    expect((await service.overview(owner(), 'cust-a')).links).toEqual([]);
    expect(audit.log.mock.calls.map(([e]) => e.action)).toEqual(expect.arrayContaining(['customer.cloud_file_attach', 'customer.cloud_file_copy', 'customer.cloud_file_detach']));
  });

  it('the sync keeps attached files true to the cloud, and lists what is inside customer folders so they can be searched all the way down', async () => {
    const company = await connect('company', 'u-olga');
    const folder = await service.linkFolder(owner(), 'cust-a', company, 'sales');
    const [link] = await service.attach(owner(), 'cust-a', company, ['quote']);
    google.nodes.deep = { name: 'signed-contract.pdf', kind: 'file', parent: 'acme', mimeType: 'application/pdf' };

    // Renamed and moved in the cloud: the customer shows the new name and where it is now.
    google.nodes.quote.name = 'quote-v2.pdf';
    google.nodes.quote.parent = 'sales';
    const first = await sync.syncConnection(await connectionsService.find(org, company));
    expect(first).toMatchObject({ linksChecked: 1, linksChanged: 1, foldersIndexed: 1, filesIndexed: 3, partial: false });
    expect((await service.overview(owner(), 'cust-a')).links[0]).toMatchObject({ id: link.id, name: 'quote-v2.pdf', status: 'moved', location: 'My Drive / Sales' });
    expect((await service.overview(owner(), 'cust-a')).folders[0]).toMatchObject({ indexedCount: 3 });

    // Google's own search finds nothing two folders down; what the sync listed does.
    google.search = async () => ({ items: [] });
    expect((await service.search(priya(), 'cust-a', folder.id, 'contract')).items.map((i) => i.name)).toEqual(['signed-contract.pdf']);
    // …and only for this customer's folder.
    await expect(service.search(priya(), 'cust-b', folder.id, 'contract')).rejects.toBeInstanceOf(NotFoundException);

    // Deleted in the cloud: said on the customer, and gone from the index.
    delete google.nodes.quote;
    delete google.nodes.deep;
    const second = await sync.syncConnection(await connectionsService.find(org, company));
    expect(second).toMatchObject({ linksGone: 1, filesIndexed: 1 });
    expect((await service.overview(owner(), 'cust-a')).links[0].status).toBe('deleted');
    expect((await service.search(priya(), 'cust-a', folder.id, 'contract')).items).toEqual([]);
    expect((await connections.findById(company).lean())!.lastSyncStatus).toBe('ok');

    // "Sync now" is for an account the person may open.
    await expect(sync.syncNow(priya(), company)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(sync.syncNow(owner(), company)).resolves.toMatchObject({ linksChecked: 1 });
  });
});
