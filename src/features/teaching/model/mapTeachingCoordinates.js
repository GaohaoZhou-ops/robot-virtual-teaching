import { mapTeachingCalibrationMatrix, transferMatrix, transformTeachingPose, transformTeachingTasks } from './teachingCoordinates.js';
import { calculatePathDistances } from '../../navigation/model/pathMetrics.js';

const axes = ['x', 'y', 'z'], angles = ['roll', 'pitch', 'yaw'];
const asPose = (value) => ({ position: Object.fromEntries(axes.map((axis) => [axis, value?.[axis] ?? 0])),
  rpy: Object.fromEntries(angles.map((axis) => [axis, value?.[axis] ?? 0])) });
const byId = (values) => new Map((values || []).map((value) => [value.id, value]));
const sameNumbers = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameNumbers(a[key], b[key]));
};
export function sameMapTeachingPose(a, b, flat = false) {
  if (!a || !b) return false;
  try {
    const first = transferMatrix(flat ? asPose(a) : a).elements;
    const second = transferMatrix(flat ? asPose(b) : b).elements;
    return first.every((value, index) => Math.abs(value - second[index]) < 1e-9);
  } catch { return false; }
}

// A calibration definition may be copied into a placement/alignment marker;
// coordinate backups belong only to the workspace that owns the display data.
export const mapTeachingMatrixDefinition = (record) => record ? {
  version: record.version, name: record.name, values: [...record.values],
} : null;

// Keep exact source readings, without duplicating joints, media or task records.
// A source value is reused only while the displayed value still represents it.
export function snapshotMapTeachingCoordinates(payload) {
  const point = (value) => ({ id: value.id, mapPose: value.mapPose,
    ...(value.opticalTargets ? { opticalTargets: value.opticalTargets } : {}),
    ...(value.cameraCapture ? { cameraPoses: Object.fromEntries(Object.entries(value.cameraCapture.frames || {})
      .map(([side, camera]) => [side, camera.opticalPose])) } : {}),
  });
  return structuredClone({ version: 1,
    waypoints: (payload.waypoints || []).map(({ id, pose }) => ({ id, pose })),
    ...(payload.robot?.origin ? { robotOrigin: payload.robot.origin } : {}),
    tasks: (payload.virtualTeaching?.tasks || []).map((task) => ({ id: task.id,
      ...(task.polylines ? { polylines: task.polylines } : {}),
      ...(task.mobileTransform ? { mobileTransform: task.mobileTransform } : {}),
      parkingPoints: (task.parkingPoints || []).map((parking) => ({ ...point(parking), poses: (parking.poses || []).map(point) })),
    })),
  });
}

export const sameMapTeachingCoordinates = (first, second) => sameNumbers(
  snapshotMapTeachingCoordinates(first), snapshotMapTeachingCoordinates(second),
);

function transformPayload(payload, matrix) {
  const tasks = payload.virtualTeaching?.tasks || [];
  const transformed = transformTeachingTasks(tasks, matrix, 'map', {}).map((task, index) => ({ ...task, map: tasks[index].map }));
  return { ...payload,
    waypoints: (payload.waypoints || []).map((point) => {
      const result = transformTeachingPose(asPose(point.pose), matrix);
      const pose = { ...result.position, ...result.rpy };
      return { ...point, pose, ...(point.xzy ? { xzy: [pose.x, pose.z, pose.y] } : {}),
        ...(point.rpy ? { rpy: angles.map((axis) => pose[axis]) } : {}) };
    }),
    ...(payload.robot?.origin ? { robot: { ...payload.robot,
      origin: transformTeachingPose(payload.robot.origin, matrix, payload.robot.origin.frameId) } } : {}),
    virtualTeaching: { ...payload.virtualTeaching, tasks: transformed },
  };
}

function restoreExactCoordinates(result, displayed, sources) {
  const waypointSources = byId(sources?.waypoints);
  const routeSources = new Map((displayed.abxRoutes || []).map((route) => [route.id, byId(route.nodes)]));
  result.waypoints = result.waypoints.map((point, index) => {
    const original = routeSources.get(point.abx?.routeId)?.get(point.abx?.nodeId);
    const native = original && { x: original.x_m, y: original.y_m, z: 0, roll: 0, pitch: 0,
      yaw: (original.yaw_rad ?? 0) * 180 / Math.PI };
    const source = [waypointSources.get(point.id)?.pose, native].find((pose) => sameMapTeachingPose(point.pose, pose, true));
    const pose = source || (!waypointSources.has(point.id) && sameMapTeachingPose(displayed.waypoints[index].pose, native, true) ? native : point.pose);
    return { ...point, pose: structuredClone(pose), ...(point.xzy ? { xzy: [pose.x, pose.z, pose.y] } : {}),
      ...(point.rpy ? { rpy: angles.map((axis) => pose[axis]) } : {}) };
  });
  if (sameMapTeachingPose(result.robot?.origin, sources?.robotOrigin)) result.robot.origin = structuredClone(sources.robotOrigin);
  const taskSources = byId(sources?.tasks);
  const restorePoint = (point, source, display) => {
    const pose = [source?.mapPose, point.abx?.mapPose].find((value) => sameMapTeachingPose(point.mapPose, value));
    if (pose) point.mapPose = structuredClone(pose);
    // Old projects could import a real robot task after the display matrix was
    // loaded. Its immutable ABX pose identifies that still-unprojected reading.
    else if (!source?.mapPose && sameMapTeachingPose(display.mapPose, point.abx?.mapPose)) point.mapPose = structuredClone(point.abx.mapPose);
    if (source?.opticalTargets && sameNumbers(point.opticalTargets, source.opticalTargets)) point.opticalTargets = structuredClone(source.opticalTargets);
    for (const [side, pose] of Object.entries(source?.cameraPoses || {})) {
      const camera = point.cameraCapture?.frames?.[side];
      if (camera && sameNumbers(camera.opticalPose, pose)) camera.opticalPose = structuredClone(pose);
    }
  };
  result.virtualTeaching.tasks.forEach((task, taskIndex) => {
    const source = taskSources.get(task.id), parkingSources = byId(source?.parkingPoints);
    if (source?.polylines && sameNumbers(task.polylines, source.polylines)) task.polylines = structuredClone(source.polylines);
    if (source?.mobileTransform && sameNumbers(task.mobileTransform, source.mobileTransform)) task.mobileTransform = [...source.mobileTransform];
    task.parkingPoints.forEach((parking, index) => {
      const saved = parkingSources.get(parking.id), poseSources = byId(saved?.poses);
      const display = displayed.virtualTeaching.tasks[taskIndex].parkingPoints[index];
      restorePoint(parking, saved, display);
      parking.poses.forEach((point, poseIndex) => restorePoint(point, poseSources.get(point.id), display.poses[poseIndex]));
    });
  });
}

// The editor stores aligned display coordinates. Robot exchange removes that
// display layer exactly once; full project saving deliberately skips this.
export function robotTeachingCoordinates(payload) {
  const calibration = payload.workspace?.mapTransform;
  if (!calibration || (payload.workspace?.teachingSpaceMode || payload.teachingSpace?.mode) === 'independent') return payload;
  const inverse = mapTeachingCalibrationMatrix(calibration).invert();
  const result = transformPayload(payload, inverse);
  restoreExactCoordinates(result, payload, calibration.sourceCoordinates);
  const points = byId(result.waypoints);
  if (payload.paths) result.paths = payload.paths.map((path) => Object.hasOwn(path, 'distance') ? { ...path,
    distance: calculatePathDistances(points.get(path.from)?.pose, points.get(path.to)?.pose) } : path);
  const restorePlacement = (placement) => placement?.kind === 'placement' ? { ...placement,
    localToMap: transformTeachingPose(placement.localToMap, inverse),
    ...(placement.previousPlacements ? { previousPlacements: placement.previousPlacements.map(restorePlacement) } : {}),
  } : placement;
  // Nested route/teaching exporters can safely share the prepared payload.
  const { mapTransform, ...workspace } = payload.workspace;
  result.workspace = { ...workspace, ...(workspace.transfer ? { transfer: restorePlacement(workspace.transfer) } : {}) };
  return result;
}

// Robot imports are always in the robot map frame, regardless of whether a
// display calibration was loaded before or after the file was selected.
export function projectMapTeachingImport(imported, calibration) {
  if (!calibration) return imported;
  const source = { waypoints: imported.waypoints, virtualTeaching: { tasks: imported.tasks || [] } };
  const projected = transformPayload(source, mapTeachingCalibrationMatrix(calibration));
  const coordinates = snapshotMapTeachingCoordinates(source);
  const merge = (previous, additions) => [...new Map([...(previous || []), ...additions].map((item) => [item.id, item])).values()];
  const prior = calibration.sourceCoordinates;
  return { ...imported, waypoints: projected.waypoints, tasks: projected.virtualTeaching.tasks,
    mapTransform: { ...calibration, sourceCoordinates: { ...prior, version: 1,
      waypoints: merge(prior?.waypoints, coordinates.waypoints), tasks: merge(prior?.tasks, coordinates.tasks) } },
  };
}
