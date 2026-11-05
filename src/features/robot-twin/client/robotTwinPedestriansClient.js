import { ROBOT_PEDESTRIANS_INTERVAL, ROBOT_PEDESTRIAN_VISIBLE_MS } from '../../../shared/protocols/robotTwinPedestrians.js';

const idle = () => ({ enabled: false, phase: 'idle', boxes: [], frame: null, expiresAt: 0, message: '' });

export class RobotTwinPedestriansClient {
  constructor({ request, getPose, onChange = () => {}, externallyClocked = false }) {
    this.request = request; this.getPose = getPose; this.onChange = onChange;
    this.externallyClocked = externallyClocked; this.nextDue = 0;
    this.state = idle(); this.generation = 0; this.visible = true;
  }

  publish(update) { this.state = { ...this.state, ...update, generation: this.generation }; this.onChange(this.state); }

  cancel() {
    ++this.generation;
    clearTimeout(this.timer); clearTimeout(this.expiry);
    this.timer = null;
    this.controller?.abort(); this.controller = null;
    this.nextDue = 0;
  }

  reset() { this.cancel(); this.publish(idle()); }

  setEnabled(enabled) {
    if (!enabled) { this.reset(); return; }
    if (this.state.enabled) return;
    this.cancel(); this.failures = 0;
    this.publish({ ...idle(), enabled: true, phase: this.visible ? 'loading' : 'paused', message: '' });
    if (this.visible && !this.externallyClocked) void this.poll(this.generation);
  }

  setVisible(visible) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (!this.state.enabled) return;
    this.cancel();
    this.publish({ boxes: [], frame: null, expiresAt: 0, phase: visible ? 'loading' : 'paused',
      message: visible ? '' : '页面在后台，已暂停读取' });
    if (visible && !this.externallyClocked) void this.poll(this.generation);
  }

  // The owning robot starts both reads in the same telemetry cycle. No second
  // periodic clock can drift half a packet behind/ahead of the robot's pose.
  tick() {
    if (!this.state.enabled || !this.visible || this.controller || this.timer) return;
    const remaining = Math.max(0, this.nextDue - performance.now());
    if (remaining > 100) return;
    const generation = this.generation;
    // A few milliseconds of HTTP skew must not skip an entire 500 ms cycle.
    // Respect the proxy's rate window within this cycle, without a free-running
    // timer or a catch-up burst. Longer error backoffs wait for later ticks.
    if (remaining) this.timer = setTimeout(() => { this.timer = null; void this.poll(generation); }, remaining);
    else void this.poll(generation);
  }

  async poll(generation) {
    if (generation !== this.generation || !this.state.enabled || !this.visible) return;
    const controller = new AbortController(); this.controller = controller;
    const started = performance.now();
    let delay = ROBOT_PEDESTRIANS_INTERVAL;
    try {
      const result = await this.request('/pedestrians', { signal: controller.signal, timeoutMs: 5000 });
      if (generation !== this.generation) return;
      const transportMs = Math.max(0, performance.now() - started - (result.serverProcessingMs || 0));
      const validForMs = Math.max(0, result.validForMs - transportMs);
      const receivedAt = performance.now();
      const currentPose = this.getPose();
      const live = result.phase === 'live' && validForMs > 0 && Boolean(currentPose);
      // Keep an accepted frame separate from the network's freshness status.
      // The renderer can briefly retain a lost track without calling it live,
      // or renewing its lifetime when the proxy repeats a cached result.
      const frame = live && result.sampleId !== this.state.frame?.id ? {
        id: result.sampleId, receivedAt, sourceTime: receivedAt - (result.sampleAgeMs || 0) - transportMs,
        boxes: result.boxes,
      } : this.state.frame;
      clearTimeout(this.expiry);
      this.publish({ phase: live ? 'live' : result.phase === 'live' ? 'waiting' : result.phase,
        boxes: live ? result.boxes : [],
        frame,
        expiresAt: live ? performance.now() + validForMs : 0,
        message: result.message || (!currentPose ? '定位暂不可用，等待恢复后显示行人'
          : !live ? '行人感知已过期，等待新结果' : '') });
      this.failures = 0;
      if (live) this.expiry = setTimeout(() => {
        if (generation === this.generation) this.publish({ phase: 'waiting', boxes: [], expiresAt: 0,
          message: '行人感知已过期，等待新结果' });
      }, validForMs);
      if (result.phase === 'unavailable') { this.publish({ enabled: false, frame: null }); return; }
      const recent = frame && receivedAt - frame.receivedAt < ROBOT_PEDESTRIAN_VISIBLE_MS;
      delay = result.phase === 'live' || recent
        ? Math.max(25, Math.min(ROBOT_PEDESTRIANS_INTERVAL, result.nextPollAfterMs ?? ROBOT_PEDESTRIANS_INTERVAL)) : 2000;
    } catch (error) {
      if (generation !== this.generation) return;
      clearTimeout(this.expiry);
      this.publish({ phase: 'error', boxes: [], expiresAt: 0, message: error.message });
      if (error.status === 401 || error.code === 'ROBOT_PEDESTRIANS_UNAVAILABLE') {
        this.publish({ enabled: false, frame: null }); return;
      }
      delay = Math.min(3000, ROBOT_PEDESTRIANS_INTERVAL * 2 ** Math.min(this.failures++, 3));
    } finally { if (this.controller === controller) this.controller = null; }
    if (generation === this.generation && this.state.enabled && this.visible) {
      this.nextDue = performance.now() + delay;
      if (!this.externallyClocked) this.timer = setTimeout(() => void this.poll(generation), delay);
    }
  }
}
