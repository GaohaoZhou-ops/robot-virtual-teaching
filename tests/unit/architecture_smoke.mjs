import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectArchitecture } from '../../scripts/lib/architecture.mjs';

async function inspect(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-architecture-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(root, 'src', name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source);
    }
    return (await inspectArchitecture(root)).errors.join('\n');
  } finally { await rm(root, { recursive: true, force: true }); }
}
assert.equal(await inspect({
  'shared/protocols/state.js': 'export const version = 1;',
  'features/twin/model/state.js': "export {version} from '../../../shared/protocols/state.js';",
  'server/robots/service.js': "import {version} from '../../shared/protocols/state.js';",
}), '');
assert.match(await inspect({ 'features/twin/client.js': "import fs from 'node:fs';" }), /cannot import node:fs/);
assert.match(await inspect({
  'features/twin/client.js': "import '../../server/secret.js';", 'server/secret.js': '',
}), /frontend cannot import server/);
assert.match(await inspect({
  'shared/state.js': "import '../features/twin.js';", 'features/twin.js': '',
}), /shared modules cannot depend/);
assert.match(await inspect({
  'features/a.js': "import './b.js';", 'features/b.js': "import './a.js';",
}), /Import cycle/);
assert.match(await inspect({
  'features/twin/client.js': "new Worker(new URL('./missing.worker.js', import.meta.url));",
}), /missing asset\/worker/);
assert.match(await inspect({
  'features/twin/model/state.js': "import '../ui/Panel.jsx';", 'features/twin/ui/Panel.jsx': 'export default () => <div/>;',
}), /model code cannot depend on UI/);
assert.match(await inspect({
  'features/twin/workers/parse.worker.js': "import '../ui/Panel.jsx';", 'features/twin/ui/Panel.jsx': 'export default () => <div/>;',
}), /worker reaches UI/);
console.log('Architecture rules: valid shared contracts accepted; boundary leaks, cycles, missing workers and UI dependencies rejected.');
