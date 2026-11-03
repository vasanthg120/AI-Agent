import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection } from 'mongoose';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { CustomerDirectoryService } from './customer-directory.service';
import { CustomerMailService } from './customer-mail.service';
import { CustomerWorkspaceService } from './customer-workspace.service';
import { UsersModule } from '../users/users.module';
import { UsersService } from '../users/users.service';

// Hoops-parity Tasks tab — the one cross-customer view TASKS_COLLECTION
// never needed before: every other caller already has one customer in
// hand. Proves listAllTasks reuses the existing collection/identity-key
// machinery rather than a second task system, stays org-scoped, and
// resolves each task back to a real customer name.
const PREFIX = `jest-cross-tasks-${Date.now()}`;

describe('CustomerWorkspaceService.listAllTasks (real Mongo)', () => {
  let connection: Connection;
  let directory: CustomerDirectoryService;
  let workspace: CustomerWorkspaceService;
  let users: UsersService;
  let seq = 0;
  let org: string;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({ imports: [MongooseModule.forRoot(uri), UsersModule] }).compile();
    connection = moduleRef.get(getConnectionToken());
    users = moduleRef.get(UsersService);
  });

  beforeEach(() => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    directory = new CustomerDirectoryService(
      connection,
      new CustomerMailService(connection),
      { syncNow: jest.fn() } as never,
      { reserve: jest.fn(), settle: jest.fn(), release: jest.fn(), resolveTenantKey: (o: string) => o } as never,
      { post: jest.fn() } as never,
      { sign: () => 'jwt' } as never,
      users,
      { get: () => 'http://agent' } as never,
    );
    workspace = new CustomerWorkspaceService(connection, directory, new GridFsService(connection));
  });

  afterAll(async () => {
    for (const name of ['crm_contacts', 'customer_tasks', 'users']) {
      await connection.collection(name).deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    }
    await connection.close();
  });

  const asUser = (organizationId: string, sub = 'tester') => ({ sub, email: 't@example.test', roles: ['owner'], organizationId });

  it('lists tasks across two different customers, each resolved to its real customer name', async () => {
    const a = (await directory.createCustomer(asUser(org), { name: 'Alpha Co', email: 'alpha@cross.test' })).created!;
    const b = (await directory.createCustomer(asUser(org), { name: 'Beta Co', email: 'beta@cross.test' })).created!;
    await workspace.addTask(asUser(org), a.id, { title: 'Call Alpha' });
    await workspace.addTask(asUser(org), b.id, { title: 'Email Beta' });

    const tasks = await workspace.listAllTasks(asUser(org));
    const titles = tasks.map((t) => [t.title, t.customerName]).sort();
    expect(titles).toEqual([
      ['Call Alpha', 'Alpha Co'],
      ['Email Beta', 'Beta Co'],
    ]);
  });

  it('filters by status', async () => {
    const customer = (await directory.createCustomer(asUser(org), { name: 'Gamma Co', email: 'gamma@cross.test' })).created!;
    const open = await workspace.addTask(asUser(org), customer.id, { title: 'Still open' });
    const toClose = await workspace.addTask(asUser(org), customer.id, { title: 'Will be done' });
    await workspace.updateTask(asUser(org), customer.id, toClose.id, { status: 'done' });

    const openOnly = await workspace.listAllTasks(asUser(org), { status: 'open' });
    expect(openOnly.map((t) => t.id)).toEqual([open.id]);

    const doneOnly = await workspace.listAllTasks(asUser(org), { status: 'done' });
    expect(doneOnly.map((t) => t.id)).toEqual([toClose.id]);
  });

  it('`mine` narrows to tasks the caller created or was assigned, not the whole org board', async () => {
    const customer = (await directory.createCustomer(asUser(org), { name: 'Delta Co', email: 'delta@cross.test' })).created!;
    await workspace.addTask(asUser(org, 'user-a'), customer.id, { title: 'By user A' });
    await workspace.addTask(asUser(org, 'user-b'), customer.id, { title: 'By user B' });

    const all = await workspace.listAllTasks(asUser(org, 'user-a'));
    expect(all.length).toBe(2);

    const mine = await workspace.listAllTasks(asUser(org, 'user-a'), { mine: true });
    expect(mine.map((t) => t.title)).toEqual(['By user A']);
  });

  it('organization isolation: tasks from one org never appear in another org\'s list', async () => {
    const otherOrg = `${org}-iso`;
    const customer = (await directory.createCustomer(asUser(org), { name: 'Epsilon Co', email: 'epsilon@cross.test' })).created!;
    await workspace.addTask(asUser(org), customer.id, { title: 'Org-scoped task' });

    const otherOrgTasks = await workspace.listAllTasks(asUser(otherOrg));
    expect(otherOrgTasks.length).toBe(0);
  });
});
