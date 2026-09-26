import { create } from 'zustand';
import { getSocket } from '@/api/socketClient';
import { notificationsService, toNotification, type BackendNotification } from '@/services/notificationsService';
import type { AppNotification } from '@/services/mock/fixtures/notifications';
import { useAuthStore } from '@/stores/authStore';

interface NotificationsState {
  notifications: AppNotification[];
  initialized: boolean;
  // True once the first fetch has finished (successfully or not) — lets the
  // Notifications page tell "still loading" apart from "genuinely empty".
  loaded: boolean;
  unreadCount: () => number;
  init: () => Promise<void>;
  markRead: (id: string) => void;
  markAllRead: () => void;
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  notifications: [],
  initialized: false,
  loaded: false,

  unreadCount() {
    return get().notifications.filter((n) => !n.read).length;
  },

  // Called once from AppLayout on mount (any authenticated page) — fetches
  // what's already there, then subscribes to live push for anything created
  // while this session is open (see backend/src/chat/chat.gateway.ts's
  // emitToUser, which NotificationsService uses). Safe to call more than
  // once; only the first call does anything.
  async init() {
    if (get().initialized) return;
    set({ initialized: true });

    try {
      const notifications = await notificationsService.list();
      set({ notifications });
    } catch {
      // Notifications are a convenience layer, not core app function — a
      // failed fetch just leaves the list empty until the next reload.
    } finally {
      set({ loaded: true });
    }

    const token = useAuthStore.getState().accessToken;
    if (!token) return;

    const socket = getSocket(token);
    if (!socket.connected) socket.connect();
    socket.on('notification', (notification: BackendNotification) => {
      set((state) => ({ notifications: [toNotification(notification), ...state.notifications] }));
    });
  },

  markRead(id) {
    set((state) => ({ notifications: state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)) }));
    notificationsService.markRead(id).catch(() => {});
  },

  markAllRead() {
    set((state) => ({ notifications: state.notifications.map((n) => ({ ...n, read: true })) }));
    notificationsService.markAllRead().catch(() => {});
  },
}));
