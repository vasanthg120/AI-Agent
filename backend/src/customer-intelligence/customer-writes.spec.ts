import { BadRequestException } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection } from 'mongoose';
import { CustomerDirectoryService } from './customer-directory.service';
import { CustomerMailService } from './customer-mail.service';
import { UsersModule } from '../users/users.module';
import { UsersService } from '../users/users.service';
import { ConfigModule } from '@nestjs/config';
import { MailModule } from '../mail/mail.module';

// Phase 3 — "customer" has no document of its own (see customer-directory.
// service.ts's own header comment); these are the first real write
// operations it gets: add/edit/archive, the assigned rep, extra contacts,
// and duplicate detection. All of it layers on top of the existing
// computed directory via customer_profiles (customer-directory.service.ts's
// upsertProfile), never a second "customer" collection.
const PREFIX = `jest-cust-writes-${Date.now()}`;

describe('Customers — writes (real Mongo)', () => {
  let connection: Connection;
  let service: CustomerDirectoryService;
  let users: UsersService;
  let seq = 0;
  let org: string;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      // UsersModule sends invitation emails (MailService), which the app provides globally.
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), MailModule, MongooseModule.forRoot(uri), UsersModule],
    }).compile();
    connection = moduleRef.get(getConnectionToken());
    users = moduleRef.get(UsersService);
  });

  beforeEach(() => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    service = new CustomerDirectoryService(
      connection,
      new CustomerMailService(connection),
      { syncNow: jest.fn() } as never,
      { reserve: jest.fn(), settle: jest.fn(), release: jest.fn(), resolveTenantKey: (o: string) => o } as never,
      { post: jest.fn() } as never,
      { sign: () => 'jwt' } as never,
      users,
      { get: () => 'http://agent' } as never,
    );
  });

  afterAll(async () => {
    for (const name of ['crm_contacts', 'customer_profiles', 'users']) {
      await connection.collection(name).deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    }
    await connection.close();
  });

  const asUser = (organizationId: string) => ({ sub: 'tester', email: 't@example.test', roles: ['owner'], organizationId });

  const seedRep = async (organizationId: string, name = 'Dana Rep') =>
    (
      await connection.collection('users').insertOne({
        organizationId,
        name,
        email: `${name.toLowerCase().replace(/\s+/g, '.')}.${Date.now()}@example.test`,
        passwordHash: 'x',
        roles: ['manager'],
        active: true,
      })
    ).insertedId.toString();

  it('creates a real customer: a crm_contacts record the rest of the app already understands', async () => {
    const result = await service.createCustomer(asUser(org), { name: 'Jane Doe', company: 'Acme Co', email: 'jane@acme.test', phone: '+1 555 0100 0001' });
    expect(result.duplicate).toBeUndefined();
    expect(result.created?.name).toBe('Jane Doe');
    expect(result.created?.company).toBe('Acme Co');
    expect(result.created?.archived).toBe(false);

    const contact = await connection.collection('crm_contacts').findOne({ organizationId: org, email: 'jane@acme.test' });
    expect(contact).toBeTruthy();
    expect(contact?.name).toBe('Jane Doe');
  });

  it('finds a duplicate by email and returns the existing customer instead of creating a second one', async () => {
    const first = await service.createCustomer(asUser(org), { name: 'John Smith', email: 'john@beta.test' });
    expect(first.created).toBeTruthy();

    const attempt = await service.createCustomer(asUser(org), { name: 'J. Smith', email: 'JOHN@beta.test' });
    expect(attempt.created).toBeUndefined();
    expect(attempt.duplicate?.id).toBe(first.created!.id);

    const count = await connection.collection('crm_contacts').countDocuments({ organizationId: org, email: { $in: ['john@beta.test', 'JOHN@beta.test'] } });
    expect(count).toBe(1);
  });

  it('confirmDuplicate:true proceeds with creation instead of being blocked', async () => {
    await service.createCustomer(asUser(org), { name: 'Pat Lee', phone: '+1 555 0200 0002' });
    // Same phone really is the same identity everywhere else in the app (deals, quotes, invoices all
    // merge on it too) — confirmDuplicate means "don't block me", not "pretend this isn't the same
    // person." Both records correctly land under the one customer; what it guarantees is that the
    // second crm_contacts record actually gets written instead of the request being short-circuited.
    const second = await service.createCustomer(asUser(org), { name: 'Pat Lee (2)', phone: '+1 555 0200 0002', confirmDuplicate: true });
    expect(second.created).toBeTruthy();
    expect(second.duplicate).toBeUndefined();
    const count = await connection.collection('crm_contacts').countDocuments({ organizationId: org, phone: '+1 555 0200 0002' });
    expect(count).toBe(2);
  });

  it('a duplicate check by company alone only matches when the candidate has neither email nor phone (same rule as the clusterer)', async () => {
    await service.createCustomer(asUser(org), { name: 'Rae Kim', company: 'Widget Factory', email: 'rae@widget.test' });
    // Someone else at Widget Factory, with their own email — not a duplicate (two people, one company).
    const other = await service.createCustomer(asUser(org), { name: 'Sam Widget', company: 'Widget Factory', email: 'sam@widget.test' });
    expect(other.created).toBeTruthy();
    expect(other.duplicate).toBeUndefined();
  });

  it('edits a customer\'s name/email/phone without changing which records belong to it', async () => {
    const created = (await service.createCustomer(asUser(org), { name: 'Kim Ortiz', email: 'kim@ortiz.test' })).created!;
    const updated = await service.updateCustomer(org, created.id, { name: 'Kimberly Ortiz', phone: '+1 555 0300 0003' });
    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('Kimberly Ortiz');
    expect(updated.phone).toBe('+1 555 0300 0003');
    expect(updated.email).toBe('kim@ortiz.test');
  });

  it('assigns and clears a customer rep, validated against real org users', async () => {
    const repId = await seedRep(org, 'Dana Rep');
    const created = (await service.createCustomer(asUser(org), { name: 'Lee Park', email: 'lee@park.test' })).created!;

    const assigned = await service.updateCustomer(org, created.id, { repUserId: repId });
    expect(assigned.repUserId).toBe(repId);
    expect(assigned.repName).toBe('Dana Rep');

    const cleared = await service.updateCustomer(org, created.id, { repUserId: '' });
    expect(cleared.repUserId).toBeUndefined();
  });

  it('rejects a rep that does not belong to this organization', async () => {
    const otherOrg = `${org}-other`;
    const foreignRepId = await seedRep(otherOrg, 'Outsider');
    const created = (await service.createCustomer(asUser(org), { name: 'Robin Vance', email: 'robin@vance.test' })).created!;
    await expect(service.updateCustomer(org, created.id, { repUserId: foreignRepId })).rejects.toThrow(BadRequestException);
  });

  it('archives and restores a customer — archived drops out of the default list but stays reachable by id', async () => {
    const created = (await service.createCustomer(asUser(org), { name: 'Archive Me', email: 'archive@me.test' })).created!;
    await service.setArchived(org, created.id, true);

    const defaultList = await service.list(org, {});
    expect(defaultList.items.some((c) => c.id === created.id)).toBe(false);

    const withArchived = await service.list(org, { includeArchived: 'true' });
    expect(withArchived.items.some((c) => c.id === created.id)).toBe(true);

    const stillReachable = await service.detail(org, created.id);
    expect(stillReachable.archived).toBe(true);

    await service.setArchived(org, created.id, false);
    const restored = await service.list(org, {});
    expect(restored.items.some((c) => c.id === created.id)).toBe(true);
  });

  it('adds and removes additional contacts on a customer', async () => {
    const created = (await service.createCustomer(asUser(org), { name: 'Primary Contact', email: 'primary@multi.test' })).created!;
    const withContact = await service.addContact(org, created.id, { name: 'Second Person', email: 'second@multi.test', role: 'Billing' });
    const detail = await service.detail(org, created.id);
    const added = detail.people.find((p) => p.email === 'second@multi.test');
    expect(added).toBeTruthy();
    expect(added?.manual).toBe(true);
    expect(added?.role).toBe('Billing');

    expect(withContact.id).toBe(created.id);
    await service.removeContact(org, created.id, added!.id!);
    const after = await service.detail(org, created.id);
    expect(after.people.some((p) => p.email === 'second@multi.test')).toBe(false);
  });

  it('organization isolation: a customer created in one org is invisible to another', async () => {
    const otherOrg = `${org}-iso`;
    const created = (await service.createCustomer(asUser(org), { name: 'Isolated', email: 'isolated@scope.test' })).created!;
    await expect(service.detail(otherOrg, created.id)).rejects.toThrow();
    const otherList = await service.list(otherOrg, {});
    expect(otherList.items.some((c) => c.id === created.id)).toBe(false);
  });
});
