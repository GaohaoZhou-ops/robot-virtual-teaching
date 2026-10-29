import { RobotTwinClient } from "../client/robotTwinClient.js";
import { robotTwinColor } from "./robotTwinAppearance.js";

export const MAX_TWIN_ROBOTS = 16;

// Sessions and capture callbacks belong to individual robots, even when their
// task/capture IDs happen to be identical. Only the monitor selection is shared.
export class RobotTwinFleet {
  constructor({ onChange = () => {}, createClient = (options) => new RobotTwinClient(options) } = {}) {
    this.onChange = onChange; this.createClient = createClient;
    this.entries = new Map(); this.selectedId = ''; this.generation = 0; this.cameraEpoch = 0;
    this.cameraBarrier = Promise.resolve(); this.publish();
  }

  publish() {
    const robots = [...this.entries.values()].map(({ profile, client }) => ({ ...client.state, ...profile }));
    const active = robots.filter((robot) => robot.active);
    if (!active.some((robot) => robot.id === this.selectedId)) this.selectedId = active[0]?.id || '';
    const selected = this.entries.get(this.selectedId);
    this.state = { phase: 'idle', pose: null, joints: {}, error: '', ...selected?.client.state,
      active: active.length > 0, robots, selectedId: this.selectedId, selectedRobot: selected?.profile,
      connectedCount: active.filter((robot) => robot.phase !== 'connecting').length,
      connecting: Boolean(this.batchPending) || active.some((robot) => robot.phase === 'connecting'),
      authFailed: robots.some((robot) => robot.authFailed),
      authFailureKey: robots.filter((robot) => robot.authFailed).map((robot) => robot.id).join(','),
      access: selected?.access || {} };
    this.onChange(this.state);
  }

  createEntry(profile) {
    const used = new Set([...this.entries.values()].map((entry) => entry.profile.color));
    const color = /^#[0-9a-f]{6}$/i.test(profile.color || '') && !used.has(profile.color)
      ? profile.color : robotTwinColor(profile.id, used);
    profile = { ...profile, color };
    const client = this.createClient({ onChange: () => {
      if (this.entries.get(profile.id)?.client === client) this.publish();
    } });
    const current = () => this.entries.get(profile.id)?.client === client && this.selectedId === profile.id && client.state.active;
    const access = {
      loadCameras: () => current() && client.cameraClient.load(),
      selectCamera: (id) => current() && client.cameraClient.select(id),
      startCamera: async () => {
        const epoch = ++this.cameraEpoch;
        await this.cameraBarrier;
        if (current() && epoch === this.cameraEpoch) await client.cameraClient.start();
      },
      stopCamera: (message) => { if (current()) ++this.cameraEpoch; return client.cameraClient.stop(message); },
      captureCache: client.captureCache,
      readCapture: (id, side, kind, signal) => client.captureCache.read(id, side, kind, signal),
      readCaptureHistory: (runId, offset, signal) => client.api(`/capture-history/${runId}/${offset}`,
        { timeoutMs: 30_000, signal }),
    };
    const entry = { profile, client, access };
    this.entries.set(profile.id, entry); return entry;
  }

  select(id) {
    if (id === this.selectedId || !this.entries.get(id)?.client.state.active) return;
    ++this.cameraEpoch;
    const previous = this.entries.get(this.selectedId)?.client;
    this.selectedId = id;
    // Stop polling immediately; wait for unsubscribe before starting another.
    const stopped = previous?.cameraClient.stop();
    this.cameraBarrier = Promise.allSettled([this.cameraBarrier, stopped]);
    this.publish();
  }

  async connectMany(profiles) {
    if (this.batchPending) return false;
    if (!profiles.length || profiles.length > MAX_TWIN_ROBOTS) throw new Error(`请选择 1 至 ${MAX_TWIN_ROBOTS} 台机器人`);
    if (new Set(profiles.map((item) => item.id)).size !== profiles.length
      || new Set(profiles.map((item) => item.address)).size !== profiles.length) throw new Error('不能重复连接同一台机器人');
    const generation = this.generation;
    this.batchPending = true;
    const ids = new Set(profiles.map((item) => item.id));
    for (const [id, entry] of this.entries) {
      if (!ids.has(id)) { this.entries.delete(id); entry.client.onChange = () => {}; entry.client.disconnect(); }
    }
    const entries = profiles.map(({ password, ...profile }) => {
      let entry = this.entries.get(profile.id);
      if (entry && entry.profile.address !== profile.address) {
        entry.client.onChange = () => {}; entry.client.disconnect(); this.entries.delete(profile.id); entry = null;
      }
      entry ||= this.createEntry(profile);
      entry.profile = { ...profile, color: entry.profile.color }; return { entry, password };
    });
    this.publish();
    try {
      const results = await Promise.all(entries.map(({ entry, password }) => entry.client.state.active
        ? true : entry.client.connect(entry.profile.address, password, entry.profile.id)));
      return generation === this.generation && results.every(Boolean);
    } finally {
      if (generation === this.generation) { this.batchPending = false; this.publish(); }
    }
  }

  stopCameras() {
    ++this.cameraEpoch;
    this.cameraBarrier = Promise.allSettled([this.cameraBarrier,
      ...[...this.entries.values()].map(({ client }) => client.cameraClient.stop())]);
  }

  disconnect() {
    ++this.generation; ++this.cameraEpoch;
    const entries = [...this.entries.values()];
    this.entries.clear(); this.selectedId = ''; this.batchPending = false;
    for (const { client } of entries) { client.onChange = () => {}; client.disconnect(); }
    this.publish();
  }
}
