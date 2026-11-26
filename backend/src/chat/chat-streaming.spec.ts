import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';
import { of } from 'rxjs';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { toStreamEvent } from './stream-events';

// The real ChatService (SSE parsing) and ChatGateway (socket translation) over
// a faked HTTP response, database and socket: no Mongo, no python-agent.
//
// DYNAMIC_FRAMES is the exact output of the Python engine and adapter, pinned by
// python-agent/tests/test_dynamic_agents_stream_contract.py. SOCKET_CONTRACT is
// what this gateway emits for it, which the frontend tests replay.
// UPDATE_STREAM_CONTRACT=1 regenerates the latter after an intended change.
const DYNAMIC_FRAMES: Record<string, unknown>[] = JSON.parse(
  readFileSync(join(__dirname, '../../../python-agent/tests/fixtures/dynamic_stream_contract.json'), 'utf8'),
);
const SOCKET_CONTRACT = join(__dirname, '../../../frontend/src/test/chatSocketContract.json');

const DONE = { type: 'done', reply: 'final answer', tools_used: ['crm_deal'], suggestions: ['next'] };
const sse = (frame: unknown) => `data: ${JSON.stringify(frame)}\n\n`;

async function run(chunks: string[]) {
  const conversation = {
    _id: { toString: () => 'conv-1' },
    userId: 'user-1',
    organizationId: 'org-1',
    agentId: undefined,
    messages: [] as unknown[],
    save: jest.fn().mockResolvedValue(undefined),
  };
  const http = { post: jest.fn(() => of({ data: Readable.from(chunks.map((c) => Buffer.from(c, 'utf8'))) })) };
  const service = new ChatService(
    { create: jest.fn().mockResolvedValue(conversation), findOne: jest.fn().mockResolvedValue(null) } as any,
    {} as any,
    http as any,
    { get: () => 'http://agent.invalid' } as any,
    { del: jest.fn().mockResolvedValue(undefined) } as any,
    {} as any,
    { attach: jest.fn().mockResolvedValue([]) } as any,
  );
  const gateway = new ChatGateway(service, {} as any, { socketAccess: jest.fn().mockResolvedValue({}) } as any);
  const emitted: [string, any][] = [];
  const client = {
    data: { user: { sub: 'user-1', organizationId: 'org-1', roles: ['user'] }, token: 'jwt' },
    emit: (event: string, payload: unknown) => emitted.push([event, payload]),
  };
  await gateway.onMessage(client as any, { message: 'hello' });
  return emitted;
}

// Everything between the opening bookkeeping events and the final reply.
const relayed = (emitted: [string, any][]) => emitted.filter(([e]) => !['typing', 'conversationId', 'message'].includes(e));

describe('chat streaming — legacy events', () => {
  it.each([
    ['delta', { type: 'delta', text: 'Hel' }, 'chunk', { delta: 'Hel' }],
    ['progress', { type: 'progress', tool: 'crm_deal' }, 'progress', { tool: 'crm_deal' }],
    ['reasoning', { type: 'reasoning', text: 'thinking' }, 'reasoning', { text: 'thinking' }],
    ['plan', { type: 'plan', agents: ['crm', 'outlook'] }, 'plan', { agents: ['crm', 'outlook'] }],
    ['agent_done', { type: 'agent_done', agent: 'crm' }, 'agentDone', { agent: 'crm' }],
    ['reflecting', { type: 'reflecting', reason: 'missing x' }, 'reflecting', { reason: 'missing x' }],
  ])('relays %s with its original socket name and payload', async (_name, frame, socketEvent, payload) => {
    const emitted = await run([sse(frame), sse(DONE)]);
    expect(relayed(emitted)).toEqual([[socketEvent, { conversationId: 'conv-1', ...payload }]]);
  });

  it('keeps the legacy turn shape: typing, conversation id, chunks in order, then the final message', async () => {
    const emitted = await run([sse({ type: 'delta', text: 'a' }), sse({ type: 'delta', text: 'b' }), sse(DONE)]);
    expect(emitted.map(([e]) => e)).toEqual(['typing', 'conversationId', 'chunk', 'chunk', 'typing', 'message']);
    expect(emitted.at(-1)![1]).toEqual({ conversationId: 'conv-1', reply: 'final answer', toolsUsed: ['crm_deal'], suggestions: ['next'] });
  });

  it('still reassembles frames split across network chunks', async () => {
    const wire = sse({ type: 'delta', text: 'whole' }) + sse(DONE);
    const emitted = await run([wire.slice(0, 11), wire.slice(11, 40), wire.slice(40)]);
    expect(relayed(emitted)).toEqual([['chunk', { conversationId: 'conv-1', delta: 'whole' }]]);
  });
});

describe('chat streaming — dynamic-agent contract (real Python adapter output)', () => {
  let emitted: [string, any][];
  beforeAll(async () => {
    emitted = await run([...DYNAMIC_FRAMES.map(sse), sse(DONE)]);
  });

  const activity = (type: string, status?: string) =>
    relayed(emitted).filter(([e, p]) => e === 'agentActivity' && p.type === type && (!status || p.status === status));

  it('delivers agent creation', () => {
    expect(activity('agent_created').map(([, p]) => p)).toEqual([
      { conversationId: 'conv-1', type: 'agent_created', agent: 'CRM lookup', agent_id: 'dyn-000000000001', depth: 1 },
      { conversationId: 'conv-1', type: 'agent_created', agent: 'Copy [redacted]', agent_id: 'dyn-000000000002', depth: 1 },
    ]);
  });

  it('delivers agent progress: started, retrying (with attempt) and failed', () => {
    expect(activity('agent_progress', 'running')).toHaveLength(2);
    expect(activity('agent_progress', 'retrying')[0][1]).toMatchObject({ agent: 'CRM lookup', attempt: 1 });
    expect(activity('agent_progress', 'failed')[0][1]).toMatchObject({ agent: 'Copy [redacted]' });
  });

  it('delivers completion once, as the existing agentDone event', () => {
    expect(relayed(emitted).filter(([e]) => e === 'agentDone')).toEqual([['agentDone', { conversationId: 'conv-1', agent: 'CRM lookup' }]]);
  });

  it('delivers validation, tool execution (as progress) and delegation (as plan)', () => {
    expect(activity('validation', 'passed')).toHaveLength(1);
    expect(relayed(emitted).filter(([e]) => e === 'progress')).toEqual([['progress', { conversationId: 'conv-1', tool: 'crm_deal' }]]);
    expect(relayed(emitted).filter(([e]) => e === 'plan')).toEqual([
      ['plan', { conversationId: 'conv-1', agents: ['CRM lookup', 'Copy [redacted]'] }],
    ]);
  });

  it('loses nothing and duplicates nothing: exactly one socket event per frame, in order', () => {
    const socketName: Record<string, string> = {
      reasoning: 'reasoning', plan: 'plan', progress: 'progress', agent_done: 'agentDone',
      agent_created: 'agentActivity', agent_progress: 'agentActivity', validation: 'agentActivity',
    };
    expect(relayed(emitted).map(([e]) => e)).toEqual(DYNAMIC_FRAMES.map((f) => socketName[f.type as string]));
  });

  it('matches the socket contract the frontend is tested against', () => {
    if (process.env.UPDATE_STREAM_CONTRACT) writeFileSync(SOCKET_CONTRACT, `${JSON.stringify(emitted, null, 2)}\n`);
    expect(emitted).toEqual(JSON.parse(readFileSync(SOCKET_CONTRACT, 'utf8')));
  });
});

describe('chat streaming — unknown, malformed and unsafe frames', () => {
  it('drops unknown event types, including raw internal dynamic events, and still completes', async () => {
    const emitted = await run([
      sse({ type: 'some_future_event', secret: 's' }),
      sse({ type: 'agent_completed', agent: 'a', result: 'unredacted' }),
      sse({ type: 'understanding', text: 'private reasoning' }),
      sse({ type: 'delegation_started', agents: ['a'] }),
      sse({ type: 'tool_execution', tool: 'crm_deal', arguments: { id: 1 } }),
      sse({ type: 'toString' }),
      sse(DONE),
    ]);
    expect(relayed(emitted)).toEqual([]);
    expect(emitted.at(-1)![1].reply).toBe('final answer');
  });

  it('skips malformed frames (bad JSON, non-objects, missing type, non-data lines) without breaking the stream', async () => {
    const emitted = await run([
      'data: {not json}\n\n', 'data: null\n\n', 'data: 7\n\n', 'data: "text"\n\n', 'data: {}\n\n', ': keep-alive\n\n',
      sse({ type: 'delta', text: 'ok' }),
      sse(DONE),
    ]);
    expect(relayed(emitted)).toEqual([['chunk', { conversationId: 'conv-1', delta: 'ok' }]]);
    expect(emitted.at(-1)![1].reply).toBe('final answer');
  });

  it('strips every field outside the safe list from activity events', () => {
    expect(
      toStreamEvent({
        type: 'agent_progress', agent: 'x'.repeat(200), agent_id: 'not-an-id', status: 'failed', attempt: 'two',
        result: 'r', error: 'e', task_description: 't', arguments: {},
      }),
    ).toEqual({ type: 'agent_progress', agent: 'x'.repeat(80), status: 'failed' });
  });

  it.each([
    [{ type: 'agent_progress', agent: 'a', status: 'done' }],
    [{ type: 'agent_progress', status: 'running' }],
    [{ type: 'validation', agent: 'a' }],
    [{ type: 'agent_created', agent: { name: 'a' } }],
    [null],
    [undefined],
  ])('rejects the invalid activity frame %j', (frame) => {
    expect(toStreamEvent(frame)).toBeNull();
  });
});
