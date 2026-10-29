import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const suites = {
  core: ['test:architecture', 'test:workspace-sync', 'test:robot-twin', 'test:robot-twin-project',
    'test:work-sync', 'test:fake-robot', 'test:archive', 'test:project-storage', 'test:project-save',
    'test:playback', 'test:connectivity', 'test:model-editor', 'test:viewport-reference',
    'test:viewport-zoom', 'test:robot-display', 'test:collision-backends'],
  extended: ['test:model-composition', 'test:torso', 'test:robot-presets', 'test:robot-limits',
    'test:robot-coupling', 'test:interactive-ik', 'test:polyline', 'test:teaching-insert',
    'test:linked-project', 'test:project-collection', 'test:independent-alignment', 'test:teaching-data',
    'test:independent-export', 'test:directory', 'test:abx',
    'test:ipad', 'test:ipad:navigation', 'test:ipad:qr', 'test:ipad:file', 'test:ipad:discovery',
    'test:ipad:screen', 'test:mobile-solve', 'test:transfer', 'test:route-sync',
    'test:waypoint-labels', 'test:robot-grounding', 'test:coverage', 'test:vision:scene'],
  external: ['test:abx-extended', 'test:abx-exchange'],
};
const selected = process.argv[2] || 'core';
if (selected === '--list') {
  for (const [name, checks] of Object.entries(suites)) console.log(`${name}: ${checks.join(', ')}`);
} else {
  const checks = suites[selected];
  if (!checks) throw new Error(`Unknown suite ${selected}; use core, extended, external or --list`);
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Run this entry through npm run test:core, test:extended or test:external.');
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  for (const [index, check] of checks.entries()) {
    console.log(`\n[${index + 1}/${checks.length}] ${check}`);
    const status = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [npm, 'run', check], { cwd, stdio: 'inherit' });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (status.code !== 0) {
      console.error(`${check} failed${status.signal ? ` (${status.signal})` : ''}`);
      process.exitCode = status.code || 1;
      break;
    }
  }
}
