import { normalizePolyline } from './polylineTeaching.js';

export const POLYLINE_PREFERENCES_KEY = 'atlas-route-studio:polyline-preferences-v1';

// Remember tool/planning parameters and the chosen path type. Authored points,
// record identity, robot poses and checked plans must not carry over.
function parameters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const path = normalizePolyline({ points: [], side: value.side, pathType: value.pathType,
    tcpOffset: value.tcpOffset ?? [0, 0, -0.2], toolAxisDirection: value.toolAxisDirection,
    settings: value.settings, base: value.base });
  if (!path) return null;
  const { side, pathType, tcpOffset, toolAxisDirection, settings, base } = path;
  return { side, pathType, tcpOffset, toolAxisDirection, settings, base };
}

export function loadPolylinePreferences(storage) {
  try {
    const backend = storage === undefined ? globalThis.localStorage : storage;
    const value = JSON.parse(backend?.getItem(POLYLINE_PREFERENCES_KEY) || 'null');
    return value?.version === 1 ? parameters(value) : null;
  } catch {
    return null;
  }
}

export function savePolylinePreferences(path, storage) {
  try {
    const backend = storage === undefined ? globalThis.localStorage : storage;
    const value = parameters(path);
    if (!backend || !value) return false;
    backend.setItem(POLYLINE_PREFERENCES_KEY, JSON.stringify({ version: 1, ...value }));
    return true;
  } catch {
    // Unavailable/full browser storage must not prevent editing or planning.
    return false;
  }
}
