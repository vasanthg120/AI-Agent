// LIVE check of the AI side of the EOD, against a REAL python-agent route and the REAL
// Anthropic API (no mocks of the AI): NestJS -> HTTP -> FastAPI /work/eod-summary.
//
// Runs only when LIVE_AI_URL is set (e.g. http://127.0.0.1:8011) and a local MongoDB answers;
// otherwise it is skipped, so the normal suite never spends tokens. Billing is stubbed because
// the throwaway organization has no wallet; everything else is real. Summaries are printed so
// a human can read exactly what the model wrote.

import { HttpService } from '@nestjs/axios';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Connection, Types } from 'mongoose';

const LIVE = process.env.LIVE_AI_URL;
const TEST_DB = `haive_workauto_liveai_${process.pid}`;
const baseUri = (process.env.MONGO_URI ?? 'mongodb://localhost:27017/agent').replace(/\/[^/?]*(\?.*)?$/, '');
const COMPLETION_WORDS = /\b(completed|complete|finished|resolved|wrapped up|accomplished|closed out|got done|was done|were done)\b/i;
const JUDGEMENT_WORDS = /\b(unproductive|idle|lazy|underperform\w*|slacking|poor performance|low productivity)\b/i;

(LIVE ? describe : describe.skip)('EOD AI summary (live python-agent + Anthropic)', () => {
  let app: INestApplication;
  let conn: Connection;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let eod: any;
  let sanjay: string;
  let idle: string;
  const org = new Types.ObjectId().toString();
  const NOW = new Date();
  const DAY = 24 * 3600_000;
  const out: string[] = [];

  beforeAll(async () => {
    process.env.MONGO_URI = `${baseUri}/${TEST_DB}`;
    process.env.PYTHON_AGENT_URL = LIVE;
    process.env.JWT_SECRET ??= 'integration-test-secret';
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { AppModule } = require('../app.module') as typeof import('../app.module');
    const { ReservationService } = require('../billing/reservation.service') as typeof import('../billing/reservation.service');
    const { getConnectionToken } = require('@nestjs/mongoose') as typeof import('@nestjs/mongoose');
    const { EodReportService } = require('./eod-report.service') as typeof import('./eod-report.service');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ReservationService)
      .useValue({ resolveTenantKey: (o: string) => o, reserve: async () => ({}), settle: async () => ({}), release: async () => undefined })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    conn = app.get(getConnectionToken());
    eod = app.get(EodReportService);

    const users = conn.collection('users');
    sanjay = (await users.insertOne({ organizationId: org, email: 'sanjay@pantheras.io', name: 'Sanjay', roles: ['consultant'], active: true, isLogin: true })).insertedId.toString();
    idle = (await users.insertOne({ organizationId: org, email: 'idle@pantheras.io', name: 'Meera', roles: ['consultant'], active: true, isLogin: true })).insertedId.toString();

    const base = { organizationId: org, assignedTo: sanjay, isActive: true, meta: {}, createdAt: NOW, updatedAt: NOW };
    const done = new Date(NOW.getTime() - 2 * 3600_000);
    await conn.collection('work_tasks').insertMany([
      { ...base, sourcePlatform: 'hoops', sourceType: 'deal', sourceRecordId: 'd1', title: 'Close deal: 200 caps for Fresh Brew', priority: 'high', status: 'completed', completedAt: done, completionEvidence: { type: 'source_status', detail: 'Deal marked won in hoops.', at: done, sourceRef: 'd1' } },
      { ...base, sourcePlatform: 'outlook', sourceType: 'email_reply_owed', sourceRecordId: 'm1', title: 'Reply to Asha: Quote please', priority: 'high', status: 'completed', completedAt: done, completionEvidence: { type: 'source_event', detail: 'Reply recorded (app).', at: done, sourceRef: 'm1' } },
      { ...base, sourcePlatform: 'pantheras', sourceType: 'deal', sourceRecordId: 'd2', title: 'Send revised quote to Lakshmi Textiles', priority: 'medium', status: 'in_progress' },
      { ...base, sourcePlatform: 'pantheras', sourceType: 'quote_payment', sourceRecordId: 'q1', title: 'Collect payment: quote #88', description: 'Balance 40000 INR of 100000 due 3 days ago.', priority: 'high', status: 'pending', dueDate: new Date(NOW.getTime() - 3 * DAY) },
      { ...base, sourcePlatform: 'hoops', sourceType: 'deal', sourceRecordId: 'd3', title: 'Waiting on legal for Acme contract', priority: 'medium', status: 'blocked' },
      { ...base, sourcePlatform: 'pantheras', sourceType: 'deal', sourceRecordId: 'd4', title: 'Confirm artwork with Priya Designs', priority: 'medium', status: 'awaiting_verification' },
    ]);
    await conn.collection('crm_activities').insertOne({ organizationId: org, actorUserId: sanjay, kind: 'won', entity: 'deal', customerName: 'Fresh Brew', occurredAt: done });
    await conn.collection('email_intelligence_items').insertOne({ organizationId: org, userId: sanjay, sentAt: done, subject: 'x' });
    // Healthy synchronization for both sources, so the day is read as real data.
    for (const adapterId of ['crm', 'email']) await conn.collection('work_sync_runs').insertOne({ organizationId: org, adapterId, status: 'ok', startedAt: new Date(NOW.getTime() - 600_000), finishedAt: NOW, trigger: 'schedule' });
  }, 180_000);

  afterAll(async () => {
    // eslint-disable-next-line no-console
    console.log(`\n===== LIVE AI EOD EVIDENCE =====\n${out.join('\n\n')}\n================================`);
    if (conn) await conn.dropDatabase().catch(() => undefined);
    if (app) await app.close();
  });

  const date = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(NOW);

  it('writes a summary from the verified records only, and cannot change any task', async () => {
    const before = await conn.collection('work_tasks').find({ organizationId: org }).project({ title: 1, status: 1, completionEvidence: 1 }).sort({ title: 1 }).toArray();
    const res = await eod.generateForUser(org, sanjay, date(), { now: NOW });
    expect(res.status).toBe('generated');
    const report = await conn.collection('work_eod_reports').findOne({ organizationId: org, userId: sanjay });
    out.push(`[Sanjay: 2 completed, 1 in progress, 1 overdue, 1 blocked, 1 awaiting verification]\nsummarySource=${report!.summarySource}\n${report!.summary}`);
    expect(report!.summarySource).toBe('ai');

    // 1. The counts the report stores are exactly the tracked records.
    expect(report!.sections.counts).toEqual({ completed: 2, pending: 1, overdue: 1, blocked: 1, awaitingVerification: 1 });
    expect(report!.sections.completed.map((t: { title: string }) => t.title).sort()).toEqual(['Close deal: 200 caps for Fresh Brew', 'Reply to Asha: Quote please']);
    expect(report!.sections.overdue.map((t: { title: string }) => t.title)).toEqual(['Collect payment: quote #88']);

    // 2. The AI never calls unfinished work finished: any sentence naming an unfinished task has no completion wording.
    const summary = String(report!.summary);
    const sentences = summary.split(/(?<=[.!?])\s+/);
    for (const marker of ['Lakshmi', 'quote #88', 'legal', 'Acme', 'Priya', 'artwork', 'payment']) {
      for (const sentence of sentences.filter((s) => s.toLowerCase().includes(marker.toLowerCase()))) {
        expect({ marker, sentence, claimsCompletion: COMPLETION_WORDS.test(sentence) && !/\b(not|none|no|nothing|yet|awaiting|pending|outstanding|overdue)\b/i.test(sentence) }).toMatchObject({ claimsCompletion: false });
      }
    }

    // 3. It states the real completed work, and nothing invented: every number it writes exists in the records.
    expect(summary).toMatch(/Fresh Brew/i);
    expect(summary).toMatch(/Asha/i);
    const records = JSON.stringify({ sections: report!.sections, date: date() });
    for (const n of summary.match(/\d[\d,.]*/g) ?? []) expect({ n, known: records.includes(n.replace(/[,.]$/, '').replace(/,/g, '')) || records.includes(n) }).toMatchObject({ known: true });
    expect(JUDGEMENT_WORDS.test(summary)).toBe(false);

    // 4. The AI call changed no task and created no completion.
    const after = await conn.collection('work_tasks').find({ organizationId: org }).project({ title: 1, status: 1, completionEvidence: 1 }).sort({ title: 1 }).toArray();
    expect(after).toEqual(before);
  }, 120_000);

  it('a person with no assigned work and a failed synchronization is not described as unproductive', async () => {
    await conn.collection('work_sync_runs').insertOne({ organizationId: org, adapterId: 'crm', status: 'failed', error: 'CRM timed out', startedAt: new Date(NOW.getTime() - 60_000), finishedAt: NOW, trigger: 'schedule' });
    await eod.generateForUser(org, idle, date(), { now: NOW });
    const report = await conn.collection('work_eod_reports').findOne({ organizationId: org, userId: idle });
    out.push(`[Meera: no tasks, CRM sync FAILED]\nsummarySource=${report!.summarySource}  headline=${report!.sections.assessment.headline}\n${report!.summary}`);
    expect(report!.sections.assessment).toMatchObject({ headline: 'sync_unreliable', syncHealth: 'degraded' });
    expect(JUDGEMENT_WORDS.test(String(report!.summary))).toBe(false);
    expect(String(report!.summary)).not.toMatch(/\bcompleted \d+ task/i);
  }, 120_000);

  it('falls back to the plain-facts summary when the AI service is unreachable', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EodAiClient } = require('./eod-ai.client') as typeof import('./eod-ai.client');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ReservationService } = require('../billing/reservation.service') as typeof import('../billing/reservation.service');
    const dead = new EodAiClient(app.get(HttpService), { get: () => 'http://127.0.0.1:9' } as unknown as ConfigService, app.get(JwtService), app.get(ReservationService));
    const offline = Object.assign(Object.create(Object.getPrototypeOf(eod)), eod, { ai: dead });
    await conn.collection('work_eod_reports').deleteMany({ organizationId: org });
    const res = await offline.generateForUser(org, sanjay, date(), { now: NOW });
    expect(res.status).toBe('generated');
    const report = await conn.collection('work_eod_reports').findOne({ organizationId: org, userId: sanjay });
    out.push(`[Sanjay, AI service unreachable]\nsummarySource=${report!.summarySource}\n${report!.summary}`);
    expect(report!.summarySource).toBe('deterministic');
    expect(String(report!.summary)).toMatch(/2 task\(s\) completed, 1 pending, 1 overdue, 1 blocked, 1 awaiting verification/);
    expect(report!.dataGaps.join(' ')).toMatch(/Meetings could not be read/);
  }, 120_000);

  it('the python route itself refuses a request without a valid token', async () => {
    const res = await fetch(`${LIVE}/work/eod-summary`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ employee_name: 'x', date: '2026-01-01' }) });
    expect(res.status).toBe(401);
  });
});
