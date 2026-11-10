import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import { haiveDialer } from './dialer/vite-plugin.js';

export default defineConfig({
  // haiveDialer: the Dialer (/dialer/) is a second page of this build — see dialer/vite-plugin.js.
  plugins: [react(), tsconfigPaths(), haiveDialer()],
  server: {
    port: 5173,
  },
});
