import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { FiRefreshCw } from '../components/icons';
import { useDialerStore } from '../lib/dialerStore';
import { useOnline } from '../lib/useOnline';
import { OfflineScreen } from '../screens/GateScreens';
import { TabBar } from './TabBar';
import { TopBar } from './TopBar';
import styles from './DialerLayout.module.css';

/** "A new version is ready" — offered, never forced (it reloads the page). */
export function UpdateBanner() {
  const applyUpdate = useDialerStore((state) => state.applyUpdate);
  if (!applyUpdate) return null;
  return (
    <div className={styles.update} role="status">
      <span>A new version of the Dialer is ready.</span>
      <button type="button" onClick={applyUpdate}>
        <FiRefreshCw aria-hidden /> Refresh
      </button>
    </div>
  );
}

export function ScreenLoading() {
  return (
    <div className={styles.loading} role="status" aria-label="Loading">
      <span className={styles.spinner} aria-hidden />
    </div>
  );
}

/** The frame of the four tabs: who's calling up top, the sections at the bottom. */
export function DialerLayout() {
  const online = useOnline();
  return (
    <div className={styles.app}>
      <TopBar />
      <UpdateBanner />
      <main className={styles.content} id="main">
        {online ? (
          <Suspense fallback={<ScreenLoading />}>
            <Outlet />
          </Suspense>
        ) : (
          <OfflineScreen />
        )}
      </main>
      <TabBar />
    </div>
  );
}
