import { ipadRequest, packIPadModel } from './ipadTeaching.js';
import { buildIPadPoseSeed } from './ipadPoseSeed.js';
import { ipadPoseSeedHash, matchesIPadTransferSnapshot } from './ipadTransferSnapshot.js';

export async function prepareIPadTransfer({ ticket, mapData, teachingTasks, device = 'ipad',
  forceNew = false, preserveSnapshot = false, renew = false,
  request = ipadRequest, onUpdate = () => {}, onProgress = () => {} }) {
  let next = forceNew ? null : ticket;
  if (next) next = { ...next, ...await request(`/sessions/${next.id}`, { token: next.ownerToken }) };
  let packed, poseSeed;
  // Receiving results and explicitly browsing history must keep their original
  // session. A send/pair action uses the current model and current optical poses.
  const checkSnapshot = device === 'ipad' && !preserveSnapshot
    && !['completed', 'imported'].includes(next?.status);
  if (checkSnapshot || !next || next.status === 'preparing' || (next.status === 'cancelled' && !preserveSnapshot)) {
    onProgress('正在校验当前物体与 Pose…');
    packed = await packIPadModel(mapData);
    poseSeed = device === 'ipad' ? buildIPadPoseSeed(teachingTasks, mapData, packed.manifest) : undefined;
    if (checkSnapshot && next && !matchesIPadTransferSnapshot(next, packed.manifest, await ipadPoseSeedHash(poseSeed))) {
      // Create a separate frozen transfer; never rewrite an iPad's existing
      // session and thereby discard locally recorded, edited or deleted poses.
      next = null;
    }
  }
  if (!next || (next.status === 'cancelled' && !preserveSnapshot)) {
    next = { ...await request('/sessions', { method: 'POST',
      body: { manifest: packed.manifest, targetDevice: device, poseSeed } }), targetDevice: device };
    onUpdate(next);
  }
  if (next.status === 'preparing') {
    if (next.manifest.modelHash !== packed.manifest.modelHash || next.manifest.byteLength !== packed.manifest.byteLength) {
      throw new Error('当前物体已改变，请点击「新建传输」重新准备模型。');
    }
    onProgress('正在准备模型与配对信息…');
    next = { ...next, ...await request(`/sessions/${next.id}/model`, {
      token: next.ownerToken, method: 'PUT', body: packed.buffer }) };
  }
  if (['ready', 'paired'].includes(next.status)
    && (renew || Date.now() >= next.pairingExpiresAt || !/^[A-Z0-9]{4}$/.test(next.pairingCode || ''))) {
    next = { ...next, ...await request(`/sessions/${next.id}/renew`, { token: next.ownerToken, method: 'POST' }) };
  }
  onUpdate(next);
  return next;
}
