import { randomInt, randomUUID } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import QRCode from 'qrcode';

const identities = new WeakMap();
export const randomPairingCode = () => randomInt(36 ** 4).toString(36).padStart(4, '0').toUpperCase();
export const lanAddresses = (port) => [...new Set(Object.values(networkInterfaces()).flat()
  .filter((item) => item?.family === 'IPv4' && !item.internal)
  .sort((a, b) => Number(a.address.startsWith('169.254.')) - Number(b.address.startsWith('169.254.')))
  .map((item) => `http://${item.address}:${port}`))];
export function ipadServerIdentity(server) {
  if (!identities.has(server)) identities.set(server, { serverId: randomUUID(), serverName: hostname().replace(/\.local$/i, '').slice(0, 120) });
  return identities.get(server);
}
export const pairingQRCode = (payload) => QRCode.toDataURL(JSON.stringify(payload), { errorCorrectionLevel: 'M', margin: 4, scale: 8 });
