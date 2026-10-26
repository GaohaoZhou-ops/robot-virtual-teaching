import { Line3, Quaternion, Vector3 } from 'three';
import { isPolylinePlanExecutable, normalizePolyline, samplePolylinePlan } from './polylineTeaching.js';

const compact = (points) => {
  const result = [];
  for (const position of points) {
    const point = new Vector3().fromArray(position);
    if (result.at(-1)?.distanceToSquared(point) < 1e-10) continue;
    while (result.length >= 2 && new Line3(result.at(-2), point)
      .closestPointToPoint(result.at(-1), true, new Vector3()).distanceToSquared(result.at(-1)) < 1e-8) result.pop();
    result.push(point);
  }
  return result.map((point) => point.toArray());
};

// This is a small, session-only hint cache. No plan bypasses current IK,
// interpolation, collision checks, user locks or the actual starting pose.
export function createPolylineSuccessMemory() {
  let entries = [], context = null, serial = 0;
  const select = (key) => { if (key !== context) { entries = []; context = key; } };
  return {
    remember(key, value, plan) {
      select(key);
      const path = normalizePolyline(value);
      if (!path || path.base.sync || path.base.search || !isPolylinePlanExecutable(plan)) return;
      const times = new Set([0, plan.durationMs, ...plan.segments.flatMap((segment) => [segment.startMs, segment.endMs])]);
      // Keep corners and the exact P0 transition, plus regular playback poses.
      // Bound retained data even for a dense or very long authored stroke.
      if (times.size > 128) return;
      for (let i = 1; i < 128; i += 1) times.add(plan.durationMs * i / 128);
      const samples = [...times].sort((a, b) => a - b).map((time) => {
        const sample = samplePolylinePlan(plan, time);
        return { position: [...sample.target], joints: { ...sample.joints } };
      });
      const entry = { key: `successful-plan-${++serial}`, path, quaternion: [...plan.quaternion], samples };
      const geometryKey = (stroke) => JSON.stringify([stroke.pathType, stroke.closed, stroke.points]);
      entries = [entry, ...entries.filter((item) => geometryKey(item.path) !== geometryKey(path))].slice(0, 4);
    },
    guides(key, value, start) {
      select(key);
      const path = normalizePolyline(value);
      if (!path?.points.length || !path.quaternion || path.base.sync || path.base.search || !start) return [];
      const goal = new Vector3().fromArray(path.points[0].position), orientation = new Quaternion().fromArray(path.quaternion);
      const guides = [];
      for (const entry of entries) {
        if (entry.path.side !== path.side || entry.path.base.waistAssist !== path.base.waistAssist
          || entry.path.settings.perpendicularTool !== path.settings.perpendicularTool
          || entry.path.tcpOffset.some((value, i) => Math.abs(value - path.tcpOffset[i]) > 1e-6)
          || !entry.quaternion || orientation.angleTo(new Quaternion().fromArray(entry.quaternion)) > Math.PI / 36) continue;
        const nearest = (target) => entry.samples.reduce((best, sample, index) => {
          const distance = target.distanceToSquared(new Vector3().fromArray(sample.position));
          return distance < best.distance ? { distance, index } : best;
        }, { distance: Infinity, index: -1 });
        const from = nearest(start), to = nearest(goal);
        if (to.distance > .12 ** 2 || from.distance > .25 ** 2) continue;
        const route = entry.samples.slice(Math.min(from.index, to.index), Math.max(from.index, to.index) + 1);
        if (from.index > to.index) route.reverse();
        let waypoints = compact(route.map((sample) => sample.position));
        if (waypoints[0] && start.distanceToSquared(new Vector3().fromArray(waypoints[0])) < 1e-8) waypoints.shift();
        if (waypoints.at(-1) && goal.distanceToSquared(new Vector3().fromArray(waypoints.at(-1))) < 1e-8) waypoints.pop();
        if (waypoints.length > 64) continue;
        guides.push({ referenceKey: entry.key, sourcePathId: entry.path.id, sourcePathName: entry.path.name,
          waypoints, referenceSamples: entry.samples, gap: Math.sqrt(to.distance) });
      }
      return structuredClone(guides.sort((a, b) => a.gap - b.gap).slice(0, 3));
    },
  };
}

// Joint values may change between checks, but kinematics, user constraints and
// the workpiece identity/version must match. The new pose is always rechecked.
export function polylineMemoryContext(robot, geometry, snapshot, lockedJointNames = []) {
  const describe = (node) => {
    const { jointValue, mobileCollision, ...configuration } = node.userData;
    const pose = configuration.jointType ? null : [node.position, node.quaternion];
    return [node.name, pose, node.scale, configuration, mobileCollision && [mobileCollision.linkName, mobileCollision.center, mobileCollision.halfSize],
      node.children.map(describe)];
  };
  return JSON.stringify([geometry.uuid, geometry.getAttribute('position').version ?? geometry.getAttribute('position').data?.version, geometry.getIndex()?.version,
    robot.parent.matrixWorld.toArray(), [...lockedJointNames].sort(), describe(snapshot)]);
}
