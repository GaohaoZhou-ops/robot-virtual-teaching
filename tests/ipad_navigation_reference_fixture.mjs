// Dedicated disposable simulator fixture, never reads or edits real projects.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildIPadNavigationReference } from "../src/shared/protocols/ipadNavigationReference.js";

const output = process.argv[2];
if (!output) throw new Error('Usage: node tests/ipad_navigation_reference_fixture.mjs <output-directory>');
const id = execFileSync(process.execPath, ['tests/iphone_layout_fixture.mjs', output, 'UI-ReadOnly-Parking'], { encoding: 'utf8' }).trim();
const file = path.join(output, `${id}.json`);
const project = JSON.parse(await readFile(file, 'utf8'));
project.result.completedAt = new Date().toISOString();
project.session.navigationReference = buildIPadNavigationReference([
  { id: 'n1', name: 'N001', pose: { x: -0.6, y: -0.4, z: -0.125, roll: 0, pitch: 0, yaw: 45 } },
  { id: 'n2', name: 'N002', pose: { x: 0.65, y: -0.3, z: -0.125, roll: 0, pitch: 0, yaw: 150 } },
  { id: 'n3', name: '上层 P03', pose: { x: 0.35, y: 0.45, z: 0.15, roll: 18, pitch: -25, yaw: -70 } },
], [{ id: 'edge', from: 'n1', to: 'n2', directed: true }]);
await writeFile(file, JSON.stringify(project));
console.log(id);
