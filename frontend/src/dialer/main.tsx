import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DialerApp } from './DialerApp';
import { listenForInstallPrompt } from './lib/install';
import { registerDialerWorker } from './lib/serviceWorker';
import './dialer.css';

listenForInstallPrompt();
registerDialerWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DialerApp />
  </StrictMode>,
);
