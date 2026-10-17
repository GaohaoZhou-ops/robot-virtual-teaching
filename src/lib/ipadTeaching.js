import { sha256Bytes } from './hash.js';
import { IPAD_PROTOCOL, MAX_MODEL_BYTES, MAX_MODEL_VERTICES, MAX_MODEL_INDICES, validateIPadResult, mobileDeviceLabel } from './ipadProtocol.js';

export const IPAD_API = '/__atlas/ipad';
const ticketKey = 'atlas-ipad-handoffs-v1';

export async function ipadRequest(path, { token, body, method = 'GET', ...options } = {}) {
  const response = await fetch(`${IPAD_API}${path}`, {
    ...options, method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body != null ? { 'Content-Type': body instanceof ArrayBuffer ? 'application/octet-stream' : 'application/json' } : {}) },
    body: body == null ? undefined : body instanceof ArrayBuffer ? body : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `局域网服务返回 ${response.status}`);
  return result;
}

export async function packIPadModel(mapData) {
  const geometry = mapData?.geometry;
  const positions = geometry?.getAttribute('position'), colors = geometry?.getAttribute('color');
  if (!positions?.count) throw new Error('请先加载独立示教物体');
  const sourceIndex = geometry.getIndex();
  // Preserve source geometry; display budgets are selected locally on the iPad.
  const vertices = positions.count, indices = sourceIndex?.count || 0;
  if (vertices > MAX_MODEL_VERTICES || indices > MAX_MODEL_INDICES || 32 + vertices * 16 + indices * 4 > MAX_MODEL_BYTES) {
    throw new Error('物体超过 iPad 传输上限（500 万顶点、1000 万三角面、192 MiB），请先精简源模型后重试');
  }
  if (indices % 3 !== 0) throw new Error('物体三角面索引不完整');
  const buffer = new ArrayBuffer(32 + vertices * 16 + indices * 4);
  const view = new DataView(buffer);
  view.setUint32(0, 0x534c5441, true); view.setUint32(4, 1, true);
  view.setUint32(8, vertices, true); view.setUint32(12, indices, true);
  for (let i = 0; i < vertices; i += 1) {
    const source = i;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions.getComponent(source, axis);
      if (!Number.isFinite(value)) throw new Error('物体含无效坐标，无法移动到 iPad');
      view.setFloat32(32 + (i * 3 + axis) * 4, value, true);
      // Three.js vertex colours are linear; SceneKit's vertex colours are linear too.
      view.setUint8(32 + vertices * 12 + i * 4 + axis, colors ? Math.round(Math.max(0, Math.min(1, colors.getComponent(source, axis))) * 255) : [92, 210, 222][axis]);
    }
    view.setUint8(32 + vertices * 12 + i * 4 + 3, 255);
    if (i % 100000 === 99999) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  for (let i = 0; i < indices; i += 1) {
    const index = sourceIndex.getX(i);
    if (!Number.isInteger(index) || index < 0 || index >= vertices) throw new Error('物体三角面索引越界');
    view.setUint32(32 + vertices * 16 + i * 4, index, true);
    if (i % 500000 === 499999) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const modelHash = await sha256Bytes(buffer);
  return { buffer, manifest: { protocol: IPAD_PROTOCOL, modelHash,
    name: mapData.name, sourceHash: mapData.sourceHash || modelHash,
    sourceMapId: mapData.mapId || '', coordinateFrame: 'virtual_origin',
    distanceUnit: 'meter', verticalAxis: 'Z', vertices, indices, sampled: false,
    originalVertices: positions.count, byteLength: buffer.byteLength, bounds: mapData.bounds } };
}

export function readIPadTickets() {
  try { const items = JSON.parse(localStorage.getItem(ticketKey) || '[]'); return Array.isArray(items) ? items : []; }
  catch { return []; }
}

export function mobileTicketDevice(ticket) {
  // Older transfers have no device selection; retain their original iPad entry.
  // Once paired, the native app's device name takes precedence over that selection.
  if (/vision\s*pro/i.test(ticket?.deviceName || '')) return 'vision';
  if (/ipad/i.test(ticket?.deviceName || '')) return 'ipad';
  return ticket?.targetDevice === 'vision' ? 'vision' : 'ipad';
}

export function readDeviceTickets(device) {
  return readIPadTickets().filter((item) => item?.id && item.manifest && mobileTicketDevice(item) === device)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function rememberIPadTicket(ticket) {
  const tickets = readIPadTickets();
  localStorage.setItem(ticketKey, JSON.stringify([ticket, ...tickets.filter((item) => item.id !== ticket.id)]));
}

export class IPadModelMismatchError extends Error {
  constructor(mapData, manifest, deviceLabel, message) {
    super(message || `当前独立示教地图与 ${deviceLabel} 的模型内容不一致，已停止接收。`);
    this.name = 'IPadModelMismatchError';
    this.currentModelName = mapData?.name || '未加载地图';
    this.incomingModelName = manifest?.name || '未知地图';
    this.deviceLabel = deviceLabel;
  }
}

export async function ipadResultTask(result, ticket, mapData) {
  validateIPadResult(result, ticket.manifest, ticket.id);
  // Recompute on every receipt, including duplicate imports. Never trust names,
  // cached IDs or source hashes: the current geometry may have changed since pairing.
  const { manifest } = await packIPadModel(mapData);
  if (manifest.modelHash !== ticket.manifest.modelHash || manifest.byteLength !== ticket.manifest.byteLength) {
    throw new IPadModelMismatchError(mapData, ticket.manifest, mobileDeviceLabel(result));
  }
  return { id: `ipad-${result.id}`, name: `${mobileDeviceLabel(result)} 示教 · ${ticket.manifest.name}`,
    createdAt: result.createdAt, updatedAt: result.completedAt, coordinateFrame: 'virtual_origin',
    robot: {}, map: { id: mapData.mapId, fileName: mapData.name, sourceHash: mapData.sourceHash,
      teachingSpaceMode: 'independent', coordinateFrame: 'virtual_origin' },
    parkingPoints: [], mobileCapture: result };
}
