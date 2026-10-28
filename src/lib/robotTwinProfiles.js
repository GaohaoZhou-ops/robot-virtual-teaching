import { DEFAULT_ROBOT_TWIN_ADDRESS } from './robotTwin.js';
import { robotTwinColor } from './robotTwinAppearance.js';

export const ROBOT_TWIN_PROFILES_KEY = 'atlas-route-studio:robot-twin-profiles-v1';
export const ROBOT_TWIN_PROFILES_CHANGED = 'atlas:robot-twin-profiles-restored';

// Match the server's LAN address restrictions before saving a card. The server
// still validates every connection independently; this only improves form errors.
export function normalizeRobotProfileAddress(value) {
  let url;
  const input = String(value || '').trim();
  try { url = new URL(input.includes('://') ? input : `http://${input}`); }
  catch { throw new Error('请输入有效的局域网 IPv4 地址和端口，例如 192.168.0.112:9090'); }
  const [a, b] = url.hostname.split('.').map(Number);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)
    || !(a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31))
    || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('请填写局域网 IPv4 地址和端口，不要包含账号、接口路径或查询参数');
  }
  return url.origin;
}

export const robotProfileAddressLabel = (address) => address.replace(/^http:\/\//, '');

// Shared by browser storage and portable projects. Copy an explicit allowlist;
// credentials, sessions and live telemetry never belong to this configuration.
export function normalizeRobotTwinProfiles(saved) {
  if (saved?.version !== 1 || !Array.isArray(saved.profiles)) return null;
  const ids = new Set(), addresses = new Set(), profiles = [];
  for (const item of saved.profiles) {
    try {
      if (typeof item?.id !== 'string' || !item.id || item.id.length > 100
        || typeof item.name !== 'string' || !item.name.trim()) continue;
      const address = normalizeRobotProfileAddress(item.address);
      if (ids.has(item.id) || addresses.has(address)) continue;
      ids.add(item.id); addresses.add(address);
      const color = /^#[0-9a-f]{6}$/i.test(item.color || '') ? item.color
        : robotTwinColor(item.id, new Set(profiles.map((profile) => profile.color)));
      profiles.push({ id: item.id, name: item.name.trim().slice(0, 64), address, color });
    } catch { /* A damaged card must not hide the remaining saved robots. */ }
  }
  const selectedId = ids.has(saved.selectedId) ? saved.selectedId : profiles[0]?.id || '';
  const selectedIds = Array.isArray(saved.selectedIds)
    ? [...new Set(saved.selectedIds.filter((id) => ids.has(id)))] : selectedId ? [selectedId] : [];
  return { version: 1, profiles, selectedId: selectedIds[0] || '', selectedIds };
}

function readSavedProfiles() {
  try {
    return normalizeRobotTwinProfiles(JSON.parse(globalThis.localStorage?.getItem(ROBOT_TWIN_PROFILES_KEY) || 'null'));
  } catch { return null; }
}

export function loadRobotTwinProfiles(currentAddress) {
  const saved = readSavedProfiles();
  if (saved) return saved;
  let address = normalizeRobotProfileAddress(DEFAULT_ROBOT_TWIN_ADDRESS);
  try { if (currentAddress) address = normalizeRobotProfileAddress(currentAddress); } catch { /* Use the known default. */ }
  return { version: 1, profiles: [{ id: 'default-robot', name: 'ABX 机器人', address, color: robotTwinColor('default-robot') }], selectedId: 'default-robot', selectedIds: ['default-robot'] };
}

export function saveRobotTwinProfiles({ profiles, selectedId, selectedIds = selectedId ? [selectedId] : [] }) {
  try {
    if (!globalThis.localStorage) return false;
    const saved = normalizeRobotTwinProfiles({ version: 1, profiles, selectedIds });
    if (!saved) return false;
    globalThis.localStorage.setItem(ROBOT_TWIN_PROFILES_KEY, JSON.stringify(saved));
    return true;
  } catch { return false; }
}

export function restoreRobotTwinProfiles(value) {
  const incoming = normalizeRobotTwinProfiles(value);
  if (!incoming) return true; // Older projects leave this device's cards alone.
  const profiles = [...(readSavedProfiles()?.profiles || [])], mappedIds = new Map();
  for (const profile of incoming.profiles) {
    const index = profiles.findIndex((item) => item.address === profile.address);
    let id = index >= 0 ? profiles[index].id : profile.id;
    // Same endpoint keeps the local ID (and its local password). An ID collision
    // with another endpoint gets a new ID and must never inherit that login.
    if (index < 0) {
      let suffix = 1;
      while (profiles.some((item) => item.id === id)) id = `${profile.id.slice(0, 80)}-import-${suffix++}`;
      profiles.push({ ...profile, id });
    } else profiles[index] = { ...profile, id };
    mappedIds.set(profile.id, id);
  }
  const importedIds = new Set(mappedIds.values());
  const saved = saveRobotTwinProfiles({
    profiles: [...incoming.profiles.map((profile) => profiles.find((item) => item.id === mappedIds.get(profile.id))),
      ...profiles.filter((profile) => !importedIds.has(profile.id))],
    selectedIds: incoming.selectedIds.map((id) => mappedIds.get(id)),
  });
  if (saved) globalThis.dispatchEvent?.(new Event(ROBOT_TWIN_PROFILES_CHANGED));
  return saved;
}
