import { create } from 'zustand';

// Which deal the deal panel shows — one panel for the whole app (mounted in
// AppLayout), opened from any list of deals: the Dashboard's Revenue,
// Pipeline and Won-deals lists, Agent Activity's "deals created"…
interface DealDrawerState {
  dealId: string | null;
  open: (dealId: string) => void;
  close: () => void;
}

export const useDealDrawerStore = create<DealDrawerState>()((set) => ({
  dealId: null,
  open: (dealId) => set({ dealId }),
  close: () => set({ dealId: null }),
}));

export const openDealDrawer = (dealId: string) => useDealDrawerStore.getState().open(dealId);
