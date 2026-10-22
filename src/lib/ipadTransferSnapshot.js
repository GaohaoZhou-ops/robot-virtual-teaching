import { sha256Bytes } from './hash.js';

// Compare the actual payload, not just its count: editing a Pose must also
// invalidate a previously prepared QR. Object key order is not meaningful.
function orderedJSON(payload) {
  const ordered = (value) => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined)
        .map((key) => [key, ordered(value[key])])) : value;
  return JSON.stringify(ordered(payload));
}

export const ipadPoseSeedJSON = (seed) => orderedJSON(seed?.samples || []);
export const ipadNavigationReferenceJSON = (reference) => orderedJSON(reference || null);

export const ipadPoseSeedHash = (seed) => sha256Bytes(new TextEncoder().encode(ipadPoseSeedJSON(seed)));
export const ipadNavigationReferenceHash = (reference) => sha256Bytes(new TextEncoder().encode(ipadNavigationReferenceJSON(reference)));

export function matchesIPadTransferSnapshot(ticket, manifest, poseHash, navigationHash) {
  return ticket.manifest.modelHash === manifest.modelHash
    && ticket.manifest.byteLength === manifest.byteLength
    && ticket.referencePoseHash === poseHash
    && ticket.navigationReferenceHash === navigationHash;
}
