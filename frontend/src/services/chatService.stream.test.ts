import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentActivityStatus } from '@/features/chat/agentLabels';
import socketContractJson from '@/test/chatSocketContract.json?raw';
import { chatService, type StreamCallbacks } from './chatService';

// A minimal socket.io stand-in: only on/off/emit and server-side delivery.
const socket = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    connected: true,
    listeners,
    sent: [] as unknown[][],
    connect: () => undefined,
    on(event: string, fn: (payload: unknown) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    off(event: string, fn: (payload: unknown) => void) {
      listeners.get(event)?.delete(fn);
    },
    emit(...args: unknown[]) {
      this.sent.push(args);
    },
    deliver(event: string, payload: unknown) {
      listeners.get(event)?.forEach((fn) => fn(payload));
    },
  };
});

vi.mock('@/api/socketClient', () => ({ getSocket: () => socket }));

// What the NestJS gateway emits for the real Python adapter output, pinned by
// backend/src/chat/chat-streaming.spec.ts.
const CONTRACT = JSON.parse(socketContractJson) as [string, any][];

function start() {
  const calls: [keyof StreamCallbacks, unknown][] = [];
  const callbacks: StreamCallbacks = {
    onChunk: (text) => calls.push(['onChunk', text]),
    onProgress: (tool) => calls.push(['onProgress', tool]),
    onStatus: (status) => calls.push(['onStatus', status]),
    onComplete: (message) => calls.push(['onComplete', message.content]),
    onError: (error) => calls.push(['onError', error.message]),
  };
  const controller = chatService.streamReply('conv-1', 'hello', callbacks, false);
  return { calls, controller };
}

const activeListeners = () => [...socket.listeners.values()].reduce((n, set) => n + set.size, 0);

beforeEach(() => {
  socket.listeners.clear();
  socket.sent.length = 0;
});

describe('chat stream — legacy events', () => {
  it.each([
    ['chunk', { delta: 'Hi' }, ['onChunk', 'Hi']],
    ['progress', { tool: 'crm_deal' }, ['onProgress', 'crm_deal']],
    ['reasoning', { text: 'x' }, ['onStatus', 'Planning…']],
    ['plan', { agents: ['crm'] }, ['onStatus', 'Searching CRM…']],
    ['reflecting', { reason: 'x' }, ['onStatus', 'Finalizing…']],
  ])('%s still drives the same callback', (event, payload, expected) => {
    const { calls } = start();
    socket.deliver(event, payload);
    expect(calls).toEqual([expected]);
  });

  it('accumulates chunks and completes with the final reply', () => {
    const { calls } = start();
    socket.deliver('chunk', { delta: 'a' });
    socket.deliver('chunk', { delta: 'b' });
    socket.deliver('message', { conversationId: 'conv-1', reply: 'ab!', toolsUsed: [] });
    expect(calls).toEqual([['onChunk', 'a'], ['onChunk', 'ab'], ['onComplete', 'ab!']]);
    expect(activeListeners()).toBe(0);
  });
});

describe('chat stream — dynamic-agent events (socket contract)', () => {
  it('turns the whole contract into status updates, once each, then completes', () => {
    const { calls } = start();
    CONTRACT.forEach(([event, payload]) => socket.deliver(event, payload));
    expect(calls).toEqual([
      ['onStatus', 'Planning…'],
      ['onStatus', 'Checking CRM lookup, Checking Copy [redacted]…'],
      ['onStatus', "Couldn't finish Copy [redacted], continuing…"],
      ['onStatus', 'Planning…'],
      ['onStatus', 'Working on CRM lookup…'],
      ['onStatus', 'Retrying CRM lookup…'],
      ['onStatus', 'Working on CRM lookup…'],
      ['onProgress', 'crm_deal'],
      ['onComplete', 'final answer'],
    ]);
  });

  it('subscribes to agent activity exactly once and removes it on completion and on stop', () => {
    const first = start();
    expect(socket.listeners.get('agentActivity')!.size).toBe(1);
    socket.deliver('message', { conversationId: 'conv-1', reply: 'r', toolsUsed: [] });
    expect(activeListeners()).toBe(0);
    first.controller.stop();

    const second = start();
    second.controller.stop();
    socket.deliver('agentActivity', { type: 'agent_progress', status: 'running', agent: 'late' });
    expect(second.calls).toEqual([['onComplete', '']]);
    expect(activeListeners()).toBe(0);
  });

  it('shows nothing new for agent creation, validation or completion', () => {
    const { calls } = start();
    socket.deliver('agentActivity', { type: 'agent_created', agent: 'a', depth: 1 });
    socket.deliver('agentActivity', { type: 'validation', agent: 'a', status: 'passed' });
    socket.deliver('agentDone', { agent: 'a' });
    expect(calls).toEqual([]);
  });
});

describe('chat stream — unknown and malformed events', () => {
  it('ignores event names it has no listener for, and keeps working', () => {
    const { calls } = start();
    socket.deliver('someFutureEvent', { anything: 1 });
    socket.deliver('agentActivity', { type: 'some_future_kind', status: 'running', agent: 'a' });
    socket.deliver('chunk', { delta: 'still fine' });
    expect(calls).toEqual([['onChunk', 'still fine']]);
  });

  it.each([null, undefined, 'text', 5, {}, { type: 'agent_progress' }, { type: 'agent_progress', status: 'running', agent: 3 }])(
    'ignores the malformed activity payload %j',
    (payload) => {
      const { calls } = start();
      expect(() => socket.deliver('agentActivity', payload)).not.toThrow();
      expect(calls).toEqual([]);
      expect(agentActivityStatus(payload)).toBeNull();
    },
  );
});
