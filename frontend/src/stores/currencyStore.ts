import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// The currency the dashboards, reports and settings show amounts in: that of
// the CRM chosen for dashboards (Pantheras CRM: INR, Hoops CRM: AUD), as the
// backend's data-sources overview reports it. Kept between visits so a page
// opens in the right currency before that answer arrives; AppLayout refreshes
// it and re-opens the page when it changes.
interface CurrencyState {
  currency: string;
  setCurrency: (currency: string) => void;
}

export const useCurrencyStore = create<CurrencyState>()(
  persist(
    (set) => ({
      currency: 'INR',
      setCurrency: (currency) => set({ currency: currency.toUpperCase() }),
    }),
    { name: 'enterprise-ai:display-currency' },
  ),
);
