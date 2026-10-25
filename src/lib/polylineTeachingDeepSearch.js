import { Line3, Vector3 } from 'three';
import { POLYLINE_ALGORITHM_DEFAULTS } from './polylineTeachingParameters.js';

export const POLYLINE_DEEP_SEARCH_LIMIT = POLYLINE_ALGORITHM_DEFAULTS.deepSearchCandidates;
export const POLYLINE_DEEP_SEARCH_BUDGET_MS = POLYLINE_ALGORITHM_DEFAULTS.deepSearchSeconds * 1000;

const compact = (points) => {
  const result = [];
  for (const point of points) {
    if (result.at(-1)?.distanceToSquared(point) < 1e-12) continue;
    while (result.length >= 2 && new Line3(result.at(-2), point)
      .closestPointToPoint(result.at(-1), true, new Vector3()).distanceToSquared(result.at(-1)) < 1e-12) result.pop();
    result.push(point.clone());
  }
  return result;
};

export const polylineApproachTrialKey = (trial) => JSON.stringify([
  (trial.approachWaypoints || []).map((point) => point.map((value) => Math.round(value * 1e6))),
  [...(trial.approachLockedJointNames || [])].sort(),
  trial.referenceKey || '',
]);

// Locate a rejected sample on its particular transit, including all earlier
// bends. A longer route alone is not progress: rank by remaining goal distance.
export function polylineApproachFailureSeed(start, goal, trial, issue) {
  if (issue?.phase !== 'approach' || !issue.collision || !Number.isFinite(issue.distanceFromStart)) return null;
  const chain = [start.clone(), ...(trial.approachWaypoints || []).map((point) => new Vector3().fromArray(point)), goal.clone()];
  if (chain.length > 18) return null;
  let remaining = Math.max(0, issue.distanceFromStart);
  for (let i = 0; i < chain.length - 1; i += 1) {
    const length = chain[i].distanceTo(chain[i + 1]);
    if (length < 1e-8) continue;
    if (remaining <= length + 1e-8 || i === chain.length - 2) {
      const along = Math.min(length, remaining), point = chain[i].clone().lerp(chain[i + 1], along / length);
      return { chain, index: i, along, length, point, remaining: point.distanceTo(goal), trial };
    }
    remaining -= length;
  }
  return null;
}

function ringDirection(from, to, index) {
  const direction = to.clone().sub(from).normalize();
  const axis = Math.abs(direction.z) < .9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
  const up = axis.addScaledVector(direction, -axis.dot(direction)).normalize();
  const side = new Vector3().crossVectors(direction, up).normalize();
  const angle = index * Math.PI / 4;
  return up.multiplyScalar(Math.cos(angle)).addScaledVector(side, Math.sin(angle));
}

// Deterministic, lazy expansion. Local repairs follow the best collision
// location found so far; they retain its earlier route to allow multiple bends.
// All proposals are only waypoints and require the normal full robot validator.
export function* polylineDeepApproachTrials(start, goal, getSeed, postures = []) {
  const axisRoutes = [];
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const current = start.clone(), route = [current.clone()];
    for (const axis of order) { current.setComponent(axis, goal.getComponent(axis)); route.push(current.clone()); }
    const waypoints = compact(route).slice(1, -1).map((point) => point.toArray());
    if (waypoints.length) {
      axisRoutes.push(waypoints);
      yield { approachWaypoints: waypoints, deepStrategy: 'axis-order' };
    }
  }
  // Visit different radii AND directions early. With a wall-clock budget a
  // small-to-large ordering can spend every attempt on the same tiny corridor.
  const distances = [.12, .48, .02, .24, .64, .04, .06];
  const directions = [0, 4, 2, 6, 1, 5, 3, 7];
  for (let round = 0; round < distances.length; round += 1) {
    for (let axis = 0; axis < directions.length; axis += 1) {
      const direction = directions[axis], distance = distances[(round + axis) % distances.length];
      const offset = ringDirection(start, goal, direction).multiplyScalar(distance);
      yield { approachWaypoints: [start.clone().add(offset).toArray(), goal.clone().add(offset).toArray()],
        deepStrategy: 'expanded-detour' };
      const seed = getSeed();
      if (seed) {
        const { chain, index, along, length } = seed, from = chain[index], to = chain[index + 1];
        const lead = from.clone().lerp(to, Math.max(0, along - Math.max(.025, distance / 2)) / length);
        const exit = from.clone().lerp(to, Math.min(length, along + Math.max(.08, distance * 2)) / length);
        const offset = ringDirection(from, to, direction).multiplyScalar(distance);
        const route = compact([...chain.slice(0, index + 1), lead, lead.clone().add(offset),
          exit.clone().add(offset), exit, ...chain.slice(index + 1)]);
        if (route.length <= 18) yield { approachWaypoints: route.slice(1, -1).map((point) => point.toArray()),
          approachLockedJointNames: seed.trial.approachLockedJointNames || [],
          ...(seed.trial.guide ? { guide: seed.trial.guide } : {}),
          ...(seed.trial.memory ? { memory: seed.trial.memory, referenceKey: seed.trial.referenceKey,
            referenceSamples: seed.trial.referenceSamples, preferReference: true } : {}), deepStrategy: 'local-detour' };
      }
    }
  }
  for (const approachLockedJointNames of postures.slice(0, 2)) {
    for (const approachWaypoints of axisRoutes) yield { approachWaypoints, approachLockedJointNames, deepStrategy: 'axis-posture' };
  }
}
