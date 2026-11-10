import { lazy, Suspense } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { domAnimation, LazyMotion, MotionConfig } from 'framer-motion';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { queryClient } from '@/config/queryClient';
import { DialerLayout, ScreenLoading } from './layout/DialerLayout';
import { Gate } from './layout/Gate';
import { KeypadScreen } from './screens/KeypadScreen';

// The keypad opens with the app; every other screen loads the first time it's used.
const RecentsScreen = lazy(() => import('./screens/recents/RecentsScreen').then((m) => ({ default: m.RecentsScreen })));
const ContactsScreen = lazy(() => import('./screens/contacts/ContactsScreen').then((m) => ({ default: m.ContactsScreen })));
const ScoresScreen = lazy(() => import('./screens/scores/ScoresScreen').then((m) => ({ default: m.ScoresScreen })));
const ReportScreen = lazy(() => import('./screens/report/ReportScreen').then((m) => ({ default: m.ReportScreen })));
const loadCallScreen = () => import('./screens/CallScreen');
const CallScreen = lazy(() => loadCallScreen().then((m) => ({ default: m.CallScreen })));

// The call screen opens the moment the call button is pressed: fetch it ahead, once the keypad is up.
if (typeof window !== 'undefined') window.setTimeout(() => void loadCallScreen().catch(() => undefined), 1500);

/**
 * HaiVE Dialer: its own page (/dialer/), its own installable app, the same
 * sign-in and the same API as HaiVE. Only the motion features the Dialer uses
 * are loaded (LazyMotion), and reduced-motion settings are honoured everywhere.
 */
export function DialerApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <LazyMotion features={domAnimation}>
        <MotionConfig reducedMotion="user">
          <BrowserRouter basename="/dialer">
            <Gate>
              <Suspense fallback={<ScreenLoading />}>
                <Routes>
                  <Route element={<DialerLayout />}>
                    <Route index element={<KeypadScreen />} />
                    <Route path="recents" element={<RecentsScreen />} />
                    <Route path="contacts" element={<ContactsScreen />} />
                    <Route path="scores" element={<ScoresScreen />} />
                  </Route>
                  <Route path="call/:provider/:id" element={<CallScreen />} />
                  <Route path="report/session/:sessionId" element={<ReportScreen />} />
                  <Route path="report/:provider/:id" element={<ReportScreen />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Suspense>
            </Gate>
          </BrowserRouter>
          <Toaster
            position="top-center"
            containerStyle={{ top: 'calc(12px + env(safe-area-inset-top, 0px))' }}
            toastOptions={{
              style: {
                background: 'var(--color-bg-surface-elevated)',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border-strong)',
                borderRadius: 'var(--radius-lg)',
                fontSize: 'var(--text-md)',
              },
            }}
          />
        </MotionConfig>
      </LazyMotion>
    </QueryClientProvider>
  );
}
