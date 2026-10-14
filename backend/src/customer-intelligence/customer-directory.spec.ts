import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection } from 'mongoose';
import { of, throwError } from 'rxjs';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { CustomerDirectoryService } from './customer-directory.service';
import { CustomerMailService } from './customer-mail.service';
import { CustomerWorkspaceService } from './customer-workspace.service';

const PREFIX = `jest-cust-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

// Against a real Mongo: one customer per real customer, whichever connected
// systems hold their records; the source dropdown lists what the organization
// has connected and narrows the table; nothing crosses organizations and
// nothing raw from a CRM reaches the response.
describe('Customers (real Mongo)', () => {
  let connection: Connection;
  let service: CustomerDirectoryService;
  const reservations = { reserve: jest.fn(), settle: jest.fn(), release: jest.fn(), resolveTenantKey: (org: string) => org };
  const http = { post: jest.fn() };
  const dataSources = { syncNow: jest.fn() };
  let seq = 0;
  let org: string;
  let gorilla: string;
  let pantheras: string;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({ imports: [MongooseModule.forRoot(uri)] }).compile();
    connection = moduleRef.get(getConnectionToken());
  });

  const source = async (organizationId: string, provider: string, label: string, status = 'active') =>
    (await connection.collection('crm_data_sources').insertOne({ organizationId, key: provider, provider, label, status })).insertedId.toString();

  beforeEach(async () => {
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
      { get: () => 'http://agent' } as never,
    );
    gorilla = await source(org, 'gorilladash', 'Gorilla Dash');
    pantheras = await source(org, 'prospectconnect', 'Pantheras CRM');
    await source(org, 'hoops', 'Hoops CRM');
    await source(org, 'haive_native', 'HaiVE workspace');
  });

  afterAll(async () => {
    for (const name of [
      'crm_data_sources',
      'crm_deals',
      'crm_quotes',
      'crm_contacts',
      'royalty_invoices',
      'crm_quote_payments',
      'email_intelligence_items',
      'email_sent_items',
      'email_follow_up_reminders',
      'customer_analyses',
      'customer_notes',
      'customer_tasks',
      'customer_statuses',
      'users',
    ]) {
      await connection.collection(name).deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    }
    // Files the tests attached: the bucket's two collections, by the organization on each file.
    const files = await connection
      .collection('customer_files.files')
      .find({ 'metadata.organizationId': { $regex: `^${PREFIX}` } }, { projection: { _id: 1 } })
      .toArray();
    await connection.collection('customer_files.chunks').deleteMany({ files_id: { $in: files.map((f) => f._id) } });
    await connection.collection('customer_files.files').deleteMany({ _id: { $in: files.map((f) => f._id) } });
    await connection.close();
  });

  const enquiry = (organizationId: string, dataSourceId: string, n: number, received: Date, person: Record<string, unknown>, message: string) => ({
    organizationId,
    dataSourceId,
    externalId: String(n),
    name: `Enquiry ${n}`,
    dealStatus: 'open',
    createdAt: received,
    sourceData: {
      id: n,
      organisation_id: 5,
      tribe_slug: 'chennai',
      submit_url: 'https://example.test/x',
      person,
      fields: [{ name: 'Message', value: message }],
      enquiry_url_parameters: [{ name: 'utm_source', value: 'google' }],
    },
  });

  // Priya: an enquiry in Gorilla Dash, and a deal, two quotations and an invoice in Pantheras under the same email in another case and the same phone written differently.
  const seedPriya = async () => {
    await connection
      .collection('crm_deals')
      .insertOne(
        enquiry(
          org,
          gorilla,
          1,
          daysAgo(6),
          { first_name: 'Priya', last_name: 'Raman', business_name: 'Sundar Textiles Pvt Ltd', email: 'priya@sundar.example', number_e164: '+919840012345' },
          'Need 300 polo shirts',
        ),
      );
    const deal = (
      await connection.collection('crm_deals').insertOne({
        organizationId: org,
        dataSourceId: pantheras,
        externalId: 'd1',
        name: 'Sundar Textiles - Polos',
        dealStatus: 'won',
        monetaryValue: 85000,
        createdAt: daysAgo(200),
      })
    ).insertedId.toString();
    const client = { email: 'Priya@Sundar.example', companyName: 'Sundar Textiles', contactName: 'Priya Raman', phone: '09840012345' };
    const quote = (number: string, amount: number, created: Date, approval: string) => ({
      organizationId: org,
      dataSourceId: pantheras,
      dealId: deal,
      quoteNumber: number,
      quoteName: `Order ${number}`,
      quoteAmount: amount,
      currency: 'INR',
      quoteStatus: 'published',
      clientApprovalStatus: approval,
      clientDetails: client,
      createdAt: created,
      expirationDate: new Date(created.getTime() + 40 * DAY).toISOString().slice(0, 10),
    });
    const accepted = (await connection.collection('crm_quotes').insertOne(quote('Q-1', 85000, daysAgo(199), 'approved'))).insertedId.toString();
    await connection.collection('crm_quotes').insertOne(quote('Q-2', 120000, daysAgo(5), 'awaiting_response'));
    await connection.collection('royalty_invoices').insertOne({
      organizationId: org,
      invoiceNumber: 'INV-1',
      quoteId: accepted,
      dealId: deal,
      invoiceDate: daysAgo(198),
      currentValue: 85000,
      costAmount: 59500,
      currency: 'INR',
      invoiceStatus: 'invoiced',
      voidStatus: false,
      clientDetails: {},
    });
    await connection
      .collection('crm_quote_payments')
      .insertOne({ organizationId: org, quoteId: accepted, amount: 50000, paymentDate: daysAgo(190).toISOString().slice(0, 10), voided: false });
    await connection.collection('email_sent_items').insertOne({
      organizationId: org,
      userId: org,
      externalMessageId: 's1',
      conversationId: 'c1',
      sentAt: daysAgo(4),
      subject: 'Your quotation',
      toAddresses: ['PRIYA@sundar.example'],
    });
  };

  it('shows one customer for records spread over two CRMs and the mailbox', async () => {
    await seedPriya();
    await connection
      .collection('crm_deals')
      .insertOne(
        enquiry(org, gorilla, 2, daysAgo(1), { first_name: 'Arun', last_name: 'Kumar', email: 'arun@bluewave.example' }, 'Do you make safety jackets?'),
      );

    const result = await service.list(org, {});
    expect(result.total).toBe(2);
    const priya = result.items.find((c) => c.name === 'Priya Raman')!;
    expect(priya).toMatchObject({
      sources: ['Gorilla Dash', 'Pantheras CRM'],
      type: 'returning',
      crm: { status: 'customer' },
      orders: { status: 'previous_order', count: 1, totalValue: 85000 },
      quotes: { count: 2, openCount: 1, latest: { number: 'Q-2', state: 'sent' } },
      invoices: { count: 1, total: 85000, latest: { number: 'INV-1', paid: 50000, outstanding: 35000, marginPct: 30 } },
      payment: { status: 'partially_paid', billed: 85000, paid: 50000, outstanding: 35000 },
      mail: { status: 'follow_up', sent: 1 },
      inquiries: { count: 1, open: true },
    });
    expect(priya.flags).toEqual(expect.arrayContaining(['quote_pending', 'payment_pending', 'follow_up_required']));
    // The dropdown: what is connected (even with nothing in it yet), never HaiVE's own empty workspace.
    expect(result.sources.map((s) => [s.label, s.customers])).toEqual([
      ['Gorilla Dash', 2],
      ['Pantheras CRM', 1],
      ['Hoops CRM', 0],
    ]);
    expect(result.stats).toMatchObject({ total: 2, existing: 1, quotePending: 1, quotePendingValue: 120000, paymentPending: 1, outstanding: 35000 });
    // Nothing raw from either CRM.
    expect(JSON.stringify(result)).not.toMatch(/utm_source|submit_url|tribe_slug|organisation_id|sourceData|prospectconnect|externalId/);
  });

  it('a contact created in a CRM is a customer before anything is quoted, and joins the customer its email or phone is already on', async () => {
    await seedPriya();
    const contact = (externalId: string, fields: Record<string, unknown>) => ({ organizationId: org, dataSourceId: pantheras, externalId, ...fields });
    await connection.collection('crm_contacts').insertMany([
      // New today, nothing else about them anywhere.
      contact('c1', { name: 'Dee', email: 'dee@haive.example', phone: '+61403027467', company: 'Haive', sourceCreatedAt: daysAgo(0) }),
      // Priya, under the phone her quotations carry.
      contact('c2', { name: 'Priya R', phone: '+91 98400 12345', sourceCreatedAt: daysAgo(300) }),
      // Stored before the CRM's own date was kept, and named after its email by the sync.
      contact('c3', { name: 'meena@kovai.example', email: 'meena@kovai.example' }),
    ]);

    const result = await service.list(org, {});
    expect(result.items.map((c) => c.name)).toEqual(['Dee', 'Priya Raman', 'meena@kovai.example']);
    expect(result.items[0]).toMatchObject({
      company: 'Haive',
      email: 'dee@haive.example',
      sources: ['Pantheras CRM'],
      type: 'new',
      lastActivity: { label: 'Added as a contact' },
      quotes: { count: 0 },
    });
    // A contact with no date from the CRM is shown, but says nothing about when anything happened.
    expect(result.items[2]).toMatchObject({ lastActivity: null });
    expect(result.items[1]).toMatchObject({ quotes: { count: 2 }, sources: ['Gorilla Dash', 'Pantheras CRM'] });
    const detail = await service.detail(org, result.items[0].id);
    expect(detail.timeline).toEqual([expect.objectContaining({ kind: 'contact', title: 'Added as a contact', detail: 'In Pantheras CRM' })]);
    expect((await service.list(org, { search: 'dee@haive' })).items.map((c) => c.name)).toEqual(['Dee']);
  });

  it('the source filter narrows to customers known to that system, and keeps their whole picture', async () => {
    await seedPriya();
    await connection
      .collection('crm_deals')
      .insertOne(enquiry(org, gorilla, 2, daysAgo(1), { first_name: 'Arun', last_name: 'Kumar', email: 'arun@bluewave.example' }, 'Safety jackets?'));

    const fromPantheras = await service.list(org, { source: pantheras });
    expect(fromPantheras.items.map((c) => c.name)).toEqual(['Priya Raman']);
    // Still the unified customer: her Gorilla Dash enquiry is part of the picture.
    expect(fromPantheras.items[0]).toMatchObject({ sources: ['Gorilla Dash', 'Pantheras CRM'], inquiries: { count: 1 } });
    expect((await service.list(org, { source: gorilla })).total).toBe(2);
    const hoops = (await service.list(org, {})).sources.find((s) => s.label === 'Hoops CRM')!;
    expect(await service.list(org, { source: hoops.id })).toMatchObject({ total: 0, stats: { total: 0 } });
    await expect(service.list(org, { source: 'not-a-source' })).rejects.toBeInstanceOf(BadRequestException);

    expect((await service.list(org, { view: 'quote_pending' })).items.map((c) => c.name)).toEqual(['Priya Raman']);
    expect((await service.list(org, { view: 'not_converted' })).items.map((c) => c.name)).toEqual(['Arun Kumar']);
    // Priya ordered once and has enquired again since: returning (and, having ordered, existing too).
    expect((await service.list(org, { view: 'returning' })).items.map((c) => c.name)).toEqual(['Priya Raman']);
    expect((await service.list(org, { view: 'existing' })).items.map((c) => c.name)).toEqual(['Priya Raman']);
    expect((await service.list(org, { search: 'inv-1' })).items.map((c) => c.name)).toEqual(['Priya Raman']);
    expect((await service.list(org, { sort: 'name' })).items.map((c) => c.name)).toEqual(['Arun Kumar', 'Priya Raman']);
    expect((await service.list(org, { sort: 'quotes' })).items.map((c) => c.name)).toEqual(['Priya Raman', 'Arun Kumar']);
    await expect(service.list(org, { view: 'nonsense' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the detail holds the quotations, invoices, comparison, gaps and one timeline', async () => {
    await seedPriya();
    const { items } = await service.list(org, {});
    const detail = await service.detail(org, items[0].id);
    expect(detail.quotations.map((q) => [q.number, q.stateLabel])).toEqual([
      ['Q-2', 'Sent'],
      ['Q-1', 'Accepted'],
    ]);
    expect(detail.invoiceList).toEqual([
      expect.objectContaining({ number: 'INV-1', amount: 85000, paid: 50000, outstanding: 35000, cost: 59500, marginPct: 30, quotationNumber: 'Q-1' }),
    ]);
    expect(detail.comparison).toMatchObject({
      previous: { label: 'Invoice INV-1', marginPct: 30 },
      current: { label: 'Quotation Q-2', value: 120000 },
      valueDifference: 35000,
    });
    expect(detail.inquiry).toMatchObject({ source: 'Gorilla Dash', fields: [{ name: 'Message', value: 'Need 300 polo shirts' }] });
    expect(detail.timeline.map((e) => e.kind)).toEqual(['email_sent', 'quotation', 'enquiry', 'payment', 'order', 'quotation']);
    expect(detail.gaps).toEqual(expect.arrayContaining([expect.stringMatching(/No payment due date is recorded/)]));
    expect(detail.analysis).toBeNull();
    await expect(service.detail(org, 'no-such-customer')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('offers open inquiries as a view, and says how each source last synced', async () => {
    await seedPriya();
    await connection
      .collection('crm_deals')
      .insertOne(enquiry(org, gorilla, 2, daysAgo(1), { first_name: 'Arun', last_name: 'Kumar', email: 'arun@bluewave.example' }, 'Safety jackets?'));
    // A customer who only ever bought: no inquiry of theirs is open.
    await connection.collection('crm_quotes').insertOne({
      organizationId: org,
      dataSourceId: pantheras,
      quoteNumber: 'Q-9',
      quoteAmount: 9000,
      currency: 'INR',
      quoteStatus: 'published',
      clientApprovalStatus: 'approved',
      clientDetails: { email: 'rahul@apex.example', contactName: 'Rahul Shah' },
      createdAt: daysAgo(40),
    });
    await connection
      .collection('crm_data_sources')
      .updateOne(
        { organizationId: org, provider: 'gorilladash' },
        { $set: { sync: { lastStatus: 'error', lastError: 'The API key was rejected.', lastSyncAt: daysAgo(1) } } },
      );

    const result = await service.list(org, { view: 'open_inquiry', sort: 'name' });
    expect(result.items.map((c) => c.name)).toEqual(['Arun Kumar', 'Priya Raman']);
    expect(result.stats).toMatchObject({ total: 3, openInquiries: 2 });
    expect(result.sources).toEqual([
      expect.objectContaining({ label: 'Gorilla Dash', connected: true, canSync: true, lastError: 'The API key was rejected.' }),
      expect.objectContaining({ label: 'Pantheras CRM', connected: true, canSync: true, lastError: undefined }),
      // Connected, but it has nothing to pull: no Sync for it.
      expect.objectContaining({ label: 'Hoops CRM', connected: true, canSync: false }),
    ]);
  });

  it('Sync now pulls from every CRM that can be synced, and one failing does not stop the others', async () => {
    await seedPriya();
    dataSources.syncNow.mockImplementation(async (_org: string, id: string) => {
      if (id === pantheras) throw new Error('timeout');
      return { status: 'ok' };
    });
    const { results } = await service.sync(org);
    expect(dataSources.syncNow.mock.calls.map((call) => call[1]).sort()).toEqual([gorilla, pantheras].sort());
    expect(results).toEqual(
      expect.arrayContaining([
        { source: 'Gorilla Dash', ok: true, error: undefined },
        { source: 'Pantheras CRM', ok: false, error: expect.stringMatching(/couldn’t be completed/) },
      ]),
    );

    // Asked for one source: only that one.
    jest.clearAllMocks();
    dataSources.syncNow.mockResolvedValue({ status: 'error', error: 'The API key was rejected.' });
    expect(await service.sync(org, gorilla)).toEqual({ results: [{ source: 'Gorilla Dash', ok: false, error: 'The API key was rejected.' }] });
    expect(dataSources.syncNow).toHaveBeenCalledTimes(1);
    // A source with nothing to pull, or somebody else's source, can't be synced.
    const hoops = (await service.list(org, {})).sources.find((x) => x.label === 'Hoops CRM')!;
    await expect(service.sync(org, hoops.id)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.sync(`${PREFIX}-nobody`)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the period keeps customers with anything happening in it — an inquiry, a quotation, an invoice, a payment or an email', async () => {
    await seedPriya(); // inquiry 6 days ago, quotation 5, our email 4; first order ~200 days ago
    await connection
      .collection('crm_deals')
      .insertOne(enquiry(org, gorilla, 2, daysAgo(40), { first_name: 'Arun', last_name: 'Kumar', email: 'arun@bluewave.example' }, 'Safety jackets?'));
    const day = (n: number) => daysAgo(n).toISOString().slice(0, 10);
    const names = async (from?: string, to?: string) => (await service.list(org, { from, to, sort: 'name' })).items.map((c) => c.name);

    expect(await names()).toEqual(['Arun Kumar', 'Priya Raman']);
    expect(await names(day(10))).toEqual(['Priya Raman']);
    expect(await names(day(60), day(30))).toEqual(['Arun Kumar']);
    // Priya's old order still counts as activity in its own period…
    expect(await names(day(210), day(180))).toEqual(['Priya Raman']);
    // …and a period nothing happened in is empty, tiles included.
    expect(await service.list(org, { from: day(120), to: day(90) })).toMatchObject({ total: 0, stats: { total: 0, openInquiries: 0 } });
    // An email alone puts a customer in the period: only our email to Priya falls on that day.
    expect(await names(daysAgo(4.2).toISOString(), daysAgo(3.8).toISOString())).toEqual(['Priya Raman']);
    // The tiles count the period, and the other filters work inside it.
    expect((await service.list(org, { from: day(10) })).stats).toMatchObject({ total: 1, existing: 1, quotePending: 1 });
    expect(await service.list(org, { from: day(10), view: 'not_converted' })).toMatchObject({ total: 0, stats: { total: 1 } });
    await expect(service.list(org, { from: 'yesterday-ish' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.list(org, { from: day(1), to: day(5) })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('never shows one organization the customers of another', async () => {
    await seedPriya();
    const other = `${PREFIX}-other-${seq}`;
    const theirSource = await source(other, 'gorilladash', 'Gorilla Dash');
    await connection
      .collection('crm_deals')
      .insertOne(
        enquiry(other, theirSource, 9, daysAgo(2), { first_name: 'Priya', last_name: 'Raman', email: 'priya@sundar.example' }, 'A different company’s lead'),
      );

    const theirs = await service.list(other, {});
    expect(theirs.total).toBe(1);
    // Same email address, but none of the first organization's quotations, invoices or mail.
    expect(theirs.items[0]).toMatchObject({ sources: ['Gorilla Dash'], type: 'new', quotes: { count: 0 }, invoices: { count: 0 }, mail: { sent: 0 } });
    const mine = await service.list(org, {});
    await expect(service.detail(other, mine.items[0].id)).resolves.toMatchObject({ quotations: [], invoiceList: [] });
    await expect(service.list(other, { source: pantheras })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an AI analysis is billed, saved and reused until the facts change — and released when it fails', async () => {
    await seedPriya();
    const caller = { sub: 'u1', organizationId: org, email: 'x', roles: ['owner'] } as never;
    const id = (await service.list(org, {})).items[0].id;
    const result = {
      statusLabel: 'Returning — quote pending',
      summary: 'Bought before; quotation Q-2 awaits a decision.',
      nextAction: 'Follow up.',
      recommendations: [],
      issues: [],
      pricingAdvice: '',
      suggestedMessage: '',
    };

    http.post.mockReturnValueOnce(throwError(() => new Error('down')));
    await expect(service.analyze(caller, id, false)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(reservations.release).toHaveBeenCalledTimes(1);
    expect(reservations.settle).not.toHaveBeenCalled();

    http.post.mockReturnValue(of({ data: result }));
    expect(await service.analyze(caller, id, false)).toMatchObject({ summary: result.summary, stale: false });
    expect(reservations.settle).toHaveBeenCalledTimes(1);
    // The AI is given the story, not the address book or anything raw.
    const sent = JSON.stringify(http.post.mock.calls[1][1]);
    expect(sent).toMatch(/Q-2/);
    expect(sent).not.toMatch(/priya@sundar|9840012345|utm_source|sourceData/i);

    // Asked again with nothing changed: the saved one, no second charge.
    await service.analyze(caller, id, false);
    expect(http.post).toHaveBeenCalledTimes(2);
    expect((await service.detail(org, id)).analysis).toMatchObject({ summary: result.summary, stale: false });
  });

  // ---- the board ---------------------------------------------------------------------

  const seedBoard = async () => {
    await seedPriya();
    await connection.collection('crm_quotes').updateMany({ organizationId: org }, { $set: { quoteOwnerLabel: 'Sanjay Kumar' } });
    await connection.collection('crm_deals').insertMany([
      {
        ...enquiry(org, gorilla, 2, daysAgo(1), { first_name: 'Arun', last_name: 'Kumar', email: 'arun@bluewave.example' }, 'Safety jackets?'),
        sourceData: undefined,
      },
      enquiry(
        org,
        gorilla,
        3,
        daysAgo(9),
        { first_name: '=cmd', last_name: 'Tester', business_name: '@evil', email: 'tester@mail.example', number_display: '+91 90000 11111' },
        'Hello',
      ),
    ]);
    // The channel an enquiry came through is on its record; Arun's is replaced with one that says so.
    await connection.collection('crm_deals').updateOne(
      { organizationId: org, externalId: '2' },
      {
        $set: {
          sourceData: { person: { first_name: 'Arun', last_name: 'Kumar', email: 'arun@bluewave.example' }, fields: [], calculated_source: 'Paid Search' },
        },
      },
    );
  };

  it('each row carries its six steps, its owner and its follow-up; the filters and the sort read the same facts', async () => {
    await seedBoard();
    const board = await service.list(org, { sort: 'name' });
    const priya = board.items.find((c) => c.name === 'Priya Raman')!;
    expect(priya.owner).toBe('Sanjay Kumar');
    expect(priya.stages.map((s) => [s.key, s.label, s.tone])).toEqual([
      ['inquiry', 'Open', 'progress'],
      ['quote', 'Sent', 'progress'],
      ['order', 'Past order', 'done'],
      ['payment', 'Part paid', 'waiting'],
      ['email', 'No reply yet', 'waiting'],
      ['followUp', 'No follow-up', 'none'],
    ]);
    expect(priya.stages[1].detail).toBe('Q-2 · ₹1,20,000 · +1');
    // What the Owner and channel filters can offer: only what these customers really have.
    expect(board.filterOptions).toEqual({ owners: ['Sanjay Kumar'], channels: ['Paid Search'] });

    const names = async (query: Record<string, string>) => (await service.list(org, { sort: 'name', ...query })).items.map((c) => c.name);
    expect(await names({ owner: 'Sanjay Kumar' })).toEqual(['Priya Raman']);
    expect(await names({ owner: 'none' })).toEqual(['=cmd Tester', 'Arun Kumar']);
    expect(await names({ type: 'returning,existing' })).toEqual(['Priya Raman']);
    expect(await names({ quote: 'none' })).toEqual(['=cmd Tester', 'Arun Kumar']);
    expect(await names({ quote: 'sent', payment: 'partially_paid' })).toEqual(['Priya Raman']);
    expect(await names({ payment: 'paid' })).toEqual([]);
    expect(await names({ mail: 'not_contacted' })).toEqual(['=cmd Tester', 'Arun Kumar']);
    expect(await names({ channel: 'Paid Search' })).toEqual(['Arun Kumar']);
    // "none": no channel is recorded on their inquiry (or they have no inquiry).
    expect(await names({ channel: 'Paid Search,none' })).toEqual(['=cmd Tester', 'Arun Kumar', 'Priya Raman']);
    expect(await names({ channel: 'none' })).toEqual(['=cmd Tester', 'Priya Raman']);
    // The tiles count the source and the period, whatever the filters say.
    expect(await service.list(org, { owner: 'Sanjay Kumar' })).toMatchObject({ total: 1, stats: { total: 3 } });
    // Sorted by owner: the customer with one first, those with none after — whichever way it runs.
    expect((await service.list(org, { sort: 'owner' })).items[0].name).toBe('Priya Raman');
    expect((await service.list(org, { sort: 'owner', direction: 'asc' })).items[0].name).toBe('Priya Raman');
  });

  it('exports the board as a spreadsheet: every customer of the view, in the board’s words, and nothing that runs', async () => {
    await seedBoard();
    const lines = (await service.export(org, { sort: 'name' })).split(/\r?\n/);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(
      '"Customer","Company","Email","Phone","Known to","Owner","Type","Last activity","Last activity date","Inquiry","Inquiry channel","Quote","Quote number","Quote amount","Order","Orders","Order value","Payment","Outstanding","Email status","Follow-up","Follow-up date","Next step","Set by hand","Currency"',
    );
    // A name typed as a formula is written as text.
    // …while a phone number, which only looks like one, stays as written.
    expect(lines[1]).toMatch(/^"'=cmd Tester","'@evil","tester@mail\.example","\+91 90000 11111"/);
    const priya = lines.find((line) => line.startsWith('"Priya Raman"'))!;
    expect(priya).toContain('"Gorilla Dash + Pantheras CRM","Sanjay Kumar","Returning"');
    expect(priya).toContain('"Open","","Sent","Q-2",120000,"Past order",1,85000,"Part paid",35000,"No reply yet","No follow-up"');
    // The same filters as the list.
    expect((await service.export(org, { quote: 'sent' })).split(/\r?\n/)).toHaveLength(2);
    expect((await service.export(org, { source: gorilla, view: 'not_converted' })).split(/\r?\n/)).toHaveLength(3);
    await expect(service.export(org, { source: 'not-a-source' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the panel connects the records: journeys, documents with their neighbours, emails and follow-ups', async () => {
    await seedBoard();
    const item = (
      await connection.collection('email_intelligence_items').insertOne({
        organizationId: org,
        userId: org,
        externalMessageId: `m-${seq}`,
        conversationId: 'c1',
        fromAddress: 'Priya@Sundar.example',
        subject: 'Re: Your quotation',
        receivedAt: daysAgo(2),
        status: 'pending',
        shouldDraft: true,
        expectedNextAction: 'company_reply',
      })
    ).insertedId.toString();
    await connection.collection('email_follow_up_reminders').insertMany([
      {
        organizationId: org,
        userId: org,
        emailIntelligenceItemId: item,
        title: 'Send the size chart',
        dueDate: daysAgo(1),
        status: 'pending',
        reminderType: 'post_reply',
      },
      { organizationId: org, userId: org, emailIntelligenceItemId: item, title: 'Old one', dueDate: daysAgo(30), status: 'done', reminderType: 'sla_breach' },
    ]);

    const id = (await service.list(org, { search: 'priya' })).items[0].id;
    const detail = await service.detail(org, id);
    expect(detail.people).toEqual([{ name: 'Priya Raman', email: 'priya@sundar.example', phone: '09840012345' }]);
    expect(detail.journeys.map((j) => j.steps.map((s) => s.title))).toEqual([
      ['Inquiry', 'Deal won', 'Quotation Q-2'],
      ['Deal won', 'Quotation Q-1', 'Invoice INV-1', 'Payment'],
    ]);
    expect(detail.journeys[1].steps[3]).toMatchObject({ detail: '₹50,000 paid · ₹35,000 due', tone: 'waiting' });
    expect(detail.documents.map((d) => [d.kind, d.number, d.status, d.owner, d.source])).toEqual([
      ['quotation', 'Q-2', 'Sent', 'Sanjay Kumar', 'Pantheras CRM'],
      ['invoice', 'INV-1', 'Invoiced', 'Sanjay Kumar', 'Pantheras CRM'],
      ['quotation', 'Q-1', 'Accepted', 'Sanjay Kumar', 'Pantheras CRM'],
    ]);
    expect(detail.documents[1]).toMatchObject({
      preparedFor: { company: 'Sundar Textiles', contact: 'Priya Raman' },
      paid: 50000,
      outstanding: 35000,
      payments: [{ amount: 50000 }],
      // The CRM holds no lines for these quotations: none are made up.
      lines: [],
    });
    expect(detail.documents[1].links.map((s) => [s.title, s.documentId])).toEqual([
      ['Deal won', undefined],
      ['Quotation Q-1', detail.documents[2].id],
      ['Payment', undefined],
    ]);
    expect(detail.emails.map((e) => [e.direction, e.subject, e.needsReply])).toEqual([
      ['received', 'Re: Your quotation', true],
      ['sent', 'Your quotation', false],
    ]);
    expect(detail.emails[0].id).toBe(item);
    expect(detail.followUps.map((f) => [f.title, f.status, f.due])).toEqual([
      ['Old one', 'done', false],
      ['Send the size chart', 'pending', true],
    ]);
    // The reminder that is still to do is on the board: an overdue follow-up, and a customer who needs one.
    const row = (await service.list(org, { search: 'priya' })).items[0];
    expect(row).toMatchObject({
      followUp: { status: 'overdue', count: 1, nextTitle: 'Send the size chart' },
      flags: expect.arrayContaining(['follow_up_required']),
    });
    expect(row.stages[5]).toMatchObject({ label: 'Overdue', tone: 'attention', detail: 'Send the size chart' });
    expect(JSON.stringify(detail)).not.toMatch(/utm_source|sourceData|externalId|prospectconnect/);
  });

  it('a quotation’s items are its deal’s products where the CRM keeps them there, with the quotation’s own tax and fees', async () => {
    await seedPriya();
    // As the sync stores them: the product lines on the deal, the tax and fee lines on each quotation.
    await connection.collection('crm_deals').updateOne(
      { organizationId: org, externalId: 'd1' },
      {
        $set: {
          products: [
            { name: 'Polo t-shirt, navy', description: '220 GSM, embroidered logo', quantity: 250, unitPrice: 400, total: 100000, externalId: 'p1' },
            { name: 'Cap', quantity: 10, unitPrice: 169.5, total: 1695 },
            { name: '', quantity: 1, unitPrice: 1, total: 1 },
          ],
        },
      },
    );
    await connection
      .collection('crm_quotes')
      .updateOne(
        { organizationId: org, quoteNumber: 'Q-2' },
        { $set: { taxes: [{ name: 'GST 18%', amount: 18305 }], fees: [{ name: 'Shipping', amount: 0 }] } },
      );

    const id = (await service.list(org, {})).items[0].id;
    const { documents } = await service.detail(org, id);
    const [q2, invoice, q1] = documents;
    // Q-2 (₹1,20,000): 1,01,695 of items + 18,305 of tax — it adds up, so nothing more is said.
    expect(q2).toMatchObject({
      number: 'Q-2',
      linesFrom: 'deal',
      lines: [
        { description: 'Polo t-shirt, navy', detail: '220 GSM, embroidered logo', quantity: 250, unitPrice: 400, total: 100000 },
        { description: 'Cap', quantity: 10, unitPrice: 169.5, total: 1695 },
      ],
      subtotal: 101695,
      charges: [{ kind: 'tax', name: 'GST 18%', amount: 18305 }],
    });
    expect(q2.linesNote).toBeUndefined();
    // Q-1 (₹85,000) was raised from the same deal earlier: the deal's products today don't come to it, and that is said.
    expect(q1).toMatchObject({ number: 'Q-1', lines: [{ description: 'Polo t-shirt, navy' }, { description: 'Cap' }], subtotal: 101695, charges: [] });
    expect(q1.linesNote).toMatch(/^These are the products on the deal in Pantheras CRM today\. They come to ₹1,01,695, not this quotation’s ₹85,000/);
    // The invoice raised from Q-1 is for the same items.
    expect(invoice).toMatchObject({ kind: 'invoice', number: 'INV-1', lines: [{ description: 'Polo t-shirt, navy' }, { description: 'Cap' }] });
    expect(invoice.linesNote).toMatch(/not this invoice’s ₹85,000/);
    // Nothing of the CRM's own ids reaches the page.
    expect(JSON.stringify(documents)).not.toMatch(/externalId|"p1"/);

    // A quotation written in HaiVE carries its own lines: those win over the deal's.
    await connection
      .collection('crm_quotes')
      .updateOne(
        { organizationId: org, quoteNumber: 'Q-2' },
        {
          $set: {
            lineItems: [{ description: 'Polo t-shirt — annual day', quantity: 300, unitPrice: 400, lineSubtotal: 120000, lineTotal: 120000 }],
            taxes: [],
          },
        },
      );
    service.invalidate(org);
    expect((await service.detail(org, id)).documents[0]).toMatchObject({
      linesFrom: 'document',
      lines: [{ description: 'Polo t-shirt — annual day', quantity: 300, total: 120000 }],
      subtotal: 120000,
    });
  });

  // ---- what the team attaches: comments, tasks, files --------------------------------

  const person = async (organizationId: string, name: string, roles: string[]) => {
    const id = (
      await connection
        .collection('users')
        .insertOne({ organizationId, name, email: `${PREFIX}-${seq}-${name.toLowerCase().replace(/\W/g, '')}@example.test`, roles, active: true })
    ).insertedId.toString();
    return { sub: id, organizationId, email: 'x', roles } as never;
  };

  it('comments, tasks and files stay with the customer, show on the board and the timeline, and are nobody else’s', async () => {
    await seedBoard();
    const workspace = new CustomerWorkspaceService(connection, service, new GridFsService(connection));
    const owner = await person(org, 'Vasanth G', ['owner']);
    const manager = await person(org, 'Sanjay', ['manager']);
    await person(org, 'Platform Admin', ['superadmin']);
    const id = (await service.list(org, { search: 'priya' })).items[0].id;
    const arun = (await service.list(org, { search: 'arun' })).items[0].id;

    // -- comments
    const note = await workspace.addNote(manager, id, '  Agreed on the phone: logo on the left chest.  ');
    expect(note).toMatchObject({ body: 'Agreed on the phone: logo on the left chest.', author: 'Sanjay', mine: true });
    await expect(workspace.addNote(manager, id, '   ')).rejects.toBeInstanceOf(BadRequestException);
    await expect(workspace.addNote(manager, 'no-such-customer', 'x')).rejects.toBeInstanceOf(NotFoundException);

    // -- tasks: a due one is a follow-up on the board; done, it is not
    await expect(workspace.addTask(manager, id, { title: 'Call back', assigneeId: 'not-a-user' })).rejects.toBeInstanceOf(BadRequestException);
    const task = await workspace.addTask(manager, id, {
      title: 'Call back about the logo size',
      dueDate: daysAgo(2).toISOString(),
      assigneeId: (owner as { sub: string }).sub,
    });
    expect(task).toMatchObject({ status: 'open', assignee: 'Vasanth G', createdBy: 'Sanjay', overdue: true, mine: true });
    const undated = await workspace.addTask(owner, id, { title: 'Find the old artwork' });
    let row = (await service.list(org, { search: 'priya' })).items[0];
    expect(row).toMatchObject({ followUp: { status: 'overdue', count: 2, nextTitle: 'Call back about the logo size' }, nextAction: { urgency: 'overdue' } });
    expect(row.stages[5]).toMatchObject({ label: 'Overdue', tone: 'attention', detail: 'Call back about the logo size · +1' });
    expect((await service.list(org, { view: 'follow_up', search: 'priya' })).total).toBe(1);

    const done = await workspace.updateTask(owner, id, task.id, { status: 'done' });
    expect(done).toMatchObject({ status: 'done', overdue: false });
    expect(done.completedAt).toBeInstanceOf(Date);
    row = (await service.list(org, { search: 'priya' })).items[0];
    expect(row.followUp).toMatchObject({ status: 'upcoming', count: 1 });
    expect(row.stages[5]).toMatchObject({ label: 'To do', tone: 'progress', detail: 'Find the old artwork' });
    expect(await workspace.updateTask(owner, id, undated.id, { dueDate: daysAgo(-3).toISOString(), assigneeId: null })).toMatchObject({
      assignee: undefined,
      overdue: false,
    });
    await expect(workspace.updateTask(owner, id, undated.id, {})).rejects.toBeInstanceOf(BadRequestException);
    // A task of one customer can't be reached through another.
    await expect(workspace.updateTask(owner, arun, task.id, { status: 'open' })).rejects.toBeInstanceOf(NotFoundException);

    // -- files: stored, listed, downloaded, and nothing that runs is taken in
    const upload = (name: string, body = 'artwork bytes') =>
      ({ originalname: name, mimetype: 'application/pdf', buffer: Buffer.from(body) }) as Express.Multer.File;
    const file = await workspace.addFile(manager, id, upload('C:\\fakepath\\logo "final".pdf'));
    expect(file).toMatchObject({ name: 'logo final.pdf', size: 13, uploadedBy: 'Sanjay', mine: true });
    await expect(workspace.addFile(manager, id, upload('setup.exe'))).rejects.toBeInstanceOf(BadRequestException);
    await expect(workspace.addFile(manager, id, undefined)).rejects.toBeInstanceOf(BadRequestException);
    const opened = await workspace.openFile(owner, id, file.id);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream as AsyncIterable<Buffer>) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('artwork bytes');
    await expect(workspace.openFile(owner, arun, file.id)).rejects.toBeInstanceOf(NotFoundException);

    // -- the panel: everything, with who may do what
    const forManager = await workspace.overview(manager, id);
    expect(forManager).toMatchObject({
      notes: [{ id: note.id, mine: true }],
      files: [{ id: file.id, name: 'logo final.pdf', mine: true }],
      linkedTasks: [],
      canManage: false,
      limits: { maxFiles: 50 },
    });
    // Open ones first, then what is done.
    expect(forManager.tasks.map((t) => [t.title, t.status, t.mine])).toEqual([
      ['Find the old artwork', 'open', false],
      ['Call back about the logo size', 'done', true],
    ]);
    // Who a task can be given to: the organization's people — never a platform administrator.
    expect(forManager.assignees.map((a) => a.name)).toEqual(['Sanjay', 'Vasanth G']);
    expect((await workspace.overview(owner, arun)).notes).toEqual([]);

    // -- the timeline tells it too, but the AI is not told what the team wrote
    const kinds = (await service.detail(org, id)).timeline.map((e) => [e.kind, e.title]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['comment', 'Comment by Sanjay'],
        ['task', 'Task added by Sanjay'],
        ['task', 'Task done'],
        ['file', 'File added by Sanjay'],
      ]),
    );
    http.post.mockReturnValue(
      of({ data: { statusLabel: '', summary: 'S', nextAction: '', recommendations: [], issues: [], pricingAdvice: '', suggestedMessage: '' } }),
    );
    await service.analyze(owner, id, true);
    expect(JSON.stringify(http.post.mock.calls[0][1])).not.toMatch(/left chest|logo size|logo final/);

    // -- only the person who added something, or an owner/admin, removes it
    await expect(workspace.removeNote(await person(org, 'Meera', ['manager']), id, note.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(workspace.removeTask(manager, id, undated.id)).rejects.toBeInstanceOf(ForbiddenException);
    await workspace.removeTask(owner, id, undated.id);
    await workspace.removeNote(manager, id, note.id);
    await workspace.removeFile(owner, id, file.id);
    expect(await workspace.overview(owner, id)).toMatchObject({ notes: [], files: [], tasks: [{ status: 'done' }], canManage: true });
    await expect(workspace.openFile(owner, id, file.id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await service.list(org, { search: 'priya' })).items[0].followUp.status).toBe('none');
  });

  it('what the team attached survives a change of the row, and another organization never sees it', async () => {
    await seedBoard();
    const workspace = new CustomerWorkspaceService(connection, service, new GridFsService(connection));
    const owner = await person(org, 'Vasanth G', ['owner']);
    const before = (await service.list(org, { search: 'priya' })).items[0].id;
    await workspace.addNote(owner, before, 'Prefers WhatsApp.');
    await workspace.addTask(owner, before, { title: 'Send samples', dueDate: daysAgo(-2).toISOString() });
    const file = await workspace.addFile(owner, before, {
      originalname: 'po.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('po'),
    } as Express.Multer.File);

    // A new record under an address that sorts first, tied to her by phone: the row's id changes.
    await connection
      .collection('crm_deals')
      .insertOne(
        enquiry(
          org,
          gorilla,
          8,
          daysAgo(0.5),
          { first_name: 'Priya', last_name: 'Raman', email: 'accounts@sundar.example', number_e164: '+919840012345' },
          'Reorder',
        ),
      );
    service.invalidate(org);
    const after = (await service.list(org, { search: 'priya' })).items[0];
    expect(after.id).not.toBe(before);
    expect(after.followUp).toMatchObject({ status: 'upcoming', count: 1, nextTitle: 'Send samples' });
    expect(await workspace.overview(owner, after.id)).toMatchObject({
      notes: [{ body: 'Prefers WhatsApp.' }],
      tasks: [{ title: 'Send samples' }],
      files: [{ name: 'po.pdf' }],
    });
    await expect(workspace.overview(owner, before)).rejects.toBeInstanceOf(NotFoundException);

    // Another organization with the same customer address: its own board, none of this.
    const other = `${PREFIX}-other-${seq}`;
    const theirSource = await source(other, 'gorilladash', 'Gorilla Dash');
    await connection
      .collection('crm_deals')
      .insertOne(
        enquiry(
          other,
          theirSource,
          9,
          daysAgo(2),
          { first_name: 'Priya', last_name: 'Raman', email: 'priya@sundar.example', number_e164: '+919840012345' },
          'Their own lead',
        ),
      );
    const stranger = await person(other, 'Stranger', ['owner']);
    const theirs = (await service.list(other, {})).items[0];
    expect(theirs.followUp).toMatchObject({ status: 'none', count: 0 });
    expect(await workspace.overview(stranger, theirs.id)).toMatchObject({ notes: [], tasks: [], files: [], assignees: [{ name: 'Stranger' }] });
    await expect(workspace.openFile(stranger, theirs.id, file.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(workspace.removeFile(stranger, theirs.id, file.id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await service.detail(other, theirs.id)).timeline.map((e) => e.kind)).toEqual(['enquiry']);
  });

  it('a status set by hand shows on the board, moves the tiles and filters, is exported and logged — and can be handed back', async () => {
    await seedBoard();
    const workspace = new CustomerWorkspaceService(connection, service, new GridFsService(connection));
    const owner = await person(org, 'Vasanth G', ['owner']);
    const manager = await person(org, 'Sanjay', ['manager']);
    const id = (await service.list(org, { search: 'priya' })).items[0].id;
    const row = async () => (await service.list(org, { search: 'priya' })).items[0];
    const stage = async (key: string) => (await row()).stages.find((s) => s.key === key)!;

    // As the systems have it: part paid, a quotation out.
    expect(await service.list(org, {})).toMatchObject({ stats: { paymentPending: 1, quotePending: 1 } });
    expect((await service.detail(org, id)).statusOptions.payment.map((o) => [o.status, o.label, o.tone])).toEqual([
      ['paid', 'Paid', 'done'],
      ['partially_paid', 'Part paid', 'waiting'],
      ['unpaid', 'Unpaid', 'waiting'],
      ['overdue', 'Overdue', 'attention'],
    ]);

    // -- Payment set to Paid by hand
    expect(await workspace.setStatus(manager, id, 'payment', 'paid')).toEqual({ stage: 'payment', status: 'paid' });
    expect(await stage('payment')).toMatchObject({
      status: 'paid',
      label: 'Paid',
      tone: 'done',
      manual: { label: 'Paid', by: 'Sanjay', automatic: 'Part paid' },
    });
    expect((await stage('payment')).detail).toMatch(/^Set by Sanjay · \d{1,2} \w{3}$/);
    expect(await row()).toMatchObject({ flags: expect.not.arrayContaining(['payment_pending']), payment: { status: 'partially_paid', outstanding: 35000 } });
    expect((await row()).insight).toMatch(/^Set by your team: Payment — Paid\./);
    expect(await service.list(org, {})).toMatchObject({ stats: { paymentPending: 0, quotePending: 1 } });
    // The filters read what the board shows.
    expect((await service.list(org, { payment: 'paid' })).items.map((c) => c.name)).toEqual(['Priya Raman']);
    expect((await service.list(org, { payment: 'partially_paid' })).total).toBe(0);
    expect((await service.list(org, { view: 'payment_pending' })).total).toBe(0);

    // -- Quote accepted, the inquiry closed, an order in production: several steps at once
    await workspace.setStatus(owner, id, 'quote', 'accepted');
    await workspace.setStatus(owner, id, 'inquiry', 'converted');
    await workspace.setStatus(owner, id, 'order', 'in_production');
    const set = await row();
    expect(set.stages.map((s) => [s.key, s.label, !!s.manual])).toEqual([
      ['inquiry', 'Converted', true],
      ['quote', 'Accepted', true],
      ['order', 'Production', true],
      ['payment', 'Paid', true],
      ['email', 'No reply yet', false],
      ['followUp', 'No follow-up', false],
    ]);
    expect(set).toMatchObject({ inquiries: { open: false }, flags: expect.not.arrayContaining(['quote_pending']) });
    expect(await service.list(org, {})).toMatchObject({ stats: { quotePending: 0, openInquiries: 2 } });
    expect((await service.list(org, { quote: 'accepted' })).items.map((c) => c.name)).toEqual(['Priya Raman']);
    expect((await service.list(org, { quote: 'sent' })).total).toBe(0);

    // The export says the same, and which statuses were set by hand.
    const exported = (await service.export(org, { search: 'priya' })).split(/\r?\n/);
    expect(exported[0]).toContain('"Next step","Set by hand","Currency"');
    expect(exported[1]).toContain('"Converted","","Accepted","Q-2",120000,"Production",1,85000,"Paid",35000,"No reply yet","No follow-up"');
    expect(exported[1]).toContain('"Inquiry, Quote, Order, Payment","INR"');

    // The timeline tells who changed what; the AI is told what the team says, and its earlier reading is out of date.
    const titles = (await service.detail(org, id)).timeline.filter((e) => e.kind === 'status').map((e) => e.title);
    expect(titles).toEqual(
      expect.arrayContaining(['Payment set to Paid by Sanjay', 'Quote set to Accepted by Vasanth G', 'Order set to In production by Vasanth G']),
    );
    http.post.mockReturnValue(
      of({ data: { statusLabel: '', summary: 'S', nextAction: '', recommendations: [], issues: [], pricingAdvice: '', suggestedMessage: '' } }),
    );
    await service.analyze(owner, id, false);
    expect((http.post.mock.calls[0][1] as { setByTheTeam: unknown }).setByTheTeam).toEqual(
      expect.arrayContaining([{ step: 'Payment', status: 'Paid', systemsSay: 'Part paid' }]),
    );
    expect((await service.detail(org, id)).analysis).toMatchObject({ stale: false });
    await workspace.setStatus(owner, id, 'email', 'no_reply_needed');
    expect((await service.detail(org, id)).analysis).toMatchObject({ stale: true });
    expect((await service.list(org, { mail: 'no_reply_needed' })).items.map((c) => c.name)).toEqual(['Priya Raman']);

    // -- handed back to the systems, one step at a time
    await workspace.setStatus(manager, id, 'payment', null);
    expect(await stage('payment')).toMatchObject({ status: 'partially_paid', label: 'Part paid', detail: '₹35,000 due' });
    expect((await stage('payment')).manual).toBeUndefined();
    expect(await service.list(org, {})).toMatchObject({ stats: { paymentPending: 1 } });
    expect((await stage('quote')).manual).toBeDefined();
    expect((await service.detail(org, id)).timeline.map((e) => e.title)).toContain('Payment set back to automatic by Sanjay');
    // Handing back a step nobody set changes nothing.
    await expect(workspace.setStatus(manager, id, 'followUp', null)).resolves.toEqual({ stage: 'followUp', status: null });

    // -- only that step's own options, only a customer that exists
    await expect(workspace.setStatus(owner, id, 'payment', 'accepted')).rejects.toBeInstanceOf(BadRequestException);
    await expect(workspace.setStatus(owner, id, 'quote', 'banana')).rejects.toBeInstanceOf(BadRequestException);
    await expect(workspace.setStatus(owner, 'no-such-customer', 'quote', 'sent')).rejects.toBeInstanceOf(NotFoundException);
    expect(await connection.collection('customer_statuses').countDocuments({ organizationId: org })).toBe(1);
  });

  it('a hand-set status stays with the customer when the row changes, and never reaches another organization', async () => {
    await seedBoard();
    const workspace = new CustomerWorkspaceService(connection, service, new GridFsService(connection));
    const owner = await person(org, 'Vasanth G', ['owner']);
    const before = (await service.list(org, { search: 'priya' })).items[0].id;
    await workspace.setStatus(owner, before, 'payment', 'paid');
    await workspace.setStatus(owner, before, 'followUp', 'not_needed');

    // A new record under an address that sorts first, tied to her by phone: the row's id changes.
    await connection
      .collection('crm_deals')
      .insertOne(
        enquiry(
          org,
          gorilla,
          8,
          daysAgo(0.5),
          { first_name: 'Priya', last_name: 'Raman', email: 'accounts@sundar.example', number_e164: '+919840012345' },
          'Reorder',
        ),
      );
    service.invalidate(org);
    const after = (await service.list(org, { search: 'priya' })).items[0];
    expect(after.id).not.toBe(before);
    expect(after.stages.filter((s) => s.manual).map((s) => [s.key, s.label])).toEqual([
      ['payment', 'Paid'],
      ['followUp', 'Not needed'],
    ]);
    // "Not needed" quietens the chase the systems would suggest for her open quotation.
    expect(after.flags).not.toContain('follow_up_required');
    // Changed again under the new row: still one record, now holding both sets of keys.
    await workspace.setStatus(owner, after.id, 'payment', 'overdue');
    expect((await service.list(org, { search: 'priya' })).items[0]).toMatchObject({
      flags: expect.arrayContaining(['payment_overdue']),
      nextAction: { title: 'Request payment — overdue' },
    });
    expect(await connection.collection('customer_statuses').countDocuments({ organizationId: org })).toBe(1);

    // Another organization with the same customer address sees only what its own systems say.
    const other = `${PREFIX}-other-${seq}`;
    const theirSource = await source(other, 'gorilladash', 'Gorilla Dash');
    await connection
      .collection('crm_deals')
      .insertOne(
        enquiry(
          other,
          theirSource,
          9,
          daysAgo(2),
          { first_name: 'Priya', last_name: 'Raman', email: 'priya@sundar.example', number_e164: '+919840012345' },
          'Their own lead',
        ),
      );
    const stranger = await person(other, 'Stranger', ['owner']);
    const theirs = (await service.list(other, {})).items[0];
    expect(theirs.stages.some((s) => s.manual)).toBe(false);
    await workspace.setStatus(stranger, theirs.id, 'inquiry', 'not_interested');
    expect((await service.list(other, {})).items[0].stages[0]).toMatchObject({ label: 'No interest', manual: { by: 'Stranger' } });
    // …and what they set never shows for the first organization.
    expect((await service.list(org, { search: 'priya' })).items[0].stages[0].manual).toBeUndefined();
  });
});
