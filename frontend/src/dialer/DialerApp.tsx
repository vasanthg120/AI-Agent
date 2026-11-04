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
const RecentsScreen = lazy(() => import('./screens/RecentsScreen').then((m) => ({ default: m.RecentsScreen })));
const ContactsScreen = lazy(() => import('./screens/ContactsScreen').then((m) => ({ default: m.ContactsScreen })));
const ScoresScreen = lazy(() => import('./screens/ScoresScreen').then((m) => ({ default: m.ScoresScreen })));

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
