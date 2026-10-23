import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import { ipadUSBBridgePackage } from '../src/server/ipadUSBBridgePackage.js';

const files = unzipSync(await ipadUSBBridgePackage());
assert.equal(Object.keys(files).length, 6);
assert.match(strFromU8(files['Atlas-iPad-USB/web/index.html']), /__BRIDGE_SECRET__/);
assert.match(strFromU8(files['Atlas-iPad-USB/start-windows.cmd']), /py -3 ipadUSBBridge.py\r\n/);
assert.ok(!Object.keys(files).some((name) => /\.log$|\.json$|__pycache__/.test(name)));
const candidates = process.platform === 'win32' ? [['py', ['-3']], ['python', []]] : [['python3', []]];
let result;
for (const [command, args] of candidates) {
  result = spawnSync(command, [...args, 'tests/ipad_usb_bridge_smoke.py'], { stdio: 'inherit', timeout: 60000 });
  if (result.error?.code === 'ENOENT') continue;
  break;
}
assert.ifError(result.error);
assert.equal(result.status, 0, 'Windows USB framing, ownership and background lifecycle');
console.log('USB companion: standalone Windows archive and local USB transport checks passed.');
