// Isolated desktop UI service: no USB bridge, Bonjour advertisement or shared
// transfer cache. Run with the webapp-testing with_server.py helper.
import { createServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import config from '../vite.config.js';
import { createVisionSceneService } from '../src/server/visionSceneService.js';
import { createIPadTeachingService } from '../src/server/ipadTeachingService.js';
import { createIPadScreenService } from '../src/server/ipadScreenService.js';
const directory = await mkdtemp(path.join(tmpdir(), 'atlas-vision-scene-web-'));
const middleware = createVisionSceneService({ directory });
const ipad = createIPadTeachingService({ directory: path.join(directory, 'ipad') });
const screen = createIPadScreenService({ supported: false });
const server = await createServer({ ...config, configFile: false,
  plugins: config.plugins.flat().filter(plugin => !plugin.name.includes('ipad') && plugin.name !== 'atlas-vision-scenes').concat({
    name: 'isolated-vision-scenes', configureServer(server) { server.middlewares.use(middleware); server.middlewares.use(ipad); server.middlewares.use(screen); },
  }), server: { ...config.server, host: '127.0.0.1', port: 22071, strictPort: true } });
await server.listen();
process.on('SIGTERM', async () => { screen.close(); await server.close(); await rm(directory, { recursive: true, force: true }); process.exit(0); });
console.log('Isolated scene UI server: http://127.0.0.1:22071');
