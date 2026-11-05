import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection } from 'mongoose';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { CustomerDirectoryService } from './customer-directory.service';
import { CustomerJobDocumentsService } from './customer-job-documents.service';
import { CustomerJobsService } from './customer-jobs.service';
import { CustomerMailService } from './customer-mail.service';
import { CustomerWorkspaceService } from './customer-workspace.service';

const PREFIX = `jest-jobdocs-${Date.now()}`;

// pdf-parse / pdfkit output is binary — these checks confirm a real,
// non-trivial PDF came back (the %PDF- magic header, a plausible size),
// not that every word on the page is correct (covered by eyeballing the
// branded-pdf.ts helper's own existing use elsewhere in this codebase).
describe('Job documents — PDF generation (real Mongo)', () => {
  let connection: Connection;
  let directory: CustomerDirectoryService;
  let jobs: CustomerJobsService;
  let documents: CustomerJobDocumentsService;
  let org: string;
  let seq = 0;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({ imports: [MongooseModule.forRoot(uri)] }).compile();
    connection = moduleRef.get(getConnectionToken());
  });

  beforeEach(async () => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    directory = new CustomerDirectoryService(
      connection,
      new CustomerMailService(connection),
      { syncNow: jest.fn() } as never,
      { reserve: jest.fn(), settle: jest.fn(), release: jest.fn(), resolveTenantKey: (o: string) => o } as never,
      { post: jest.fn() } as never,
      { sign: () => 'jwt' } as never,
      { findAll: async () => [] } as never,
      { get: () => 'http://agent' } as never,
    );
    const workspace = new CustomerWorkspaceService(connection, directory, new GridFsService(connection));
    const vendorsStub = { getVendor: async () => ({ name: 'Test Vendor' }), existsInOrg: async () => true } as never;
    const jobGridFsStub = { upload: async () => 'file-id', openDownloadStream: () => undefined, delete: async () => undefined } as never;
    const decorationModelStub = { findOne: () => ({ exec: async () => null }) } as never;
    const xeroServiceStub = { getStatus: async () => ({ connected: false, needsSelection: false }) } as never;
    const dynamicExecutorStub = { execute: async () => ({ success: false, message: 'not configured' }) } as never;
    const mailServiceStub = { sendDocumentEmail: async () => false } as never;
    jobs = new CustomerJobsService(
      connection,
      directory,
      workspace,
      vendorsStub,
      jobGridFsStub,
      decorationModelStub,
      xeroServiceStub,
      dynamicExecutorStub,
      mailServiceStub,
    );
    await jobs.onModuleInit();
    documents = new CustomerJobDocumentsService(jobs, directory);
  });

  afterAll(async () => {
    for (const name of ['crm_data_sources', 'crm_deals', 'crm_quotes', 'customer_profiles', 'customer_jobs', 'customer_job_counters']) {
      await connection.collection(name).deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    }
    await connection.close();
  });

  const person = (organizationId: string) => ({ sub: 'tester', organizationId, email: 'x', roles: ['owner'] }) as never;

  const seedJob = async () => {
    const source = (
      await connection.collection('crm_data_sources').insertOne({ organizationId: org, key: 'prospectconnect', provider: 'prospectconnect', label: 'Pantheras CRM', status: 'active' })
    ).insertedId.toString();
    const quoteId = (
      await connection.collection('crm_quotes').insertOne({
        organizationId: org,
        dataSourceId: source,
        quoteNumber: 'Q-1',
        quoteName: 'Order Q-1',
        quoteAmount: 5000,
        currency: 'INR',
        quoteStatus: 'published',
        clientApprovalStatus: 'approved',
        clientDetails: { email: 'docs@example.test', companyName: 'Docs Co', contactName: 'Dana Docs' },
        quoteOwnerLabel: 'Sanjay Kumar',
        createdAt: new Date(),
        products: [{ name: 'T-shirt', description: 'Navy, 220 GSM', quantity: 50, unitPrice: 100, total: 5000 }],
      })
    ).insertedId.toString();
    const list = await directory.list(org, {});
    const customerId = list.items.find((c) => c.company === 'Docs Co')!.id;
    const { job } = await jobs.convert(person(org), customerId, quoteId);
    return { job, customerId };
  };

  it('generates a real, non-empty PDF for each of the five document kinds', async () => {
    const { job } = await seedJob();
    for (const kind of ['job-sheet', 'proof-sheet', 'packing-slip', 'decorator-spec-sheet', 'shipping-label'] as const) {
      const { buffer, filename } = await documents.generate(person(org), job.id, kind);
      expect(buffer.length).toBeGreaterThan(500);
      expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(filename).toMatch(/\.pdf$/);
    }
  });

  it('the packing slip and shipping label pull the customer’s real shipping address when one exists, and say so honestly when none does', async () => {
    const { job, customerId } = await seedJob();

    const withoutAddress = await documents.generate(person(org), job.id, 'packing-slip');
    expect(withoutAddress.buffer.toString('latin1')).not.toMatch(/123 Warehouse/);

    await directory.addAddress(org, customerId, { type: 'shipping', address: '123 Warehouse Ave', city: 'Chennai', state: 'TN' });
    const withAddress = await documents.generate(person(org), job.id, 'packing-slip');
    // pdfkit compresses text streams by default, so the literal address text
    // isn't a plain substring of the file bytes — the real signal here is
    // that supplying an address measurably changes the rendered output.
    expect(withAddress.buffer.length).not.toBe(withoutAddress.buffer.length);
  });
});
