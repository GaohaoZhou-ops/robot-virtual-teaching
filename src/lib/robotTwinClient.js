import { ROBOT_TWIN_PREFIX, ROBOT_TWIN_INTERVAL } from './robotTwin.js';
import { ROBOT_TWIN_MONITOR_INTERVAL, ROBOT_TWIN_MONITOR_MAX_AGE } from './robotTwinMonitor.js';
import { RobotTwinCameraClient } from './robotTwinCameraClient.js';
import { forgetRobotTwinCredential, rememberRobotTwinCredential } from './robotTwinCredentials.js';

const isRobotAuthFailure = (error) => ['ROBOT_AUTH_FAILED', 'ROBOT_AUTH_REQUIRED'].includes(error.code);

export class RobotTwinClient {
  constructor({ request = (...args) => globalThis.fetch(...args), onChange = () => {} } = {}) {
    this.request = request; this.onChange = onChange;
    this.generation = 0;
    this.controllers = new Set();
    this.cameraClient = new RobotTwinCameraClient({ request: (path, options) => this.api(path, options),
      onChange: (camera) => this.publish({ camera }) });
    this.state = { active: false, phase: 'idle', pose: null, joints: {}, snapshot: null, motionSample: null, error: '', authFailed: false, credentialError: '',
      monitor: null, monitorPhase: 'idle', monitorError: '', monitorReceivedAt: null, camera: this.cameraClient.state };
  }

  publish(update) { this.state = { ...this.state, ...update }; this.onChange(this.state); }

  async api(path, { binary = false, timeoutMs = 12_000, ...options } = {}, token = this.token) {
    const generation = this.generation;
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      const response = await this.request(ROBOT_TWIN_PREFIX + path, { ...options,
        cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Atlas-Robot-Twin': '1',
          ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]) });
      if (!response.ok) {
        const payload = await response.json();
        const error = Object.assign(new Error(payload.error || '真机连接失败'), { status: response.status, code: payload.code });
        if (path !== '/sessions' && token && token === this.token && generation === this.generation && isRobotAuthFailure(error)) {
          this.authenticationFailed(error);
        }
        throw error;
      }
      return binary ? { blob: await response.blob(), headers: response.headers } : await response.json();
    } finally { this.controllers.delete(controller); }
  }

  release(token) { if (token) void this.api('/session', { method: 'DELETE', keepalive: true }, token).catch(() => {}); }

  disconnect() {
    ++this.generation;
    clearTimeout(this.timer); clearTimeout(this.expiry);
    clearTimeout(this.monitorTimer); clearTimeout(this.monitorExpiry);
    this.cameraClient.reset();
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.release(this.token); this.token = null; this.profile = null;
    this.publish({ active: false, phase: 'idle', pose: null, joints: {}, snapshot: null, motionSample: null, error: '', authFailed: false, credentialError: '', profileId: null,
      monitor: null, monitorPhase: 'idle', monitorError: '', monitorReceivedAt: null });
  }

  authenticationFailed(error) {
    const profile = this.profile;
    const forgotten = !profile || forgetRobotTwinCredential(profile);
    this.disconnect();
    this.publish({ phase: 'error', error: error.message, authFailed: true, profileId: profile?.id,
      credentialError: forgotten ? '' : '浏览器未能清除已失效的密码，请重新输入。' });
  }

  accept(snapshot, elapsed, generation) {
    clearTimeout(this.expiry);
    const poseMs = snapshot.poseValidForMs - elapsed;
    const jointMs = snapshot.jointsValidForMs - elapsed;
    const poseFresh = snapshot.localizationFresh && snapshot.pose && poseMs > 0;
    const jointsFresh = jointMs > 0;
    const live = poseFresh && jointsFresh && snapshot.jointCount === snapshot.expectedJointCount;
    this.publish({ phase: live ? 'live' : 'stale',
      pose: poseFresh ? snapshot.pose : this.state.pose,
      joints: jointsFresh ? { ...this.state.joints, ...snapshot.joints } : this.state.joints,
      snapshot: { ...snapshot, localizationFresh: Boolean(poseFresh), jointCount: jointsFresh ? snapshot.jointCount : 0 },
      error: live ? '' : snapshot.warnings?.join('；') || '正在等待有效的实时定位与姿态',
      lastReceivedAt: Date.now(),
      motionSample: { time: performance.now(), id: snapshot.sampledAt },
    });
    const durations = [poseFresh ? poseMs : 0, jointsFresh ? jointMs : 0].filter((value) => value > 0);
    if (durations.length) this.expiry = setTimeout(() => {
      if (generation === this.generation) this.publish({ phase: 'stale', error: '数据已过期，保留上次位置与姿态，等待恢复',
        snapshot: { ...this.state.snapshot, localizationFresh: false, jointCount: 0 } });
    }, Math.min(...durations));
  }

  async connect(address, password, profileId) {
    this.disconnect();
    const generation = this.generation;
    this.profile = profileId ? { id: profileId, address } : null;
    this.publish({ active: true, phase: 'connecting', address, profileId, error: '', monitorPhase: 'loading' });
    const started = performance.now();
    try {
      const result = await this.api('/sessions', { method: 'POST', body: JSON.stringify({ address, password }) });
      if (generation !== this.generation) { this.release(result.token); return false; }
      this.token = result.token;
      const remembered = !this.profile || rememberRobotTwinCredential(this.profile, password);
      this.publish({ address: result.address, credentialError: remembered ? '' : '浏览器未能记住此密码，下次连接时需要重新输入。' });
      this.accept(result.snapshot, performance.now() - started, generation);
      this.timer = setTimeout(() => this.poll(generation), ROBOT_TWIN_INTERVAL);
      void this.pollMonitor(generation);
      void this.cameraClient.load();
      return true;
    } catch (error) {
      if (generation === this.generation) {
        if (isRobotAuthFailure(error)) this.authenticationFailed(error);
        else this.publish({ active: false, phase: 'error', error: error.message });
      }
      return false;
    }
  }

  async poll(generation) {
    if (generation !== this.generation || !this.token) return;
    const started = performance.now();
    let delay = ROBOT_TWIN_INTERVAL;
    try {
      const snapshot = await this.api('/snapshot');
      if (generation !== this.generation) return;
      this.accept(snapshot, performance.now() - started, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      clearTimeout(this.expiry);
      this.publish({ phase: 'stale', error: error.message,
        snapshot: this.state.snapshot ? { ...this.state.snapshot, localizationFresh: false, jointCount: 0 } : null });
      if (error.status === 401) {
        this.cameraClient.reset();
        this.token = null; clearTimeout(this.monitorTimer); clearTimeout(this.monitorExpiry);
        this.publish({ monitorPhase: 'stale', monitorError: error.message });
        return;
      }
      delay = 1500;
    }
    if (generation === this.generation) this.timer = setTimeout(() => this.poll(generation), delay);
  }

  async pollMonitor(generation) {
    if (generation !== this.generation || !this.token) return;
    const started = performance.now();
    let delay = ROBOT_TWIN_MONITOR_INTERVAL;
    try {
      const monitor = await this.api('/monitor');
      if (generation !== this.generation || !this.token) return;
      const validFor = ROBOT_TWIN_MONITOR_MAX_AGE - monitor.taskAgeMs - (performance.now() - started);
      clearTimeout(this.monitorExpiry);
      this.publish({ monitor, monitorPhase: validFor > 0 ? 'live' : 'stale',
        monitorError: validFor > 0 ? '' : '任务数据已过期，等待恢复', monitorReceivedAt: Date.now() });
      if (validFor > 0) this.monitorExpiry = setTimeout(() => {
        if (generation === this.generation) this.publish({ monitorPhase: 'stale', monitorError: '任务数据已过期，保留上次记录' });
      }, validFor);
    } catch (error) {
      if (generation !== this.generation || !this.token) return;
      clearTimeout(this.monitorExpiry);
      this.publish({ monitorPhase: 'stale', monitorError: error.message });
      delay = 2000;
    }
    if (generation === this.generation && this.token) this.monitorTimer = setTimeout(() => this.pollMonitor(generation), delay);
  }
}
