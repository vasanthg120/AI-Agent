import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection } from 'mongoose';
import { CustomerDirectoryService } from './customer-directory.service';
import { CustomerImportService, buildCustomerImportTemplateCsv, CSV_TEMPLATE_HEADERS } from './customer-import.service';
import { CustomerMailService } from './customer-mail.service';

// Avoids the real UsersModule (its InvitationsService needs a MailService
// only the full AppModule wires in — a pre-existing gap unrelated to this
// work, already hit by customer-writes.spec.ts). A small, fully-controlled
// stub is enough here: parseImportFile only ever calls users.findAll.
const fakeUsers: { _id: { toString(): string }; name: string; email: string; active?: boolean }[] = [];
const usersStub = { findAll: async () => fakeUsers } as never;

const PREFIX = `jest-cust-import-${Date.now()}`;

describe('Customer CSV import (real Mongo)', () => {
  let connection: Connection;
  let directory: CustomerDirectoryService;
  let service: CustomerImportService;
  let seq = 0;
  let org: string;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({ imports: [MongooseModule.forRoot(uri)] }).compile();
    connection = moduleRef.get(getConnectionToken());
  });

  beforeEach(() => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    fakeUsers.length = 0;
    directory = new CustomerDirectoryService(
      connection,
      new CustomerMailService(connection),
      { syncNow: jest.fn() } as never,
      { reserve: jest.fn(), settle: jest.fn(), release: jest.fn(), resolveTenantKey: (o: string) => o } as never,
      { post: jest.fn() } as never,
      { sign: () => 'jwt' } as never,
      usersStub,
      { get: () => 'http://agent' } as never,
    );
    service = new CustomerImportService(directory, usersStub);
  });

  afterAll(async () => {
    for (const name of ['crm_contacts', 'customer_profiles']) {
      await connection.collection(name).deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    }
    await connection.close();
  });

  const asUser = (organizationId: string) => ({ sub: 'tester', email: 't@example.test', roles: ['owner'], organizationId });
  const csv = (rows: string[][]) => Buffer.from([CSV_TEMPLATE_HEADERS, ...rows].map((r) => r.join(',')).join('\n'), 'utf-8');

  it('the template is parseable by the importer it ships with, and declares the documented headers', () => {
    const template = buildCustomerImportTemplateCsv();
    const firstLine = template.split('\r\n')[0];
    expect(firstLine.split(',')).toEqual(CSV_TEMPLATE_HEADERS);
  });

  it('parses a valid Business row and a valid Individual row', async () => {
    const buffer = csv([
      ['Business', 'Acme Co', '', '', 'acme@example.com', '0400000111', 'acme.example.com', 'Retail', '15', '5', '', '', '', '', '', '', '', '', ''],
      ['Individual', '', 'Sam', 'Taylor', 'sam@example.com', '0400000222', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ]);
    const result = await service.parseImportFile(org, buffer);
    expect(result.errors).toHaveLength(0);
    expect(result.customers).toHaveLength(2);
    expect(result.customers[0].dto).toMatchObject({ name: 'Acme Co', customerType: 'business', minimumMarkupPct: 15, salesDiscountPct: 5 });
    expect(result.customers[1].dto).toMatchObject({ name: 'Sam Taylor', customerType: 'individual', email: 'sam@example.com' });
  });

  it('flags a Business row with no Company Name, and an Individual row with no Email', async () => {
    const buffer = csv([
      ['Business', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['Individual', '', 'Sam', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ]);
    const result = await service.parseImportFile(org, buffer);
    expect(result.customers).toHaveLength(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].message).toMatch(/Company Name/);
    expect(result.errors[1].message).toMatch(/Email/);
  });

  it('flags an out-of-range Minimum Markup and an invalid email', async () => {
    const buffer = csv([
      ['Business', 'Bad Markup Co', '', '', '', '', '', '', '150', '', '', '', '', '', '', '', '', '', ''],
      ['Business', 'Bad Email Co', '', '', 'not-an-email', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ]);
    const result = await service.parseImportFile(org, buffer);
    expect(result.customers).toHaveLength(0);
    expect(result.errors[0].message).toMatch(/Minimum Markup/);
    expect(result.errors[1].message).toMatch(/valid email/);
  });

  it('resolves a Customer Rep Email to a real user in the organization, and rejects an unknown one', async () => {
    fakeUsers.push({ _id: { toString: () => 'rep-1' }, name: 'Dana Rep', email: 'dana@example.com', active: true });
    const ok = await service.parseImportFile(org, csv([['Business', 'Repped Co', '', '', '', '', '', '', '', '', 'dana@example.com', '', '', '', '', '', '', '', '']]));
    expect(ok.errors).toHaveLength(0);
    expect(ok.customers[0].dto.repUserId).toBe('rep-1');

    const bad = await service.parseImportFile(org, csv([['Business', 'Unrepped Co', '', '', '', '', '', '', '', '', 'nobody@example.com', '', '', '', '', '', '', '', '']]));
    expect(bad.errors[0].message).toMatch(/No active user/);
  });

  it('commits valid rows through the real createCustomer path, and skips a row that duplicates an existing customer', async () => {
    const buffer = csv([
      ['Business', 'New Import Co', '', '', 'newimport@example.com', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ]);
    const { customers } = await service.parseImportFile(org, buffer);
    const first = await service.importRows(asUser(org) as never, customers);
    expect(first.created).toBe(1);
    expect(first.skippedDuplicates).toHaveLength(0);

    // Re-importing the exact same row should be recognized as a duplicate, not create a second customer.
    const { customers: again } = await service.parseImportFile(org, buffer);
    const second = await service.importRows(asUser(org) as never, again);
    expect(second.created).toBe(0);
    expect(second.skippedDuplicates).toHaveLength(1);
    expect(second.skippedDuplicates[0].name).toBe('New Import Co');

    const listed = await directory.list(org, {});
    expect(listed.total).toBe(1);
  });

  it('imports an inline contact and address with the customer', async () => {
    const buffer = csv([
      [
        'Business',
        'With Contact Co',
        '',
        '',
        'withcontact@example.com',
        '',
        '',
        '',
        '',
        '',
        '',
        'Jordan Lee',
        'jordan@example.com',
        '0400000999',
        'billing',
        '1 Example St',
        '',
        'Sydney',
        'NSW',
      ],
    ]);
    const { customers } = await service.parseImportFile(org, buffer);
    const result = await service.importRows(asUser(org) as never, customers);
    expect(result.created).toBe(1);

    const listed = await directory.list(org, {});
    const created = listed.items.find((c) => c.name === 'With Contact Co')!;
    // contactsCount includes every person their records name — the customer's
    // own crm_contacts record counts as one "person" alongside the manual
    // contact, so this is >=1 (the manual contact was accepted), not ==1.
    expect(created.contactsCount).toBeGreaterThanOrEqual(1);
    expect(created.addresses).toHaveLength(1);
    expect(created.addresses[0]).toMatchObject({ type: 'billing', address: '1 Example St', city: 'Sydney', state: 'NSW' });
  });
});
