import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Which CRM data source the app is showing — remembered per signed-in user
// (each user belongs to one organization):
// 'default' (the organization's default source), a source id, or 'unified'
// (every connected CRM together — only ever when chosen on purpose). Sent to
// the backend on every request as X-Data-Source (see axiosClient), which
// scopes every CRM read to it.

export type DataSourceSelection = 'default' | 'unified' | string;

interface DataSourceState {
  selections: Record<string, DataSourceSelection>;
  // Bumped on every change so pages built on it remount and reload.
  version: number;
  getSelection: (userId: string | undefined) => DataSourceSelection;
  setSelection: (userId: string, selection: DataSourceSelection) => void;
}

export const useDataSourceStore = create<DataSourceState>()(
  persist(
    (set, get) => ({
      selections: {},
      version: 0,
      getSelection: (userId) => (userId ? (get().selections[userId] ?? 'default') : 'default'),
      setSelection: (userId, selection) =>
        set((state) => ({ selections: { ...state.selections, [userId]: selection }, version: state.version + 1 })),
    }),
    { name: 'haive:data-source', partialize: (state) => ({ selections: state.selections }) },
  ),
);
