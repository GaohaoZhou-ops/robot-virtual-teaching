import { normalizeRobotProfileAddress } from "../model/robotTwinProfiles.js";

export const ROBOT_TWIN_CREDENTIALS_KEY = 'atlas-route-studio:robot-twin-credentials-v1';

// Kept separate from card metadata and project exports. A credential belongs to
// both the card and its address, so editing a target cannot reuse another login.
export function loadRobotTwinCredentials() {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(ROBOT_TWIN_CREDENTIALS_KEY) || 'null');
    if (saved?.version !== 1 || !Array.isArray(saved.credentials)) return [];
    return saved.credentials.flatMap((item) => {
      try {
        return typeof item?.id === 'string' && item.id && typeof item.password === 'string'
          ? [{ id: item.id, address: normalizeRobotProfileAddress(item.address), password: item.password }] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

function write(credentials) {
  try {
    if (!globalThis.localStorage) return false;
    globalThis.localStorage.setItem(ROBOT_TWIN_CREDENTIALS_KEY, JSON.stringify({ version: 1, credentials }));
    return true;
  } catch { return false; }
}

export function rememberRobotTwinCredential({ id, address }, password) {
  return write([...loadRobotTwinCredentials().filter((item) => item.id !== id), { id, address, password }]);
}

export function forgetRobotTwinCredential({ id, address }) {
  return write(loadRobotTwinCredentials().filter((item) => item.id !== id || item.address !== address));
}
