import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection } from 'mongoose';
import { CustomerDirectoryService } from './customer-directory.service';
import { CustomerMailService } from './customer-mail.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';

const PREFIX = `jest-payrec-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

// Against a real Mongo, end to end: CRM quote ("Hoops") + Square transactions + recorded payments → the Customers
// directory and the quote's stored reconciliation (what the SalesBoard reads) → one answer.
describe('Universal quote payment reconciliation (real Mongo)', () => {
  let connection: Connection;
  let directory: CustomerDirectoryService;
  let reconciliation: PaymentReconciliationService;
  const squareHistory = { count: 3, invoiceLinked: 2, withoutInvoice: 1, failed: 0 };
  const squareReconciliation = { reconcileOrganization: jest.fn().mockResolvedValue({ count: 0 }), initialSync: jest.fn().mockResolvedValue(squareHistory) };
  let squareConnectedOrgs: string[] = [];
  const integrations = { listConnectedOrganizationIds: jest.fn(async () => squareConnectedOrgs) };
  const invoicesByOrder = new Map<string, { id?: string; number?: string; title?: string }>();
  const squareApi = { listInvoiceRefsByOrder: jest.fn(async () => invoicesByOrder) };
  const chat = { emitToOrg: jest.fn() };
  let seq = 0;
  let dealSeq = 0;
  let org: string;
  let hoops: string;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({ imports: [MongooseModule.forRoot(uri)] }).compile();
    connection = moduleRef.get(getConnectionToken());
  });

  beforeEach(async () => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    squareConnectedOrgs = [];
    invoicesByOrder.clear();
    jest.clearAllMocks();
    directory = new CustomerDirectoryService(
      connection,
      new CustomerMailService(connection),
      { syncNow: jest.fn() } as never,
      { reserve: jest.fn(), settle: jest.fn(), release: jest.fn(), resolveTenantKey: (o: string) => o } as never,
      { post: jest.fn() } as never,
      { sign: () => 'jwt' } as never,
      { findAll: async () => [] } as never,
      { get: () => 'http://agent' } as never,
      squareReconciliation as never,
    );
    reconciliation = new PaymentReconciliationService(connection, directory, squareReconciliation as never, integrations as never, undefined, squareApi as never, chat as never);
    hoops = (await connection.collection('crm_data_sources').insertOne({ organizationId: org, key: 'hoops', provider: 'hoops', label: 'Hoops', status: 'connected' })).insertedId.toString();
  });

  afterAll(async () => {
    for (const name of ['crm_quotes', 'crm_deals', 'crm_quote_payments', 'square_payment_transactions', 'crm_data_sources', 'integration_credentials']) {
      await connection.collection(name).deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    }
    await connection.close();
  });

  const quote = async (organizationId: string, number: string, email: string, fields: Record<string, unknown> = {}, dealStatus?: string) => {
    const deal = (
      await connection.collection('crm_deals').insertOne({
        organizationId, dataSourceId: hoops, externalId: `d${number}-${++dealSeq}`, name: `Deal ${number}`, dealStatus: 'won', monetaryValue: 1000, createdAt: daysAgo(30),
        lastActivityAt: daysAgo(20), ...(dealStatus ? { sourceData: { status: dealStatus } } : {}),
      })
    ).insertedId.toString();
    return (
      await connection.collection('crm_quotes').insertOne({
        organizationId, dataSourceId: hoops, dealId: deal, quoteNumber: number, quoteName: `Quote ${number}`, quoteAmount: 1000, currency: 'AUD', quoteStatus: 'published',
        clientApprovalStatus: 'approved', paidAmount: 0, clientDetails: { email, companyName: `Co ${number}`, contactName: 'Pat' }, createdAt: daysAgo(30), ...fields,
      })
    ).insertedId.toString();
  };
  const square = (organizationId: string, id: string, fields: Record<string, unknown>) =>
    connection.collection('square_payment_transactions').insertOne({
      organizationId, provider: 'square', providerPaymentId: id, currency: 'AUD', amount: 100000, paymentStatus: 'completed', paymentDate: daysAgo(2), refundedAmount: 0, paymentMethodType: 'CARD', ...fields,
    });
  const stored = async (organizationId: string, id: string) => {
    const { ObjectId } = await import('mongodb');
    return (await connection.collection('crm_quotes').findOne({ _id: new ObjectId(id), organizationId }))?.paymentReconciliation as Record<string, any> | undefined;
  };
  const customerRow = async (organizationId: string, name: string) => (await directory.list(organizationId, {})).items.find((c) => c.name.includes(name) || c.company?.includes(name));

  it('Hoops says Not Paid, Square has the completed payment for quote 4550 → Haive says PAID on the Customers page AND the SalesBoard', async () => {
    const q = await quote(org, '4550', 'pat@a.example', { paymentStatus: 'Not Paid' }, 'Not Paid');
    await square(org, 'sq_4550', { matchedEmailKey: 'pat@a.example', details: { squareInvoiceNumber: '4550 - Surry Hills', squareInvoiceTitle: '4550 - Surry Hills', squareInvoiceId: 'inv1' } });

    const report = await reconciliation.reconcileOrganization(org);
    expect(report).toMatchObject({ quotesScanned: 1, quotesUpdated: 1, paidQuotes: 1, paymentsScanned: 1, paymentsLinkedToQuote: 1, paymentsLinkedToInvoice: 1, paymentsNotTiedToAQuote: 0, crmOutdatedQuotes: 1, customersAffected: 1, failures: [] });

    // SalesBoard (stored on the quote) …
    expect(await stored(org, q)).toMatchObject({ status: 'paid', paidAmount: 1000, outstandingAmount: 0, basis: 'verified', crmOutdated: true, sources: [{ name: 'Square', verified: true }] });
    // … and the Customers page agree.
    const row = await customerRow(org, '4550');
    expect(row?.payment).toMatchObject({ status: 'paid' });
    expect(row?.paymentSources).toEqual([{ name: 'Square', verified: true }]);
    const detail = await directory.detail(org, row!.id);
    expect(detail.quotePayments[q]).toMatchObject({ status: 'paid', paidAmount: 1000, crmOutdated: true });
    // the manual label and the quote's paid total were NOT touched
    const raw = await connection.collection('crm_quotes').findOne({ organizationId: org });
    expect(raw).toMatchObject({ paymentStatus: 'Not Paid', paidAmount: 0 });
  });

  it('is idempotent: a second run writes nothing, and nothing is double counted', async () => {
    const q = await quote(org, '4550', 'pat@a.example');
    await square(org, 'sq_4550', { matchedEmailKey: 'pat@a.example', transactionReference: '4550' });
    await reconciliation.reconcileOrganization(org);
    const first = await stored(org, q);
    const again = await reconciliation.reconcileOrganization(org);
    expect(again.quotesUpdated).toBe(0);
    expect((await stored(org, q))?.reconciledAt).toEqual(first?.reconciledAt);
    expect((await stored(org, q))?.paidAmount).toBe(1000);
  });

  it('a dry run reports but writes nothing', async () => {
    const q = await quote(org, '4550', 'pat@a.example');
    await square(org, 'sq_4550', { matchedEmailKey: 'pat@a.example', transactionReference: '4550' });
    const report = await reconciliation.reconcileOrganization(org, { dryRun: true });
    expect(report).toMatchObject({ dryRun: true, paidQuotes: 1, quotesUpdated: 0 });
    expect(await stored(org, q)).toBeUndefined();
  });

  it('partially paid, unpaid and refunded quotes are each reported correctly; unpaid stays unpaid', async () => {
    const part = await quote(org, '4601', 'a@x.example');
    const none = await quote(org, '4602', 'b@x.example', {}, 'Not Paid');
    const refunded = await quote(org, '4603', 'c@x.example');
    await square(org, 'p1', { matchedEmailKey: 'a@x.example', transactionReference: '4601', amount: 25000 });
    await square(org, 'p3', { matchedEmailKey: 'c@x.example', transactionReference: '4603', paymentStatus: 'refunded', refundedAmount: 100000 });
    const report = await reconciliation.reconcileOrganization(org);
    expect(report).toMatchObject({ partiallyPaidQuotes: 1, paidQuotes: 0, unpaidQuotes: 2 });
    expect(await stored(org, part)).toMatchObject({ status: 'partially_paid', paidAmount: 250, outstandingAmount: 750 });
    expect(await stored(org, none)).toMatchObject({ status: 'unpaid', paidAmount: 0 });
    expect(await stored(org, refunded)).toMatchObject({ status: 'unpaid' });
  });

  it('a verified payment with no email/phone is still tied to its quote by the exact quote number', async () => {
    const q = await quote(org, '4550', 'pat@a.example');
    await square(org, 'sq_anon', { details: { squareInvoiceNumber: '4550 - X' } }); // no matched identity
    const report = await reconciliation.reconcileOrganization(org);
    expect(report).toMatchObject({ paidQuotes: 1, paymentsLinkedToQuote: 1 });
    expect(await stored(org, q)).toMatchObject({ status: 'paid' });
  });

  it('never matches by amount alone: an unreferenced payment of exactly the quote amount stays unmatched', async () => {
    const q = await quote(org, '4550', 'pat@a.example');
    await square(org, 'sq_noref', { matchedEmailKey: 'pat@a.example', amount: 100000 });
    const report = await reconciliation.reconcileOrganization(org);
    expect(report).toMatchObject({ paidQuotes: 0, paymentsLinkedToQuote: 0, paymentsNotTiedToAQuote: 1 });
    expect(await stored(org, q)).toMatchObject({ status: 'unpaid' });
  });

  it('wrong customer: a payment of ANOTHER customer that names quote 4550 never pays it', async () => {
    const q = await quote(org, '4550', 'pat@a.example');
    await quote(org, '4999', 'other@b.example');
    await square(org, 'sq_wrong', { matchedEmailKey: 'other@b.example', transactionReference: '4550' });
    await reconciliation.reconcileOrganization(org);
    expect(await stored(org, q)).toMatchObject({ status: 'unpaid', paidAmount: 0 });
  });

  it('a quote number shared by two quotes in one organization is ambiguous: no payment is guessed onto either', async () => {
    const a = await quote(org, '4550', 'x@a.example');
    const b = await quote(org, '4550', 'y@a.example');
    await square(org, 'sq_dup', { details: { squareInvoiceNumber: '4550 - X' } });
    await reconciliation.reconcileOrganization(org);
    expect((await stored(org, a))?.status).toBe('unpaid');
    expect((await stored(org, b))?.status).toBe('unpaid');
  });

  it('organization isolation: the same quote number and email in another organization is never touched', async () => {
    const other = `${PREFIX}-other-${seq}`;
    const mine = await quote(org, '4550', 'pat@a.example');
    const theirs = await quote(other, '4550', 'pat@a.example');
    await square(org, 'sq_mine', { matchedEmailKey: 'pat@a.example', transactionReference: '4550' });
    await reconciliation.reconcileOrganization(org);
    expect(await stored(org, mine)).toMatchObject({ status: 'paid' });
    expect(await stored(other, theirs)).toBeUndefined();
    const raw = await connection.collection('crm_quotes').findOne({ organizationId: other });
    expect(raw?.paymentReconciliation).toBeUndefined();
  });

  it('Hoops says Paid but there is no transaction → Paid is preserved as reported (unverified), not shown as verified', async () => {
    const q = await quote(org, '4701', 'r@a.example', { paymentStatus: 'Paid' });
    await reconciliation.reconcileOrganization(org);
    expect(await stored(org, q)).toMatchObject({ status: 'paid', basis: 'reported', verifiedPaid: 0, crmUnverified: true, sources: [{ name: 'Hoops', verified: false }] });
  });

  it('Hoops 50% Paid + a Square payment of the remaining 50% made after Hoops last changed → PAID', async () => {
    const q = await quote(org, '4702', 'h@a.example', { paymentStatus: '50% Paid' });
    await square(org, 'sq_half', { matchedEmailKey: 'h@a.example', transactionReference: '4702', amount: 50000, paymentDate: daysAgo(2) });
    await reconciliation.reconcileOrganization(org);
    expect(await stored(org, q)).toMatchObject({ status: 'paid', paidAmount: 1000, basis: 'mixed' });
  });

  it('a recorded remittance payment is counted and named Remittance (not Square)', async () => {
    const q = await quote(org, '4703', 'm@a.example', { paidAmount: 1000 });
    await connection.collection('crm_quote_payments').insertOne({ organizationId: org, quoteId: q, amount: 1000, paymentDate: daysAgo(5), paymentMethod: 'Remittance', voided: false });
    await reconciliation.reconcileOrganization(org);
    expect(await stored(org, q)).toMatchObject({ status: 'paid', basis: 'verified', sources: [{ name: 'Remittance', verified: true }] });
  });

  it('the same money in Hoops (recorded) and Square is counted once; a genuine second payment adds', async () => {
    const q = await quote(org, '4704', 'd@a.example', { paidAmount: 400 });
    await connection.collection('crm_quote_payments').insertOne({ organizationId: org, quoteId: q, amount: 400, paymentDate: daysAgo(2), voided: false, reference: 'sq_d1' });
    await square(org, 'sq_d1', { matchedEmailKey: 'd@a.example', transactionReference: '4704', amount: 40000 });
    await reconciliation.reconcileOrganization(org);
    expect(await stored(org, q)).toMatchObject({ status: 'partially_paid', paidAmount: 400 });
    await square(org, 'sq_d2', { matchedEmailKey: 'd@a.example', transactionReference: '4704', amount: 60000, paymentDate: daysAgo(1) });
    await reconciliation.reconcileOrganization(org);
    expect(await stored(org, q)).toMatchObject({ status: 'paid', paidAmount: 1000 });
  });

  it('a different currency is never combined into the quote', async () => {
    const q = await quote(org, '4705', 'c@a.example');
    await square(org, 'sq_usd', { matchedEmailKey: 'c@a.example', transactionReference: '4705', currency: 'USD' });
    await reconciliation.reconcileOrganization(org);
    expect(await stored(org, q)).toMatchObject({ status: 'unpaid' });
  });

  it('a Customers row reads Overpaid when payments exceed the quote', async () => {
    await quote(org, '4706', 'o@a.example');
    await square(org, 'sq_over', { matchedEmailKey: 'o@a.example', transactionReference: '4706', amount: 120000 });
    const row = await customerRow(org, '4706');
    expect(row?.payment).toMatchObject({ status: 'overpaid' }); // the Payment column itself reads OVERPAID
    const detail = await directory.detail(org, row!.id);
    expect(Object.values(detail.quotePayments)[0]).toMatchObject({ status: 'overpaid' });
  });

  it('a refund event re-derives the status (a later refund lowers a Paid quote)', async () => {
    const q = await quote(org, '4707', 'f@a.example');
    await square(org, 'sq_ref', { matchedEmailKey: 'f@a.example', transactionReference: '4707' });
    await reconciliation.reconcileOrganization(org);
    expect(await stored(org, q)).toMatchObject({ status: 'paid' });
    await connection.collection('square_payment_transactions').updateOne({ organizationId: org, providerPaymentId: 'sq_ref' }, { $set: { paymentStatus: 'partially_refunded', refundedAmount: 40000 } });
    await reconciliation.reconcileOrganization(org);
    expect(await stored(org, q)).toMatchObject({ status: 'partially_paid', paidAmount: 600, refundedAmount: 400 });
  });

  it('historical reconciliation: reads Square history only for an organization with Square connected, then reconciles, and reports failures', async () => {
    await quote(org, '4708', 'g@a.example');
    await square(org, 'sq_hist', { matchedEmailKey: 'g@a.example', transactionReference: '4708' });
    const notConnected = await reconciliation.reconcileHistory(org);
    expect(squareReconciliation.initialSync).not.toHaveBeenCalled();
    expect(notConnected.square).toBeUndefined();

    squareConnectedOrgs = [org];
    const connected = await reconciliation.reconcileHistory(org);
    expect(squareReconciliation.initialSync).toHaveBeenCalledWith(org);
    expect(connected.square).toEqual(squareHistory);
    expect(connected).toMatchObject({ paidQuotes: 1, failures: [] });

    squareReconciliation.initialSync.mockRejectedValueOnce(new Error('square down'));
    const failed = await reconciliation.reconcileHistory(org);
    expect(failed.failures).toEqual([{ stage: 'square-history', error: 'square down' }]);
    expect(failed.paidQuotes).toBe(1);
  });

  it('ROOT CAUSE: payments stored without their Square invoice reference are linked automatically (invoice read once, matched on order id) → Gateway AND Payment columns agree', async () => {
    squareConnectedOrgs = [org];
    const q = await quote(org, '4550', 'luke@a.example', { quoteAmount: 112.2 });
    await square(org, 'sq_luke', { matchedEmailKey: 'luke@a.example', amount: 11220, orderReference: 'order-luke' }); // no details / invoice reference
    invoicesByOrder.set('order-luke', { id: 'inv-luke', number: '4550', title: '4550 - Luke' });

    const before = await customerRow(org, '4550');
    expect(before?.gatewayPaymentSummary).toMatchObject({ status: 'paid', transactionCount: 1 });
    expect(before?.payment.status).not.toBe('paid'); // the bug: Gateway says Paid, Payment cannot link

    directory.invalidate(org);
    const report = await reconciliation.reconcileOrganization(org);
    expect(report).toMatchObject({ paidQuotes: 1, failures: [] });
    expect(chat.emitToOrg).toHaveBeenCalledWith(org, 'gateway-payment-updated', expect.anything());
    const after = await customerRow(org, '4550');
    expect(after?.payment).toMatchObject({ status: 'paid' });
    expect(after?.gatewayPaymentSummary.status).toBe('paid');
    expect(await stored(org, q)).toMatchObject({ status: 'paid', paidAmount: 112.2 });
  });

  it('the invoice lookup never links by amount: an order with no invoice stays unlinked (and is not re-read within a day)', async () => {
    squareConnectedOrgs = [org];
    const q = await quote(org, '4550', 'luke@a.example', { quoteAmount: 112.2 });
    await square(org, 'sq_x', { matchedEmailKey: 'luke@a.example', amount: 11220, orderReference: 'order-none' });
    await reconciliation.reconcileOrganization(org);
    expect(await stored(org, q)).toMatchObject({ status: 'unpaid' });
    await reconciliation.reconcileOrganization(org);
    expect(squareApi.listInvoiceRefsByOrder).toHaveBeenCalledTimes(1);
  });

  it('an invoice for another organization order is never applied (backfill only touches this organization rows)', async () => {
    squareConnectedOrgs = [org];
    const other = `${PREFIX}-other2-${seq}`;
    await quote(org, '4550', 'luke@a.example');
    await square(other, 'sq_other', { matchedEmailKey: 'luke@a.example', orderReference: 'order-shared' });
    invoicesByOrder.set('order-shared', { number: '4550' });
    await reconciliation.reconcileOrganization(org);
    const row = await connection.collection('square_payment_transactions').findOne({ organizationId: other });
    expect(row?.details).toBeUndefined();
  });

  it('a change signal invalidates the cached Customers directory so the very next read is fresh', async () => {
    await quote(org, '4550', 'luke@a.example');
    expect((await customerRow(org, '4550'))?.gatewayPaymentSummary.transactionCount).toBe(0); // cached
    await square(org, 'sq_new', { matchedEmailKey: 'luke@a.example', transactionReference: '4550' });
    expect((await customerRow(org, '4550'))?.gatewayPaymentSummary.transactionCount).toBe(0); // still the cache
    (reconciliation as any).schedule(org);
    expect((await customerRow(org, '4550'))?.payment).toMatchObject({ status: 'paid' });
  });

  it('a duplicate webhook delivery (same payment id twice) is not double counted', async () => {
    const q = await quote(org, '4550', 'luke@a.example', { quoteAmount: 500 });
    await square(org, 'sq_dupe', { matchedEmailKey: 'luke@a.example', transactionReference: '4550', amount: 30000 });
    await connection.collection('square_payment_transactions').updateOne({ organizationId: org, providerPaymentId: 'sq_dupe' }, { $set: { amount: 30000 } }, { upsert: true });
    await reconciliation.reconcileOrganization(org);
    expect(await stored(org, q)).toMatchObject({ status: 'partially_paid', paidAmount: 300 });
  });
});
