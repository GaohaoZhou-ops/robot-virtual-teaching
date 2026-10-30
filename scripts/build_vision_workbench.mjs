import { build } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Package only application code, workers and styles. Maps and robot models are
// private local inputs; users supply project resources through their own ZIPs.
await build({ root, configFile: false, publicDir: false, plugins: [react()],
  build: { outDir: path.join(root, 'vision/AtlasVisionTeaching/WebWorkbench'), emptyOutDir: true } });
