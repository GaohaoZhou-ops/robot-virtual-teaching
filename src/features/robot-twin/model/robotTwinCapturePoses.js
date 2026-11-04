import { ROBOT_TWIN_MAX_AGE } from '../../../shared/protocols/robotTwin.js';

// File saving and algorithm processing can finish well after the arm moves.
// Match capture time to bounded, unsmoothed SLAM history before downloading RGB.
export class RobotTwinCapturePoses {
  constructor() { this.samples = []; }
  reset() { this.samples = []; }
  observe(snapshot) {
    if (!snapshot.localizationFresh || !snapshot.pose || snapshot.jointCount !== 20
      || !Number.isFinite(snapshot.sampledAt)) return;
    if (this.samples.at(-1)?.sampledAt === snapshot.sampledAt) return;
    this.samples.push(structuredClone(snapshot));
    this.samples = this.samples.filter((item) => item.sampledAt >= snapshot.sampledAt - 120_000).slice(-300);
  }
  resolve(capture) {
    const saved = capture.robotPose;
    const time = saved?.capturedAt ?? Date.parse(capture.createdAt);
    if (!Number.isFinite(time)) return null;
    const nearest = this.samples.reduce((best, item) => !best
      || Math.abs(item.sampledAt - time) < Math.abs(best.sampledAt - time) ? item : best, null);
    if (!nearest || Math.abs(nearest.sampledAt - time) > ROBOT_TWIN_MAX_AGE) return null;
    let joints = nearest.joints;
    if (saved) {
      if (saved.modelName !== nearest.modelName || nearest.jointNames?.length !== 20) return null;
      joints = Object.fromEntries(nearest.jointNames.map((name, i) => [name, saved.jointsRad[i] * 180 / Math.PI]));
      if (!Object.values(joints).every(Number.isFinite)) return null;
    }
    return structuredClone({ pose: nearest.pose, joints, capturedAt: time,
      source: saved ? 'capture-joints+sampled-slam' : 'sampled-telemetry',
      sampleOffsetMs: nearest.sampledAt - time });
  }
}
