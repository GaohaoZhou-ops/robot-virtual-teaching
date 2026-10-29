import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createAtlasServicePlugins } from './src/server/plugins.js';

export default defineConfig({
  plugins: [react(), ...createAtlasServicePlugins()],
  publicDir: 'maps',
  server: {
    hmr: process.env.ATLAS_DEV_HMR === '1',
    host: '0.0.0.0',
    port: 21990,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 21990,
    strictPort: true,
  },
});
