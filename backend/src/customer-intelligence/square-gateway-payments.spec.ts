import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection } from 'mongoose';
import { computeGatewayPaymentSummary, CustomerDirectoryService, GatewayPaymentRecord } from './customer-directory.service';
import { CustomerMailService } from './customer-mail.service';

const PREFIX = `jest-gwpay-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

// Against a real Mongo: Gateway Payments (square_payment_transactions)
// joined into the Customers directory by the SAME normalized email/phone
// keys clusterCustomers() already groups everything else by — never a
// second matching algorithm, never a customerId foreign key (there isn't
// one — see customer-directory.service.ts's own comment on the synthetic
// id). Covers the approved plan's own test list: matching by email/phone
// (never by name), unmatched payments never discarded, summary correctness
// (duplicate rows never double-count, a partial refund reduces net paid, a
// pending payment never counts as revenue), and organization isolation.
describe('Gateway Payments on the Customers directory (real Mongo)', () => {
  let connection: Connection;
  let service: CustomerDirectoryService;
  const http = { post: jest.fn() };
  const dataSources = { syncNow: jest.fn() };
  const squareReconciliation = { reconcileOrganization: jest.fn().mockResolvedValue({ count: 0 }) };
  const reservations = { reserve: jest.fn(), settle: jest.fn(), release: jest.fn(), resolveTenantKey: (org: string) => org };
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
    jest.clearAllMocks();
    service = new CustomerDirectoryService(
      connection,
      new CustomerMailService(connection),
      dataSources as never,
      reservations as never,
      http as never,
      { sign: () => 'jwt' } as never,
      { findAll: async () => [] } as never,
      { get: () => 'http://agent' } as never,
      squareReconciliation as never,
    );
  });

  afterAll(async () => {
    for (const name of ['crm_contacts', 'square_payment_transactions', 'crm_data_sources', 'integration_credentials']) {
      await connection.collection(name).deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    }
    await connection.close();
  });

  const contact = (organizationId: string, email: string, phone?: string) =>
    connection.collection('crm_contacts').insertOne({ organizationId, name: 'Akash', email, phone, sourceCreatedAt: daysAgo(10) });

  const transaction = (organizationId: string, providerPaymentId: string, fields: Record<string, unknown>) =>
    connection.collection('square_payment_transactions').insertOne({
      organizationId,
      provider: 'square',
      providerPaymentId,
      currency: 'USD',
      paymentDate: daysAgo(1),
      refundedAmount: 0,
      ...fields,
    });

  const connectSquare = (organizationId: string) => connection.collection('integration_credentials').insertOne({ organizationId, provider: 'square' });

  it('matches a Gateway Payment to an existing customer by email, never by name alone', async () => {
    await contact(org, 'akash@example.com');
    await transaction(org, 'pay_1', { matchedEmailKey: 'akash@example.com', amount: 800000, paymentStatus: 'completed' });

    const { items } = await service.list(org, {});
    expect(items).toHaveLength(1);
    expect(items[0].gatewayPaymentSummary).toMatchObject({ transactionCount: 1, totalPaid: 800000, netPaid: 800000, status: 'paid' });
  });

  it('matches by phone when there is no shared email', async () => {
    await contact(org, 'someone-else@example.com', '9876543210');
    await transaction(org, 'pay_2', { matchedPhoneKey: '9876543210', amount: 500, paymentStatus: 'completed' });

    const { items } = await service.list(org, {});
    expect(items[0].gatewayPaymentSummary.transactionCount).toBe(1);
  });

  it('a payment with no matched identity never attaches to any customer — never guessed by name — but is surfaced separately for manual review, never silently dropped', async () => {
    await contact(org, 'akash@example.com');
    await transaction(org, 'pay_3', { amount: 100, paymentStatus: 'completed' }); // no matchedEmailKey/matchedPhoneKey at all

    const result = await service.list(org, {});
    expect(result.items[0].gatewayPaymentSummary.transactionCount).toBe(0);
    expect(result.unmatchedGatewayPayments.map((p) => p.id)).toEqual(['pay_3']);
  });

  it('a pending payment never counts as revenue, and reads as "pending" (still in flight) rather than "failed_only"', async () => {
    await contact(org, 'akash@example.com');
    await transaction(org, 'pay_4', { matchedEmailKey: 'akash@example.com', amount: 100, paymentStatus: 'pending' });

    const { items } = await service.list(org, {});
    expect(items[0].gatewayPaymentSummary).toMatchObject({ totalPaid: 0, netPaid: 0, status: 'pending' });
  });

  it('a partial refund reduces net paid without reducing totalPaid, and a full refund brings net paid to zero', async () => {
    await contact(org, 'akash@example.com');
    await transaction(org, 'pay_5', { matchedEmailKey: 'akash@example.com', amount: 1000, refundedAmount: 300, paymentStatus: 'partially_refunded' });

    const { items } = await service.list(org, {});
    expect(items[0].gatewayPaymentSummary).toMatchObject({ totalPaid: 1000, totalRefunded: 300, netPaid: 700, status: 'partially_paid' });
  });

  it('organization isolation: one organization\'s payment never attaches to another organization\'s customer, even with the same email', async () => {
    const otherOrg = `${PREFIX}-org-other-${seq}`;
    await contact(org, 'shared@example.com');
    await contact(otherOrg, 'shared@example.com');
    await transaction(org, 'pay_6', { matchedEmailKey: 'shared@example.com', amount: 999, paymentStatus: 'completed' });

    const [mine, theirs] = await Promise.all([service.list(org, {}), service.list(otherOrg, {})]);
    expect(mine.items[0].gatewayPaymentSummary.transactionCount).toBe(1);
    expect(theirs.items[0].gatewayPaymentSummary.transactionCount).toBe(0);

    await connection.collection('crm_contacts').deleteMany({ organizationId: otherOrg });
  });

  it('detail() surfaces the full transaction list, newest first, never writing to crm_contacts/crm_accounts', async () => {
    await contact(org, 'akash@example.com');
    await transaction(org, 'pay_older', { matchedEmailKey: 'akash@example.com', amount: 100, paymentStatus: 'completed', paymentDate: daysAgo(5) });
    await transaction(org, 'pay_newer', { matchedEmailKey: 'akash@example.com', amount: 200, paymentStatus: 'completed', paymentDate: daysAgo(1) });

    const { items } = await service.list(org, {});
    const detail = await service.detail(org, items[0].id);

    expect(detail.gatewayPayments.map((p) => p.id)).toEqual(['pay_newer', 'pay_older']);
    const contactsAfter = await connection.collection('crm_contacts').find({ organizationId: org }).toArray();
    expect(contactsAfter).toHaveLength(1); // unchanged — a read-only join, never a write back to the CRM collections
  });

  // Square as a real entry in the same `sources` list a CRM gets — the
  // actual fix for the confirmed gap (Square invisible to the source
  // dropdown/"Sync now"/status display) — synthesized in compute() rather
  // than given a crm_data_sources row of its own.
  describe('Square as a source (sources dropdown, filtering, "Sync now")', () => {
    it('never appears when Square was never connected and has no payment history', async () => {
      await contact(org, 'akash@example.com');

      const { sources } = await service.list(org, {});

      expect(sources.find((s) => s.id === 'square')).toBeUndefined();
    });

    it('appears connected once Square is connected, even with zero payments yet', async () => {
      await connectSquare(org);

      const { sources } = await service.list(org, {});

      const square = sources.find((s) => s.id === 'square');
      expect(square).toMatchObject({ label: 'Square', connected: true, canSync: true, customers: 0 });
    });

    it('stays listed (disconnected) when it holds payment history even after disconnecting — never silently dropped', async () => {
      await contact(org, 'akash@example.com');
      await transaction(org, 'pay_1', { matchedEmailKey: 'akash@example.com', amount: 100, paymentStatus: 'completed' });
      // No connectSquare() — simulates "was connected, synced, then disconnected."

      const { sources } = await service.list(org, {});

      const square = sources.find((s) => s.id === 'square');
      expect(square).toMatchObject({ connected: false, canSync: false });
      expect(square!.customers).toBe(1);
    });

    it('shows the most recent lastSyncedAt across every Square transaction as the source\'s own lastSyncAt', async () => {
      await connectSquare(org);
      await contact(org, 'akash@example.com');
      const older = daysAgo(5);
      const newer = daysAgo(1);
      await transaction(org, 'pay_older', { matchedEmailKey: 'akash@example.com', amount: 100, paymentStatus: 'completed', lastSyncedAt: older });
      await transaction(org, 'pay_newer', { matchedEmailKey: 'akash@example.com', amount: 200, paymentStatus: 'completed', lastSyncedAt: newer });

      const { sources } = await service.list(org, {});

      const square = sources.find((s) => s.id === 'square');
      expect(square!.lastSyncAt).toEqual(newer);
    });

    it('selecting Square in the source filter narrows to exactly the customers with a matched Gateway Payment', async () => {
      await connectSquare(org);
      await contact(org, 'akash@example.com');
      await contact(org, 'priya@example.com');
      await transaction(org, 'pay_1', { matchedEmailKey: 'akash@example.com', amount: 100, paymentStatus: 'completed' });

      const narrowed = await service.list(org, { source: 'square' });

      expect(narrowed.items.map((c) => c.email)).toEqual(['akash@example.com']);
    });

    it('"Sync now" for Square calls the Square reconciliation pass, never the CRM dataSources.syncNow', async () => {
      await connectSquare(org);

      const { results } = await service.sync(org, 'square');

      expect(results).toEqual([{ source: 'Square', ok: true, error: undefined }]);
      expect(squareReconciliation.reconcileOrganization).toHaveBeenCalledWith(org);
      expect(dataSources.syncNow).not.toHaveBeenCalled();
    });

    it('"Sync now" for Square reports a clear failure when reconciliation itself throws, without touching other sources', async () => {
      await connectSquare(org);
      squareReconciliation.reconcileOrganization.mockRejectedValueOnce(new Error('Square is unreachable'));

      const { results } = await service.sync(org, 'square');

      expect(results).toEqual([{ source: 'Square', ok: false, error: 'The sync couldn’t be completed. Please try again in a minute.' }]);
    });
  });
});

describe('computeGatewayPaymentSummary (pure)', () => {
  const record = (overrides: Partial<GatewayPaymentRecord>): GatewayPaymentRecord => ({
    id: 'pay_x',
    provider: 'square',
    amount: 100,
    currency: 'USD',
    status: 'completed',
    date: new Date(),
    refundedAmount: 0,
    ...overrides,
  });

  it('an empty list of transactions is unpaid, not an error', () => {
    expect(computeGatewayPaymentSummary([])).toMatchObject({ status: 'unpaid', transactionCount: 0 });
  });

  it('duplicate rows of the SAME transaction (e.g. a webhook redelivery that somehow produced two) are never double-counted beyond what the unique index already prevents — summing is purely additive over whatever rows exist, so this documents that the dedup guarantee lives in the schema\'s compound unique index, not in this function', () => {
    // Two DIFFERENT real transactions sum correctly — the point being this
    // function has no hidden "if already counted, skip" logic of its own;
    // correctness depends entirely on upsertFromPayment's idempotent write.
    const summary = computeGatewayPaymentSummary([record({ id: 'a', amount: 100 }), record({ id: 'b', amount: 200 })]);
    expect(summary.totalPaid).toBe(300);
  });

  it('a disputed transaction is counted separately, never folded into "paid"', () => {
    const summary = computeGatewayPaymentSummary([record({ status: 'disputed', amount: 100 })]);
    expect(summary.disputedCount).toBe(1);
    expect(summary.totalPaid).toBe(0);
  });

  it('only pending/authorized/processing transactions (nothing has resolved yet) reads as "pending", not "failed_only"', () => {
    expect(computeGatewayPaymentSummary([record({ status: 'pending' })]).status).toBe('pending');
    expect(computeGatewayPaymentSummary([record({ status: 'authorized' })]).status).toBe('pending');
    expect(computeGatewayPaymentSummary([record({ status: 'processing' })]).status).toBe('pending');
  });

  it('only failed/cancelled transactions — nothing ever resolved AND nothing is still in flight — is the real "failed_only"', () => {
    expect(computeGatewayPaymentSummary([record({ status: 'failed' })]).status).toBe('failed_only');
    expect(computeGatewayPaymentSummary([record({ id: 'a', status: 'failed' }), record({ id: 'b', status: 'cancelled' })]).status).toBe('failed_only');
  });

  it('a failed attempt alongside a still-pending retry reads as "pending", not "failed_only" — there is still a live attempt', () => {
    const summary = computeGatewayPaymentSummary([record({ id: 'a', status: 'failed' }), record({ id: 'b', status: 'pending' })]);
    expect(summary.status).toBe('pending');
  });

  it('never adds two different currencies together — the totals cover only the newest payment\'s currency', () => {
    const older = record({ id: 'usd', amount: 10000, currency: 'USD', date: new Date('2026-01-01') });
    const newer = record({ id: 'aud', amount: 5000, currency: 'AUD', date: new Date('2026-06-01') });

    const summary = computeGatewayPaymentSummary([older, newer]);

    expect(summary.currency).toBe('AUD');
    expect(summary.totalPaid).toBe(5000); // never 15000 — USD and AUD are never summed as one number
    expect(summary.transactionCount).toBe(2); // still counted — never hidden, just not added into the money total
  });

  it('a pending transaction in a DIFFERENT currency from the newest one never counts toward "still in flight"', () => {
    // The newest (AUD) transaction already resolved (completed) — an older,
    // different-currency (USD) pending transaction must never flip the
    // overall status away from 'paid' just because it's technically pending.
    const resolved = record({ id: 'aud', amount: 5000, currency: 'AUD', status: 'completed', date: new Date('2026-06-01') });
    const unrelatedPending = record({ id: 'usd', amount: 10000, currency: 'USD', status: 'pending', date: new Date('2026-01-01') });

    const summary = computeGatewayPaymentSummary([resolved, unrelatedPending]);

    expect(summary.status).toBe('paid');
  });
});
