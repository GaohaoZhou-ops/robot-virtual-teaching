import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = fileURLToPath(new URL("../../../", import.meta.url));
export async function ipadUSBBridgePackage() {
  const files = {
    'ipadUSBBridge.py': 'src/server/devices/ipadUSBBridge.py',
    'ipadScreenUSB.py': 'src/server/devices/ipadScreenUSB.py',
    'start-windows.cmd': 'src/usbBridge/start-windows.cmd',
    'README.txt': 'src/usbBridge/README.txt',
    'web/index.html': 'src/usbBridge/index.html',
    'web/client.js': 'src/usbBridge/client.js',
  };
  const entries = await Promise.all(Object.entries(files).map(async ([name, source]) => {
    let bytes = await readFile(path.join(root, source));
    if (name.endsWith('.cmd')) bytes = Buffer.from(bytes.toString().replace(/\r?\n/g, '\r\n'));
    return [`Atlas-iPad-USB/${name}`, new Uint8Array(bytes)];
  }));
  return Buffer.from(zipSync(Object.fromEntries(entries)));
}
