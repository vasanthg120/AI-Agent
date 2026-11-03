import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection } from 'mongoose';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { CustomerDirectoryService } from './customer-directory.service';
import { CustomerJobsService } from './customer-jobs.service';
import { CustomerMailService } from './customer-mail.service';
import { CustomerWorkspaceService } from './customer-workspace.service';
import { ITEM_STATUSES, JOB_STATUS_COLUMNS, JOB_VIEWS, jobStatusChips, PROOF_STATUSES, PURCHASE_ORDER_STATUSES, SHIPMENT_STATUSES } from './job-statuses';

const PREFIX = `jest-jobs-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

describe('a job’s statuses', () => {
  it('seven columns, each with its own short list, every option fitting a chip', () => {
    expect(JOB_STATUS_COLUMNS.map((column) => [column.title, column.options.map((o) => o.label)])).toEqual([
      ['Production', ['In house', 'Outsourced', 'Not started']],
      ['Payment', ['Waiting for payment', 'Waiting for remittance', 'Payment received']],
      ['Purchasing', ['Need to order', 'Ready to order', 'Ordered', 'Received', 'BYO']],
      ['Order type', ['Normal', 'Priority', 'Rush']],
      ['Artwork', ['Awaiting artwork approval', 'Artwork approved', 'Order completed']],
      ['Progress', ['In progress', 'Done']],
      ['Prod ready', ['Not ready yet', 'Production ready']],
    ]);
    const lists = [...JOB_STATUS_COLUMNS.map((column) => column.options), ITEM_STATUSES, PURCHASE_ORDER_STATUSES, PROOF_STATUSES, SHIPMENT_STATUSES];
    for (const options of lists) {
      for (const o of options) expect((o.short ?? o.label).length).toBeLessThanOrEqual(17);
      // No two options of a list share a value.
      expect(new Set(options.map((o) => o.status)).size).toBe(options.length);
    }
    for (const o of JOB_STATUS_COLUMNS.flatMap((column) => column.options)) expect((o.short ?? o.label).length).toBeLessThanOrEqual(12);
  });

  it('a status nobody set is shown as not set — never guessed', () => {
    expect(jobStatusChips(undefined).map((chip) => [chip.key, chip.status, chip.label, chip.tone])).toEqual(
      JOB_STATUS_COLUMNS.map((column) => [column.key, '', 'Not set', 'none']),
    );
    const chips = jobStatusChips({ payment: 'waiting_payment', progress: 'done', artwork: 'something the list no longer has' });
    expect(chips.find((chip) => chip.key === 'payment')).toMatchObject({ label: 'Awaiting pay', full: 'Waiting for payment', tone: 'waiting' });
    expect(chips.find((chip) => chip.key === 'progress')).toMatchObject({ label: 'Done', tone: 'done' });
    expect(chips.find((chip) => chip.key === 'artwork')).toMatchObject({ status: '', label: 'Not set' });
  });

  it('the quick views: a job that is done is in none of the waiting ones', () => {
    const job = (statuses: Record<string, string>, overdue = false) => ({ statuses, overdue, done: statuses.progress === 'done' });
    const views = (j: ReturnType<typeof job>) => Object.keys(JOB_VIEWS).filter((view) => JOB_VIEWS[view](j));
    expect(views(job({}))).toEqual(['all', 'active']);
    expect(views(job({ payment: 'waiting_remittance', artwork: 'awaiting_approval', purchasing: 'ready_to_order' }, true))).toEqual([
      'all',
      'active',
      'overdue',
      'awaiting_payment',
      'awaiting_artwork',
      'to_order',
    ]);
    expect(views(job({ payment: 'waiting_payment', artwork: 'awaiting_approval', purchasing: 'need_to_order', progress: 'done' }))).toEqual(['all', 'done']);
  });
});

// Against a real Mongo: a quotation becomes a job once, the job keeps what the
// quotation said, its statuses are the team's own, what is attached to it is
// the customer's, and nothing crosses organizations.
describe('Jobs (real Mongo)', () => {
  let connection: Connection;
  let directory: CustomerDirectoryService;
  let workspace: CustomerWorkspaceService;
  let jobs: CustomerJobsService;
  let seq = 0;
  let org: string;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({ imports: [MongooseModule.forRoot(uri)] }).compile();
    connection = moduleRef.get(getConnectionToken());
  });

  const services = () => {
    const d = new CustomerDirectoryService(
      connection,
      new CustomerMailService(connection),
      { syncNow: jest.fn() } as never,
      { reserve: jest.fn(), settle: jest.fn(), release: jest.fn(), resolveTenantKey: (o: string) => o } as never,
      { post: jest.fn() } as never,
      { sign: () => 'jwt' } as never,
      { get: () => 'http://agent' } as never,
    );
    const w = new CustomerWorkspaceService(connection, d, new GridFsService(connection));
    return { directory: d, workspace: w, jobs: new CustomerJobsService(connection, d, w) };
  };

  beforeEach(async () => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    ({ directory, workspace, jobs } = services());
    await jobs.onModuleInit();
  });

  afterAll(async () => {
    for (const name of ['crm_data_sources', 'crm_deals', 'crm_quotes', 'customer_notes', 'customer_tasks', 'customer_jobs', 'customer_job_counters', 'users']) {
      await connection.collection(name).deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    }
    const files = await connection
      .collection('customer_files.files')
      .find({ 'metadata.organizationId': { $regex: `^${PREFIX}` } }, { projection: { _id: 1 } })
      .toArray();
    await connection.collection('customer_files.chunks').deleteMany({ files_id: { $in: files.map((f) => f._id) } });
    await connection.collection('customer_files.files').deleteMany({ _id: { $in: files.map((f) => f._id) } });
    await connection.close();
  });

  const person = async (organizationId: string, name: string, roles: string[]) => {
    const id = (
      await connection
        .collection('users')
        .insertOne({ organizationId, name, email: `${PREFIX}-${seq}-${name.toLowerCase().replace(/\W/g, '')}@example.test`, roles, active: true })
    ).insertedId.toString();
    return { sub: id, organizationId, email: 'x', roles } as never;
  };

  // Priya (Sundar Textiles): a deal with two product lines and two quotations raised from it. Arun: one quotation of his own.
  const seed = async (organizationId = org) => {
    const source = (
      await connection
        .collection('crm_data_sources')
        .insertOne({ organizationId, key: 'prospectconnect', provider: 'prospectconnect', label: 'Pantheras CRM', status: 'active' })
    ).insertedId.toString();
    const deal = (
      await connection.collection('crm_deals').insertOne({
        organizationId,
        dataSourceId: source,
        externalId: 'd1',
        name: 'Sundar Textiles - Polos',
        dealStatus: 'won',
        monetaryValue: 120000,
        createdAt: daysAgo(30),
        products: [
          { name: 'Polo t-shirt, navy', description: '220 GSM, embroidered logo', quantity: 250, unitPrice: 400, total: 100000 },
          { name: 'Cap', quantity: 10, unitPrice: 169.5, total: 1695 },
        ],
      })
    ).insertedId.toString();
    const quote = (number: string, amount: number, created: Date, client: Record<string, string>, more: Record<string, unknown> = {}) => ({
      organizationId,
      dataSourceId: source,
      quoteNumber: number,
      quoteName: `Order ${number}`,
      quoteAmount: amount,
      currency: 'INR',
      quoteStatus: 'published',
      clientApprovalStatus: 'approved',
      clientDetails: client,
      quoteOwnerLabel: 'Sanjay Kumar',
      createdAt: created,
      ...more,
    });
    const priya = { email: 'priya@sundar.example', companyName: 'Sundar Textiles', contactName: 'Priya Raman', phone: '+919840012345' };
    const quotes = connection.collection('crm_quotes');
    const q1 = (await quotes.insertOne(quote('Q-1', 85000, daysAgo(20), priya, { dealId: deal }))).insertedId.toString();
    const q2 = (
      await quotes.insertOne(quote('Q-2', 120000, daysAgo(5), priya, { dealId: deal, taxes: [{ name: 'GST 18%', amount: 18305 }], fees: [] }))
    ).insertedId.toString();
    const q9 = (
      await quotes.insertOne(quote('Q-9', 30000, daysAgo(3), { email: 'arun@kovai.example', companyName: 'Kovai Mills', contactName: 'Arun' }))
    ).insertedId.toString();
    const customers = await (organizationId === org ? directory : services().directory).list(organizationId, {});
    const idOf = (name: string) => customers.items.find((c) => `${c.name} ${c.company ?? ''}`.toLowerCase().includes(name))!.id;
    return { priya: idOf('priya'), arun: idOf('arun'), q1, q2, q9 };
  };

  it('Convert to job: the quotation’s customer, owner, amount and items are copied, it gets the next number, and it happens once', async () => {
    const { priya, arun, q1, q2, q9 } = await seed();
    const manager = await person(org, 'Sanjay', ['manager']);

    const { job, created } = await jobs.convert(manager, priya, q2);
    expect(created).toBe(true);
    expect(job).toMatchObject({
      number: 'J-0001',
      title: 'Sundar Textiles',
      quotationId: q2,
      quotationNumber: 'Q-2',
      quotationSource: 'Pantheras CRM',
      owner: 'Sanjay Kumar',
      amount: 120000,
      currency: 'INR',
      done: false,
      overdue: false,
      customer: { id: priya, company: 'Sundar Textiles' },
      contact: { company: 'Sundar Textiles', contact: 'Priya Raman', email: 'priya@sundar.example' },
      items: [
        {
          name: 'Polo t-shirt, navy',
          description: '220 GSM, embroidered logo',
          quantity: 250,
          unitPrice: 400,
          total: 100000,
          status: 'not_started',
          label: 'Not started',
        },
        { name: 'Cap', quantity: 10, total: 1695, status: 'not_started' },
      ],
      subtotal: 101695,
      charges: [{ kind: 'tax', name: 'GST 18%', amount: 18305 }],
      purchaseOrders: [],
      shipments: [],
      history: [{ by: 'Sanjay', text: 'Job created from quotation Q-2' }],
      createdBy: 'Sanjay',
      canManage: false,
    });
    // Every status starts empty: nobody has said anything yet.
    expect(job.statuses.map((chip) => chip.label)).toEqual(Array(7).fill('Not set'));
    expect(job.options.columns).toHaveLength(7);

    // Asking again — by anyone — gives the job it already is, and uses up no number.
    const again = await jobs.convert(await person(org, 'Vasanth G', ['owner']), priya, q2);
    expect(again).toMatchObject({ created: false, job: { id: job.id, number: 'J-0001', canManage: true } });
    expect((await jobs.convert(manager, priya, q1)).job).toMatchObject({ number: 'J-0002', quotationNumber: 'Q-1', amount: 85000 });
    expect((await jobs.convert(manager, arun, q9)).job).toMatchObject({
      number: 'J-0003',
      title: 'Kovai Mills',
      items: [],
      subtotal: null,
      customer: { id: arun },
    });
    expect(await connection.collection('customer_jobs').countDocuments({ organizationId: org })).toBe(3);

    // Two people pressing the button in the same moment still make one job.
    await connection.collection('customer_jobs').deleteMany({ organizationId: org, quotationId: q9 });
    directory.invalidate(org);
    const both = await Promise.all([jobs.convert(manager, arun, q9), jobs.convert(manager, arun, q9)]);
    expect(new Set(both.map((made) => made.job.id)).size).toBe(1);
    expect(await connection.collection('customer_jobs').countDocuments({ organizationId: org, quotationId: q9 })).toBe(1);

    // A quotation can only be converted on its own customer; one that doesn't exist, not at all.
    await expect(jobs.convert(manager, arun, q1)).rejects.toBeInstanceOf(NotFoundException);
    await expect(jobs.convert(manager, priya, '000000000000000000000000')).rejects.toBeInstanceOf(NotFoundException);
    await expect(jobs.convert(manager, 'no-such-customer', q1)).rejects.toBeInstanceOf(NotFoundException);
    // Nothing was written to the CRM's own records.
    expect(
      await connection.collection('crm_quotes').countDocuments({ organizationId: org, $or: [{ jobId: { $exists: true } }, { job: { $exists: true } }] }),
    ).toBe(0);
  });

  it('the board: seven statuses set by hand, due dates, quick views, search, filters and sorting', async () => {
    const { priya, arun, q1, q2, q9 } = await seed();
    const manager = await person(org, 'Sanjay', ['manager']);
    const first = (await jobs.convert(manager, priya, q1)).job.id;
    const second = (await jobs.convert(manager, priya, q2)).job.id;
    const third = (await jobs.convert(manager, arun, q9)).job.id;

    // Newest first, and what a row needs — no items, no history.
    let board = await jobs.list(org);
    expect(board.items.map((row) => row.number)).toEqual(['J-0003', 'J-0002', 'J-0001']);
    expect(board).toMatchObject({ total: 3, page: 1, owners: ['Sanjay Kumar'], stats: { all: 3, active: 3, overdue: 0, awaiting_payment: 0, done: 0 } });
    expect(board.items[0]).not.toHaveProperty('items');
    expect(board.items[0]).not.toHaveProperty('history');

    // Setting a status: one of its column's options, and it is written down who did it.
    const set = await jobs.setStatus(manager, first, 'payment', 'waiting_payment');
    expect(set.statuses.find((chip) => chip.key === 'payment')).toMatchObject({
      status: 'waiting_payment',
      label: 'Awaiting pay',
      full: 'Waiting for payment',
      tone: 'waiting',
    });
    expect(set.history[0]).toMatchObject({ by: 'Sanjay', text: 'Payment set to Waiting for payment' });
    await expect(jobs.setStatus(manager, first, 'payment', 'in_house')).rejects.toBeInstanceOf(BadRequestException);
    await expect(jobs.setStatus(manager, first, 'nonsense' as never, 'x')).rejects.toBeInstanceOf(BadRequestException);
    await expect(jobs.setStatus(manager, '000000000000000000000000', 'payment', 'received')).rejects.toBeInstanceOf(NotFoundException);
    await jobs.setStatus(manager, first, 'purchasing', 'need_to_order');
    await jobs.setStatus(manager, second, 'artwork', 'awaiting_approval');
    await jobs.setStatus(manager, second, 'production', 'in_house');
    await jobs.setStatus(manager, third, 'payment', 'waiting_remittance');
    await jobs.setStatus(manager, third, 'progress', 'done');

    // A due date that has passed makes a job overdue — unless it is done.
    expect(await jobs.update(manager, first, { dueDate: daysAgo(2).toISOString() })).toMatchObject({ overdue: true });
    expect(await jobs.update(manager, second, { dueDate: daysAgo(-4).toISOString(), title: '  Sundar — annual day polos ' })).toMatchObject({
      overdue: false,
      title: 'Sundar — annual day polos',
    });
    expect(await jobs.update(manager, third, { dueDate: daysAgo(2).toISOString() })).toMatchObject({ overdue: false, done: true });
    await expect(jobs.update(manager, first, {})).rejects.toBeInstanceOf(BadRequestException);

    board = await jobs.list(org);
    expect(board.stats).toEqual({ all: 3, active: 2, overdue: 1, awaiting_payment: 1, awaiting_artwork: 1, to_order: 1, done: 1 });
    const numbers = async (query: Parameters<typeof jobs.list>[1]) => (await jobs.list(org, query)).items.map((row) => row.number);
    expect(await numbers({ view: 'active' })).toEqual(['J-0002', 'J-0001']);
    expect(await numbers({ view: 'overdue' })).toEqual(['J-0001']);
    expect(await numbers({ view: 'awaiting_payment' })).toEqual(['J-0001']);
    expect(await numbers({ view: 'awaiting_artwork' })).toEqual(['J-0002']);
    expect(await numbers({ view: 'to_order' })).toEqual(['J-0001']);
    expect(await numbers({ view: 'done' })).toEqual(['J-0003']);
    // The column filters: an option, or "not set".
    expect(await numbers({ statuses: { payment: 'waiting_remittance' } })).toEqual(['J-0003']);
    expect(await numbers({ statuses: { production: 'unset' } })).toEqual(['J-0003', 'J-0001']);
    expect(await numbers({ statuses: { production: 'in_house', artwork: 'awaiting_approval' } })).toEqual(['J-0002']);
    // Search: the job, the quotation, the customer, the name the team gave it.
    expect(await numbers({ search: 'kovai' })).toEqual(['J-0003']);
    expect(await numbers({ search: 'q-1' })).toEqual(['J-0001']);
    expect(await numbers({ search: 'annual polos' })).toEqual(['J-0002']);
    expect(await numbers({ search: 'J-0002' })).toEqual(['J-0002']);
    expect(await numbers({ owner: 'Somebody else' })).toEqual([]);
    // Sorting; a job with no due date would come last either way.
    expect(await numbers({ sort: 'number', direction: 'asc' })).toEqual(['J-0001', 'J-0002', 'J-0003']);
    expect(await numbers({ sort: 'amount', direction: 'desc' })).toEqual(['J-0002', 'J-0001', 'J-0003']);
    await jobs.update(manager, third, { dueDate: null });
    expect(await numbers({ sort: 'due', direction: 'asc' })).toEqual(['J-0001', 'J-0002', 'J-0003']);
    expect(await numbers({ sort: 'due', direction: 'desc' })).toEqual(['J-0002', 'J-0001', 'J-0003']);
    expect(await jobs.list(org, { pageSize: 2, page: 2 })).toMatchObject({ total: 3, page: 2, pageSize: 2, items: [{ number: 'J-0001' }] });

    // Back to not set.
    const cleared = await jobs.setStatus(manager, first, 'payment', null);
    expect(cleared.statuses.find((chip) => chip.key === 'payment')).toMatchObject({ status: '', label: 'Not set' });
    expect(cleared.history[0].text).toBe('Payment cleared');
    expect(cleared.history.map((event) => event.text)).toEqual(
      expect.arrayContaining([
        'Purchasing set to Need to order',
        'Job created from quotation Q-1',
        expect.stringMatching(/^Due date set to \d{1,2} \w{3} \d{4}$/),
      ]),
    );
  });

  it('items, purchase orders and shipping', async () => {
    const { priya, q2 } = await seed();
    const manager = await person(org, 'Sanjay', ['manager']);
    const id = (await jobs.convert(manager, priya, q2)).job.id;

    // -- each item has a status of its own
    const marked = await jobs.setItemStatus(manager, id, 1, 'done');
    expect(marked.items.map((item) => [item.name, item.label])).toEqual([
      ['Polo t-shirt, navy', 'Not started'],
      ['Cap', 'Done'],
    ]);
    expect(marked.history[0].text).toBe('“Cap” marked Done');
    await expect(jobs.setItemStatus(manager, id, 2, 'done')).rejects.toBeInstanceOf(NotFoundException);
    await expect(jobs.setItemStatus(manager, id, -1, 'done')).rejects.toBeInstanceOf(NotFoundException);
    await expect(jobs.setItemStatus(manager, id, 0, 'finished')).rejects.toBeInstanceOf(BadRequestException);

    // -- purchase orders: what has to be bought for the job
    await expect(jobs.addPurchaseOrder(manager, id, { vendor: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    let job = await jobs.addPurchaseOrder(manager, id, { vendor: ' Tiruppur Knits ', description: '250 navy polos, blank', amount: 62500, reference: 'PO-77' });
    const order = job.purchaseOrders[0];
    expect(order).toMatchObject({
      vendor: 'Tiruppur Knits',
      description: '250 navy polos, blank',
      amount: 62500,
      reference: 'PO-77',
      status: 'to_order',
      label: 'To order',
      addedBy: 'Sanjay',
    });
    expect(order.orderedAt).toBeUndefined();
    expect(job.history[0].text).toBe('Purchase order added — Tiruppur Knits');
    // Marked as ordered with no date given: it was ordered today. A date that is given is kept.
    job = await jobs.updatePurchaseOrder(manager, id, order.id, { status: 'ordered', expectedAt: daysAgo(-6).toISOString() });
    expect(job.purchaseOrders[0]).toMatchObject({ status: 'ordered', label: 'Ordered', tone: 'progress' });
    expect(Date.now() - job.purchaseOrders[0].orderedAt!.getTime()).toBeLessThan(60_000);
    expect(job.purchaseOrders[0].expectedAt).toBeInstanceOf(Date);
    expect(job.history[0].text).toBe('Purchase order ordered — Tiruppur Knits');
    job = await jobs.updatePurchaseOrder(manager, id, order.id, { status: 'received', receivedAt: daysAgo(1).toISOString(), reference: null, amount: null });
    expect(job.purchaseOrders[0]).toMatchObject({ status: 'received', reference: undefined, amount: undefined });
    expect(Date.now() - job.purchaseOrders[0].receivedAt!.getTime()).toBeGreaterThan(DAY - 60_000);
    expect((await jobs.updatePurchaseOrder(manager, id, order.id, { vendor: 'Tiruppur Knits Ltd' })).history[0].text).toBe(
      'Purchase order changed — Tiruppur Knits Ltd',
    );
    await expect(jobs.updatePurchaseOrder(manager, id, order.id, {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(jobs.updatePurchaseOrder(manager, id, order.id, { vendor: ' ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(jobs.updatePurchaseOrder(manager, id, order.id, { status: 'lost' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(jobs.updatePurchaseOrder(manager, id, 'no-such-order', { status: 'ordered' })).rejects.toBeInstanceOf(NotFoundException);
    const second = (await jobs.addPurchaseOrder(manager, id, { vendor: 'Thread House', status: 'ordered' })).purchaseOrders[1];
    expect(second.orderedAt).toBeInstanceOf(Date);
    job = await jobs.removePurchaseOrder(manager, id, order.id);
    expect(job.purchaseOrders.map((o) => o.vendor)).toEqual(['Thread House']);
    expect(job.history[0].text).toBe('Purchase order removed — Tiruppur Knits Ltd');
    await expect(jobs.removePurchaseOrder(manager, id, order.id)).rejects.toBeInstanceOf(NotFoundException);

    // -- shipping
    await expect(jobs.addShipment(manager, id, { carrier: '' })).rejects.toBeInstanceOf(BadRequestException);
    job = await jobs.addShipment(manager, id, { carrier: 'Blue Dart', trackingNumber: 'BD123456' });
    const shipment = job.shipments[0];
    expect(shipment).toMatchObject({ carrier: 'Blue Dart', trackingNumber: 'BD123456', status: 'not_shipped', label: 'Not shipped' });
    expect(shipment.shippedAt).toBeUndefined();
    job = await jobs.updateShipment(manager, id, shipment.id, { status: 'shipped', note: 'Two cartons' });
    expect(job.shipments[0]).toMatchObject({ status: 'shipped', note: 'Two cartons' });
    expect(job.shipments[0].shippedAt).toBeInstanceOf(Date);
    expect(job.history[0].text).toBe('Shipment shipped — Blue Dart');
    job = await jobs.updateShipment(manager, id, shipment.id, { status: 'delivered', trackingNumber: null });
    expect(job.shipments[0]).toMatchObject({ status: 'delivered', tone: 'done', trackingNumber: undefined });
    expect(job.shipments[0].deliveredAt).toBeInstanceOf(Date);
    expect((await jobs.removeShipment(manager, id, shipment.id)).shipments).toEqual([]);
  });

  it('comments, tasks, files and proofs of a job are its customer’s own, tagged with the job', async () => {
    const { priya, arun, q1, q2, q9 } = await seed();
    const owner = await person(org, 'Vasanth G', ['owner']);
    const manager = await person(org, 'Sanjay', ['manager']);
    const id = (await jobs.convert(manager, priya, q2)).job.id;
    const other = (await jobs.convert(manager, priya, q1)).job.id;
    const aruns = (await jobs.convert(manager, arun, q9)).job.id;
    const upload = (name: string, body = 'artwork bytes') =>
      ({ originalname: name, mimetype: 'application/pdf', buffer: Buffer.from(body) }) as Express.Multer.File;

    const general = await workspace.addNote(owner, priya, 'Prefers WhatsApp.');
    const note = await jobs.addNote(manager, id, ' Logo on the left chest. ');
    expect(note).toMatchObject({ body: 'Logo on the left chest.', author: 'Sanjay', jobId: id });
    const task = await jobs.addTask(manager, id, { title: 'Order the blanks', dueDate: daysAgo(1).toISOString() });
    expect(task).toMatchObject({ status: 'open', overdue: true, jobId: id });
    const file = await jobs.addFile(manager, id, upload('size-chart.pdf'));
    expect(file).toMatchObject({ name: 'size-chart.pdf', kind: 'file', jobId: id });
    const proof = await jobs.addFile(manager, id, upload('proof v1.pdf', 'proof bytes'), 'proof');
    expect(proof).toMatchObject({ kind: 'proof', proofStatus: 'awaiting', jobId: id });
    await expect(jobs.addFile(manager, id, upload('run.exe'), 'proof')).rejects.toBeInstanceOf(BadRequestException);

    // -- the job shows what is its own, and only that
    const mine = await jobs.workspaceOf(manager, id);
    expect(mine).toMatchObject({ notes: [{ id: note.id }], tasks: [{ id: task.id }], linkedTasks: [], canManage: false });
    expect(mine.notes).toHaveLength(1);
    expect(mine.files.map((f) => [f.name, f.kind, f.proofStatus])).toEqual([
      ['proof v1.pdf', 'proof', 'awaiting'],
      ['size-chart.pdf', 'file', undefined],
    ]);
    expect(await jobs.workspaceOf(manager, other)).toMatchObject({ notes: [], tasks: [], files: [] });
    expect(await jobs.workspaceOf(manager, aruns)).toMatchObject({ notes: [], tasks: [], files: [] });

    // -- the customer shows everything, saying which job each thing belongs to
    const customer = await workspace.overview(owner, priya);
    expect(customer.notes.map((n) => [n.body, n.jobNumber])).toEqual([
      ['Logo on the left chest.', 'J-0001'],
      ['Prefers WhatsApp.', undefined],
    ]);
    expect(customer.tasks).toMatchObject([{ title: 'Order the blanks', jobNumber: 'J-0001' }]);
    expect(customer.files.map((f) => [f.name, f.jobNumber, f.kind])).toEqual([
      ['proof v1.pdf', 'J-0001', 'proof'],
      ['size-chart.pdf', 'J-0001', 'file'],
    ]);
    expect((await workspace.overview(owner, arun)).notes).toEqual([]);
    // A job's task that is due is a follow-up on its customer.
    expect((await directory.list(org, { search: 'priya' })).items[0]).toMatchObject({
      followUp: { status: 'overdue', count: 1, nextTitle: 'Order the blanks' },
    });

    // -- a proof: awaiting approval, approved, or changes needed with what to change
    expect(await jobs.setProof(manager, id, proof.id, 'changes', ' Logo is too small ')).toMatchObject({
      proofStatus: 'changes',
      proofNote: 'Logo is too small',
    });
    const approved = await jobs.setProof(owner, id, proof.id, 'approved');
    expect(approved).toMatchObject({ kind: 'proof', proofStatus: 'approved' });
    expect(approved.proofNote).toBeUndefined();
    const stored = (await jobs.workspaceOf(manager, id)).files[0];
    expect([stored.proofStatus, stored.proofNote]).toEqual(['approved', undefined]);
    await expect(jobs.setProof(manager, id, proof.id, 'printed')).rejects.toBeInstanceOf(BadRequestException);
    // An ordinary file is not a proof; and one job can't reach into another.
    await expect(jobs.setProof(manager, id, file.id, 'approved')).rejects.toBeInstanceOf(NotFoundException);
    await expect(jobs.setProof(manager, other, proof.id, 'approved')).rejects.toBeInstanceOf(NotFoundException);
    await expect(jobs.openFile(manager, other, proof.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(jobs.removeNote(manager, other, note.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(jobs.updateTask(manager, aruns, task.id, { status: 'done' })).rejects.toBeInstanceOf(NotFoundException);
    const opened = await jobs.openFile(owner, id, proof.id);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream as AsyncIterable<Buffer>) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('proof bytes');

    // -- done from the job, gone from the customer's follow-ups
    expect(await jobs.updateTask(owner, id, task.id, { status: 'done' })).toMatchObject({ status: 'done', overdue: false });
    expect((await directory.list(org, { search: 'priya' })).items[0].followUp.status).toBe('none');

    // -- only who added something, or an owner/admin, removes it — and the job's history tells all of it
    await expect(jobs.removeNote(await person(org, 'Meera', ['manager']), id, note.id)).rejects.toBeInstanceOf(ForbiddenException);
    await jobs.removeNote(manager, id, note.id);
    await jobs.removeFile(owner, id, file.id);
    await jobs.removeFile(owner, id, proof.id);
    await jobs.removeTask(manager, id, task.id);
    expect(await jobs.workspaceOf(manager, id)).toMatchObject({ notes: [], tasks: [], files: [] });
    expect((await workspace.overview(owner, priya)).notes.map((n) => n.id)).toEqual([general.id]);
    expect((await jobs.detail(manager, id)).history.map((event) => `${event.by}: ${event.text}`).reverse()).toEqual([
      'Sanjay: Job created from quotation Q-2',
      'Sanjay: Comment added',
      'Sanjay: Task added — Order the blanks',
      'Sanjay: File attached — size-chart.pdf',
      'Sanjay: Proof uploaded — proof v1.pdf',
      'Sanjay: Changes needed on proof — proof v1.pdf',
      'Vasanth G: Proof approved — proof v1.pdf',
      'Vasanth G: Task done — Order the blanks',
      'Sanjay: Comment deleted',
      'Vasanth G: File deleted — size-chart.pdf',
      'Vasanth G: Proof deleted — proof v1.pdf',
      'Sanjay: Task deleted',
    ]);
  });

  it('on the customer: a tag on the row, a step in the journey, the quotation knows its job, and the activity says so', async () => {
    const { priya, q1, q2 } = await seed();
    const manager = await person(org, 'Sanjay', ['manager']);
    expect((await directory.list(org, { search: 'priya' })).items[0].jobs).toEqual([]);
    const job = (await jobs.convert(manager, priya, q2)).job;

    // Straight away — no waiting for the board to refresh itself.
    expect((await directory.list(org, { search: 'priya' })).items[0].jobs).toEqual([{ id: job.id, number: 'J-0001' }]);
    expect((await directory.list(org, { search: 'arun' })).items[0].jobs).toEqual([]);
    let detail = await directory.detail(org, priya);
    expect(detail.documents.find((d) => d.id === q2)).toMatchObject({ kind: 'quotation', job: { id: job.id, number: 'J-0001' } });
    expect(detail.documents.find((d) => d.id === q1)!.job).toBeUndefined();
    const steps = () => detail.journeys.flatMap((journey) => journey.steps);
    const at = steps().findIndex((step) => step.kind === 'job');
    expect(steps()[at]).toMatchObject({ kind: 'job', title: 'Job J-0001', detail: 'In progress', tone: 'progress', jobId: job.id });
    // Right after the quotation it was made from.
    expect(steps()[at - 1]).toMatchObject({ kind: 'quotation', documentId: q2 });
    expect(detail.timeline).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'job', title: 'Job J-0001 created by Sanjay', detail: 'From quotation Q-2' })]),
    );

    await jobs.setStatus(manager, job.id, 'progress', 'done');
    detail = await directory.detail(org, priya);
    expect(steps().find((step) => step.kind === 'job')).toMatchObject({ detail: 'Done', tone: 'done' });
  });

  it('deleting a job is for owners and administrators; and no organization sees another’s jobs', async () => {
    const { priya, q2 } = await seed();
    const owner = await person(org, 'Vasanth G', ['owner']);
    const manager = await person(org, 'Sanjay', ['manager']);
    const id = (await jobs.convert(manager, priya, q2)).job.id;
    const note = await jobs.addNote(manager, id, 'Rush this one.');

    // -- another organization, with the very same customer and quotation numbers
    const elsewhere = `${org}-other`;
    const theirs = await seed(elsewhere);
    const outsider = await person(elsewhere, 'Outsider', ['owner']);
    expect(await jobs.list(elsewhere)).toMatchObject({ total: 0, items: [], stats: { all: 0 } });
    await expect(jobs.detail(outsider, id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(jobs.setStatus(outsider, id, 'progress', 'done')).rejects.toBeInstanceOf(NotFoundException);
    await expect(jobs.addNote(outsider, id, 'x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(jobs.addPurchaseOrder(outsider, id, { vendor: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(jobs.workspaceOf(outsider, id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(jobs.remove(outsider, id)).rejects.toBeInstanceOf(NotFoundException);
    // Our quotation can't be converted from there; theirs starts its own numbering.
    await expect(jobs.convert(outsider, theirs.priya, q2)).rejects.toBeInstanceOf(NotFoundException);
    expect((await jobs.convert(outsider, theirs.priya, theirs.q2)).job).toMatchObject({ number: 'J-0001' });
    expect((await jobs.list(org)).total).toBe(1);

    // -- deleting
    await expect(jobs.remove(manager, id)).rejects.toBeInstanceOf(ForbiddenException);
    await jobs.remove(owner, id);
    await expect(jobs.detail(owner, id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(jobs.remove(owner, id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await jobs.list(org)).total).toBe(0);
    expect((await directory.list(org, { search: 'priya' })).items[0].jobs).toEqual([]);
    // What was written on the job stays with the customer, no longer tagged.
    const kept = (await workspace.overview(owner, priya)).notes;
    expect(kept).toMatchObject([{ id: note.id, body: 'Rush this one.' }]);
    expect(kept[0].jobNumber).toBeUndefined();
    // The quotation can become a job again; a number is never handed out twice.
    expect(await jobs.convert(manager, priya, q2)).toMatchObject({ created: true, job: { number: 'J-0002' } });
  });
});
