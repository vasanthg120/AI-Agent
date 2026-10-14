import { axiosClient } from '@/api/axiosClient';
import { getSocket } from '@/api/socketClient';
import { planStatus } from '@/features/chat/agentLabels';
import { useAuthStore } from '@/stores/authStore';
import { generateId } from '@/utils/id';
import { commandCenterService } from './commandCenterService';
import type { ChatAgent, ChatMessage, Conversation, ConversationDetails, MessageAttachment } from '@/types';

interface BackendConversationSummary {
  _id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  favorite?: boolean;
  archived?: boolean;
  // listConversations projects only the LAST message ($slice: -1) for a
  // preview snippet — never the full array, to keep the list endpoint light.
  messages?: BackendMessage[];
}

interface BackendAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

interface BackendMessage {
  role: 'user' | 'assistant';
  content: string;
  toolsUsed: string[];
  attachments?: BackendAttachment[];
  createdAt: string;
}

// What may be attached in the chat (GET /chat/attachments/limits). The server
// enforces all of it again; this only lets the input refuse a file up front.
export interface ChatAttachmentLimits {
  extensions: string[];
  maxFileBytes: number;
  maxPerMessage: number;
  maxPerConversation: number;
  retentionDays: number;
}

export const DEFAULT_ATTACHMENT_LIMITS: ChatAttachmentLimits = {
  extensions: ['.pdf', '.docx', '.xlsx', '.xls', '.pptx', '.png', '.jpg', '.jpeg', '.webp', '.csv', '.txt', '.md', '.html', '.htm'],
  maxFileBytes: 25 * 1024 * 1024,
  maxPerMessage: 5,
  maxPerConversation: 10,
  retentionDays: 30,
};

function toAttachment(a: BackendAttachment): MessageAttachment {
  return { id: a.id, name: a.name, size: a.sizeBytes, type: a.mimeType, kind: a.mimeType.startsWith('image/') ? 'image' : 'document' };
}

interface BackendConversation extends BackendConversationSummary {
  messages: BackendMessage[];
  agentId?: string;
}

interface BackendChatResult {
  conversationId: string;
  reply: string;
  toolsUsed: string[];
  suggestions?: string[];
}

const PREVIEW_MAX_LENGTH = 140;

function toConversation(c: BackendConversationSummary): Conversation {
  const lastMessage = c.messages?.[0];
  return {
    id: c._id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    pinned: c.pinned ?? false,
    favorite: c.favorite ?? false,
    archived: c.archived ?? false,
    messageCount: 0,
    preview: lastMessage ? lastMessage.content.slice(0, PREVIEW_MAX_LENGTH) : undefined,
  };
}

function toMessage(m: BackendMessage, conversationId: string, index: number): ChatMessage {
  return {
    id: `${conversationId}_${index}`,
    conversationId,
    role: m.role,
    content: m.content,
    status: 'complete',
    createdAt: m.createdAt,
    toolsUsed: m.toolsUsed?.length ? m.toolsUsed : undefined,
    attachments: m.attachments?.length ? m.attachments.map(toAttachment) : undefined,
  };
}

export interface StreamController {
  stop: () => void;
}

export interface StreamCallbacks {
  onChunk: (accumulatedText: string) => void;
  onProgress?: (tool: string) => void;
  /** Higher-level status text (planning/delegating to specialists/reviewing
   * — see agentLabels.ts) shown in place of the tool-level progress label
   * while it's the most recent thing that's happened. */
  onStatus?: (status: string) => void;
  onComplete: (message: ChatMessage, conversationId: string) => void;
  onError: (error: Error) => void;
}

export const chatService = {
  async getConversations(): Promise<Conversation[]> {
    const { data } = await axiosClient.get<BackendConversationSummary[]>('/chat/conversations');
    return data.map(toConversation).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  },

  async getMessages(conversationId: string): Promise<{ messages: ChatMessage[]; agentId?: string }> {
    const { data } = await axiosClient.get<BackendConversation>(`/chat/conversations/${conversationId}`);
    return {
      messages: (data.messages ?? []).map((m, i) => toMessage(m, conversationId, i)),
      agentId: data.agentId,
    };
  },

  async getAgents(): Promise<ChatAgent[]> {
    const { data } = await axiosClient.get<ChatAgent[]>('/chat/agents');
    return data;
  },

  /**
   * The backend has no "create empty conversation" endpoint — a conversation
   * only exists once the first message lands. This returns a client-only
   * placeholder id that chatStore uses as a temporary map key until the
   * server assigns the real one (see streamReply's onComplete).
   */
  async createConversation(): Promise<Conversation> {
    const now = new Date().toISOString();
    return {
      id: generateId('pending'),
      title: 'New conversation',
      createdAt: now,
      updatedAt: now,
      pinned: false,
      favorite: false,
      archived: false,
      messageCount: 0,
    };
  },

  async getAttachmentLimits(): Promise<ChatAttachmentLimits> {
    const { data } = await axiosClient.get<ChatAttachmentLimits>('/chat/attachments/limits');
    return data;
  },

  /** Uploads one document for the next message. The server checks it, reads
   * its text and keeps that (encrypted) — the id returned is what gets sent
   * with the message. */
  async uploadAttachment(file: File, onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<MessageAttachment> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await axiosClient.post<BackendAttachment>('/chat/attachments', form, {
      signal,
      // Reading a long document (or an image, by the vision model) takes a while after the bytes are up.
      timeout: 300_000,
      onUploadProgress: (event) => onProgress?.(event.total ? Math.round((event.loaded / event.total) * 100) : 0),
    });
    return toAttachment(data);
  },

  async deleteAttachment(id: string): Promise<void> {
    await axiosClient.delete(`/chat/attachments/${id}`);
  },

  async renameConversation(id: string, title: string): Promise<void> {
    await axiosClient.patch(`/chat/conversations/${id}`, { title });
  },

  async deleteConversation(id: string): Promise<void> {
    await axiosClient.delete(`/chat/conversations/${id}`);
  },

  async setConversationFlag(id: string, flag: 'pinned' | 'favorite' | 'archived', value: boolean): Promise<void> {
    await axiosClient.patch(`/chat/conversations/${id}/flag`, { flag, value });
  },

  streamReply(
    conversationId: string,
    prompt: string,
    callbacks: StreamCallbacks,
    isNewConversation: boolean,
    agentId?: string,
    attachmentIds?: string[],
  ): StreamController {
    const token = useAuthStore.getState().accessToken ?? '';
    const socket = getSocket(token);
    if (!socket.connected) socket.connect();

    let settled = false;
    let accumulated = '';
    // For a brand-new conversation, `conversationId` (the param above) is
    // whatever placeholder chatStore is using — the server assigns the real
    // id only once it creates the conversation, mid-stream. Captured here so
    // stop() below can tell the server which conversation to cancel even on
    // a first message, before the terminal 'message' event would otherwise
    // reveal it.
    let resolvedConversationId = conversationId;

    const onConversationId = (payload: { conversationId: string }) => {
      resolvedConversationId = payload.conversationId;
    };

    const onChunk = (payload: { delta: string }) => {
      if (settled) return;
      accumulated += payload.delta ?? '';
      callbacks.onChunk(accumulated);
    };

    const onProgress = (payload: { tool: string }) => {
      if (settled) return;
      callbacks.onProgress?.(payload.tool);
    };

    const onReasoning = () => {
      if (settled) return;
      callbacks.onStatus?.('Planning…');
    };

    const onPlan = (payload: { agents: string[] }) => {
      if (settled) return;
      callbacks.onStatus?.(planStatus(payload.agents ?? []));
    };

    const onReflecting = () => {
      if (settled) return;
      callbacks.onStatus?.('Finalizing…');
    };

    const onMessage = (result: BackendChatResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      const resolvedId = result.conversationId || conversationId;
      callbacks.onComplete(
        {
          id: generateId('msg'),
          conversationId: resolvedId,
          role: 'assistant',
          content: result.reply,
          status: 'complete',
          createdAt: new Date().toISOString(),
          toolsUsed: result.toolsUsed?.length ? result.toolsUsed : undefined,
          suggestions: result.suggestions?.length ? result.suggestions : undefined,
        },
        resolvedId,
      );
    };

    const onError = (payload: { message: string }) => {
      if (settled) return;
      settled = true;
      cleanup();
      callbacks.onError(new Error(payload.message || 'The chat service returned an error.'));
    };

    function cleanup() {
      socket.off('chunk', onChunk);
      socket.off('progress', onProgress);
      socket.off('reasoning', onReasoning);
      socket.off('plan', onPlan);
      socket.off('reflecting', onReflecting);
      socket.off('conversationId', onConversationId);
      socket.off('message', onMessage);
      socket.off('error', onError);
    }

    socket.on('chunk', onChunk);
    socket.on('progress', onProgress);
    socket.on('reasoning', onReasoning);
    socket.on('plan', onPlan);
    socket.on('reflecting', onReflecting);
    socket.on('conversationId', onConversationId);
    socket.on('message', onMessage);
    socket.on('error', onError);
    socket.emit('message', {
      message: prompt,
      conversationId: isNewConversation ? undefined : conversationId,
      agentId,
      attachmentIds: attachmentIds?.length ? attachmentIds : undefined,
    });

    return {
      stop: () => {
        if (settled) return;
        settled = true;
        // Best-effort: asks python-agent to actually halt generation
        // server-side (see ChatGateway's 'cancel' handler) — sent before
        // cleanup so it goes out even though settled flips first.
        // resolvedConversationId, not the outer conversationId param: for a
        // brand-new conversation the server-assigned real id only became
        // known mid-stream, via the 'conversationId' event above.
        socket.emit('cancel', { conversationId: resolvedConversationId });
        cleanup();
        callbacks.onComplete(
          {
            id: generateId('msg'),
            conversationId,
            role: 'assistant',
            content: '',
            status: 'stopped',
            createdAt: new Date().toISOString(),
          },
          conversationId,
        );
      },
    };
  },

  async submitFeedback(): Promise<void> {
    // Not persisted server-side yet — local UI state only.
  },

  // Stats are real (Phase 5 — backed by python-agent's persisted execution
  // history via GET /command-center/conversations/:id/stats). Referenced
  // docs/knowledge sources/memory context stay empty — those need RAG
  // retrieval-hit plumbing, an unrelated feature not part of Command Center.
  async getConversationDetails(conversationId: string): Promise<ConversationDetails> {
    const stats = await commandCenterService.getConversationStats(conversationId);
    return {
      conversationId,
      referencedDocuments: [],
      knowledgeSources: [],
      connectedTools: [],
      promptVariables: {},
      stats,
      agentStatus: 'idle',
      memoryContext: [],
    };
  },
};
