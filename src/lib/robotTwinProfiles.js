import { DEFAULT_ROBOT_TWIN_ADDRESS } from './robotTwin.js';
import { robotTwinColor } from './robotTwinAppearance.js';

export const ROBOT_TWIN_PROFILES_KEY = 'atlas-route-studio:robot-twin-profiles-v1';

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

export function loadRobotTwinProfiles(currentAddress) {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(ROBOT_TWIN_PROFILES_KEY) || 'null');
    if (saved?.version === 1 && Array.isArray(saved.profiles)) {
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
      return { profiles, selectedId, selectedIds };
    }
  } catch { /* Browser storage may be unavailable; connection still works. */ }
  let address = normalizeRobotProfileAddress(DEFAULT_ROBOT_TWIN_ADDRESS);
  try { if (currentAddress) address = normalizeRobotProfileAddress(currentAddress); } catch { /* Use the known default. */ }
  return { profiles: [{ id: 'default-robot', name: 'ABX 机器人', address, color: robotTwinColor('default-robot') }], selectedId: 'default-robot', selectedIds: ['default-robot'] };
}

export function saveRobotTwinProfiles({ profiles, selectedId, selectedIds = selectedId ? [selectedId] : [] }) {
  try {
    if (!globalThis.localStorage) return false;
    // Explicitly persist only connection labels, addresses and colors, never passwords,
    // authentication tokens, live readings or project state.
    globalThis.localStorage.setItem(ROBOT_TWIN_PROFILES_KEY, JSON.stringify({ version: 1, selectedId: selectedIds[0] || '', selectedIds,
      profiles: profiles.map(({ id, name, address, color }) => ({ id, name, address, color })) }));
    return true;
  } catch { return false; }
}
