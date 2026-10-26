import { build } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFile } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Package code, workers, styles and the repository's explicit example map, not
// the developer's other maps/robot directories. ZIPs carry project resources.
await build({ root, configFile: false, publicDir: false, plugins: [react()],
  build: { outDir: path.join(root, 'vision/AtlasVisionTeaching/WebWorkbench'), emptyOutDir: true } });
await copyFile(path.join(root, 'maps/xian_map.ply'), path.join(root, 'vision/AtlasVisionTeaching/WebWorkbench/xian_map.ply'));
