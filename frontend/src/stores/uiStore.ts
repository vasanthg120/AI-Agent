import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiState {
  sidebarCollapsed: boolean;
  rightPanelOpen: boolean;
  commandPaletteOpen: boolean;
  // The global Copilot-style AI Assistant side panel (see
  // components/assistant/GlobalAssistantPanel.tsx) — a workspace-wide
  // utility docked in AppLayout, distinct from rightPanelOpen above (which
  // only ever applies inside the full Chat page's own conversation-details
  // panel). Defaults closed, same as rightPanelOpen defaults open — each
  // panel's own sensible starting state.
  assistantPanelOpen: boolean;
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  setRightPanelOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleAssistantPanel: () => void;
  setAssistantPanelOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      sidebarCollapsed: false,
      rightPanelOpen: true,
      commandPaletteOpen: false,
      assistantPanelOpen: false,

      toggleSidebar() {
        set({ sidebarCollapsed: !get().sidebarCollapsed });
      },
      toggleRightPanel() {
        set({ rightPanelOpen: !get().rightPanelOpen });
      },
      setRightPanelOpen(open) {
        set({ rightPanelOpen: open });
      },
      setCommandPaletteOpen(open) {
        set({ commandPaletteOpen: open });
      },
      toggleAssistantPanel() {
        set({ assistantPanelOpen: !get().assistantPanelOpen });
      },
      setAssistantPanelOpen(open) {
        set({ assistantPanelOpen: open });
      },
    }),
    {
      name: 'enterprise-ai:ui',
      partialize: (state) => ({ sidebarCollapsed: state.sidebarCollapsed, rightPanelOpen: state.rightPanelOpen }),
    },
  ),
);
