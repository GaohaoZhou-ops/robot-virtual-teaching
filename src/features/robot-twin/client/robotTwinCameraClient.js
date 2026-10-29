import { ROBOT_CAMERA_INTERVAL, ROBOT_CAMERA_MAX_AGE, isBodyCamera } from "../../../shared/protocols/robotTwinCamera.js";

const initialState = () => ({ cameras: [], catalogPhase: 'idle', catalogError: '', selected: '',
  phase: 'idle', wanted: false, imageUrl: null, error: '', width: 0, height: 0, fps: 0 });

async function decodeFrame(url, signal) {
  // Protocol-only Node tests have no image decoder; browsers always predecode.
  if (typeof Image === 'undefined') return null;
  const image = new Image(); image.decoding = 'async';
  let abort;
  try {
    signal.throwIfAborted();
    const cancelled = new Promise((_, reject) => {
      abort = () => { image.src = ''; reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
    });
    image.src = url;
    await Promise.race([image.decode(), cancelled]);
    return image;
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

export class RobotTwinCameraClient {
  constructor({ request, onChange = () => {}, decode = decodeFrame }) {
    this.request = request; this.onChange = onChange; this.decode = decode;
    this.epoch = 0; this.catalogEpoch = 0; this.state = initialState();
  }
  publish(update) { this.state = { ...this.state, ...update }; this.onChange(this.state); }
  clearImage() {
    if (this.state.imageUrl) URL.revokeObjectURL(this.state.imageUrl);
    if (this.previousImageUrl) URL.revokeObjectURL(this.previousImageUrl);
    this.previousImageUrl = null; this.decodedImage = null;
  }
  cancel() {
    clearTimeout(this.timer); clearTimeout(this.expiry); this.controller?.abort();
    this.clearImage(); this.lastSequence = ''; this.frameTimes = [];
  }
  reset() {
    ++this.epoch; ++this.catalogEpoch; this.catalogController?.abort(); this.cancel();
    this.mayHaveLease = false; this.state = initialState(); this.onChange(this.state);
  }
  async load() {
    const epoch = ++this.catalogEpoch;
    this.catalogController?.abort(); this.catalogController = new AbortController();
    this.publish({ catalogPhase: 'loading', catalogError: '' });
    try {
      const { cameras } = await this.request('/cameras', { signal: this.catalogController.signal });
      if (epoch !== this.catalogEpoch) return;
      const selected = cameras.some((item) => item.id === this.state.selected && item.available)
        ? this.state.selected : cameras.find((item) => item.available)?.id || '';
      this.publish({ cameras, selected, catalogPhase: 'ready' });
    } catch (error) {
      if (epoch === this.catalogEpoch) this.publish({ catalogPhase: 'error', catalogError: error.message });
    }
  }
  select(id) {
    if (!this.state.cameras.some((item) => item.id === id && item.available)) return;
    if (this.state.wanted) void this.start(id);
    else this.publish({ selected: id, error: '' });
  }
  async start(id = this.state.selected) {
    if (!isBodyCamera(id) || !this.state.cameras.some((item) => item.id === id && item.available)) return;
    const epoch = ++this.epoch; this.cancel(); this.controller = new AbortController();
    this.mayHaveLease = true;
    this.publish({ selected: id, phase: 'starting', wanted: true, imageUrl: null, error: '', fps: 0 });
    try {
      await this.request('/camera', { method: 'PUT', body: JSON.stringify({ camera: id, revision: epoch }), signal: this.controller.signal });
      if (epoch === this.epoch && this.state.wanted) void this.frame(epoch);
    } catch (error) {
      if (epoch === this.epoch) await this.stop(error.message);
    }
  }
  async stop(message = '', keepalive = false) {
    const epoch = ++this.epoch; this.cancel(); this.controller = new AbortController();
    this.publish({ wanted: false, imageUrl: null, phase: this.mayHaveLease ? 'stopping' : message ? 'error' : 'idle', error: message, fps: 0 });
    if (!this.mayHaveLease) return;
    try {
      await this.request('/camera', { method: 'PUT', body: JSON.stringify({ camera: null, revision: epoch }),
        keepalive, signal: this.controller.signal });
      if (epoch !== this.epoch) return;
      this.mayHaveLease = false;
      this.publish({ phase: message ? 'error' : 'idle' });
    } catch (error) {
      if (epoch === this.epoch) this.publish({ phase: 'error', error: `${message ? message + '；' : ''}关闭订阅未确认：${error.message}` });
    }
  }
  async frame(epoch) {
    if (epoch !== this.epoch || !this.state.wanted) return;
    const started = performance.now(); let delay = ROBOT_CAMERA_INTERVAL;
    let pendingUrl;
    try {
      const { blob, headers } = await this.request('/camera/frame', { binary: true,
        headers: { 'X-Atlas-Camera-Revision': String(epoch) }, signal: this.controller.signal });
      if (epoch !== this.epoch || !this.state.wanted) return;
      if (headers.get('X-Atlas-Camera') !== this.state.selected || headers.get('X-Atlas-Camera-Revision') !== String(epoch)
        || blob.type !== 'image/jpeg') throw new Error('相机画面与当前选择不匹配');
      const sequence = headers.get('X-Atlas-Frame-Sequence');
      if (sequence !== this.lastSequence) {
        pendingUrl = URL.createObjectURL(blob);
        const decoded = await this.decode(pendingUrl, this.controller.signal);
        if (epoch !== this.epoch || !this.state.wanted) return;
        // Keep the displayed URL valid until its decoded replacement has been
        // presented. Retain one previous frame for both sidebar and dialog.
        if (this.previousImageUrl) URL.revokeObjectURL(this.previousImageUrl);
        this.previousImageUrl = this.state.imageUrl;
        this.decodedImage = decoded;
        const imageUrl = pendingUrl; pendingUrl = null; this.lastSequence = sequence;
        const now = performance.now(); this.frameTimes.push(now); this.frameTimes = this.frameTimes.filter((time) => time >= now - 3000);
        const fps = this.frameTimes.length > 1 ? (this.frameTimes.length - 1) * 1000 / (now - this.frameTimes[0]) : 0;
        this.publish({ imageUrl, phase: 'live', error: '', width: Number(headers.get('X-Atlas-Frame-Width')),
          height: Number(headers.get('X-Atlas-Frame-Height')), fps });
        clearTimeout(this.expiry);
        this.expiry = setTimeout(() => {
          if (epoch !== this.epoch) return;
          this.publish({ phase: 'stale', error: '画面暂未更新，保留最后一帧，正在等待恢复' });
        }, ROBOT_CAMERA_MAX_AGE);
      }
    } catch (error) {
      if (epoch !== this.epoch || !this.state.wanted) return;
      clearTimeout(this.expiry);
      this.publish({ phase: 'stale', error: error.name === 'EncodingError' ? '新画面解码失败，等待下一帧' : error.message });
      if ([401, 403, 409].includes(error.status)) { await this.stop(error.message); return; }
      delay = 600;
    } finally {
      if (pendingUrl) URL.revokeObjectURL(pendingUrl);
      if (epoch === this.epoch && this.state.wanted) this.timer = setTimeout(() => void this.frame(epoch), Math.max(0, delay - (performance.now() - started)));
    }
  }
}
