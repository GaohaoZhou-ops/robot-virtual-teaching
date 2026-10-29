import { fileURLToPath } from 'node:url';
import { inspectArchitecture } from './lib/architecture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = await inspectArchitecture(root);
if (result.errors.length) {
  console.error(result.errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Architecture: ${result.moduleCount} modules, ${result.dependencyCount} imports; boundaries, worker assets and acyclic imports passed.`);
}
