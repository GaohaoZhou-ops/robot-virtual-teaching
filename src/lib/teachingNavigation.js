export const TEACHING_WAYPOINT_SOURCE = 'teaching-parking-point';
export const TEMPORARY_MAP_ROUTE_SOURCE = 'temporary-map-route';

// A synchronized map route is a disposable local projection. Edges created
// against its points are temporary too, including mixed local/map connections.
export function withoutTemporaryMapNavigation(waypoints, edges) {
  const temporaryIds = new Set(waypoints
    .filter((point) => point.source === TEMPORARY_MAP_ROUTE_SOURCE).map((point) => point.id));
  return {
    waypoints: waypoints.filter((point) => !temporaryIds.has(point.id)),
    edges: edges.filter((edge) => edge.source !== TEMPORARY_MAP_ROUTE_SOURCE
      && !temporaryIds.has(edge.from) && !temporaryIds.has(edge.to)),
  };
}

const poseAxes = ['x', 'y', 'z', 'roll', 'pitch', 'yaw'];

export const parkingWaypointPose = (mapPose) => ({
  ...mapPose.position,
  ...mapPose.rpy,
});

// A robot route may repeat labels across work areas. Reuse its full imported
// N-number/name at the current position, including on temporary local copies.
export function teachingParkingName(waypoints, pose, fallback, selectedId) {
  const position = pose.position || pose, rpy = pose.rpy || pose;
  const candidates = waypoints.filter((point) => point.source !== TEACHING_WAYPOINT_SOURCE
    && Math.hypot(point.pose.x - position.x, point.pose.y - position.y) <= 1e-4);
  const selected = candidates.find((point) => point.id === selectedId);
  if (selected) return selected.name;
  if (candidates.length === 1) return candidates[0].name;
  const aligned = candidates.filter((point) => {
    const delta = (point.pose.yaw - rpy.yaw) * Math.PI / 180;
    return Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta))) <= 1e-6;
  });
  return aligned.length === 1 ? aligned[0].name : fallback;
}

export function buildTeachingWaypoints(storedWaypoints, tasks, { mapData, coordinateFrame } = {}) {
  const parkingById = new Map();
  for (const task of tasks) {
    // Native route nodes are imported separately. A historical parking
    // observation (or missing localization) is not a new navigation target.
    if (task.abx) continue;
    if (coordinateFrame && task.coordinateFrame && task.coordinateFrame !== coordinateFrame) continue;
    if (mapData) {
      const sameMap = task.map?.sourceHash && mapData.sourceHash
        ? task.map.sourceHash === mapData.sourceHash
        : task.map?.fileName === mapData.name;
      if (!sameMap) continue;
    }
    for (const parking of task.parkingPoints || []) {
      parkingById.set(parking.id, {
        id: parking.id,
        name: parking.name,
        pose: parkingWaypointPose(parking.mapPose),
        source: TEACHING_WAYPOINT_SOURCE,
        teachingTaskId: task.id,
        teachingTaskName: task.name,
        teachingPoseCount: parking.poses?.length || 0,
      });
    }
  }

  const points = [];
  const seen = new Set();
  for (const point of storedWaypoints) {
    if (seen.has(point.id)) continue;
    const parking = parkingById.get(point.id);
    // Persisted parking markers are projections of the task, never a second
    // editable copy. Remove them when their parking point no longer exists.
    if (!parking && point.source === TEACHING_WAYPOINT_SOURCE) continue;
    points.push(parking || point);
    seen.add(point.id);
  }
  for (const [id, parking] of parkingById) {
    if (!seen.has(id)) points.push(parking);
  }
  return points;
}

export function navigationEdgesForWaypoints(edges, waypoints) {
  const ids = new Set(waypoints.map((point) => point.id));
  // Only explicit paths are used. Parking order does not imply a route.
  return edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
}

export function updateTeachingWaypoint(tasks, id, patch, updatedAt = new Date().toISOString()) {
  return tasks.map((task) => {
    const parking = task.parkingPoints?.find((point) => point.id === id);
    if (!parking) return task;
    const originalPose = parkingWaypointPose(parking.mapPose);
    const pose = { ...originalPose, ...patch.pose };
    const positionChanged = poseAxes.some((axis) => pose[axis] !== originalPose[axis]);
    const name = typeof patch.name === 'string' ? patch.name : parking.name;
    if (!positionChanged && name === parking.name) return task;
    const mapPose = {
      ...parking.mapPose,
      position: { x: pose.x, y: pose.y, z: pose.z },
      rpy: { roll: pose.roll, pitch: pose.pitch, yaw: pose.yaw },
    };
    return {
      ...task,
      updatedAt,
      parkingPoints: task.parkingPoints.map((point) => point.id !== id ? point : {
        ...point,
        name,
        mapPose,
        updatedAt,
        poses: positionChanged ? (point.poses || []).map((recording) => ({
          ...recording,
          updatedAt,
          mapPose: { ...recording.mapPose, ...mapPose },
        })) : point.poses,
      }),
    };
  });
}

export function removeTeachingWaypoints(tasks, ids, updatedAt = new Date().toISOString()) {
  return tasks.map((task) => {
    if (!task.parkingPoints?.some((point) => ids.has(point.id))) return task;
    return {
      ...task,
      updatedAt,
      parkingPoints: task.parkingPoints.filter((point) => !ids.has(point.id))
        .map((point, index) => ({ ...point, sequence: index + 1 })),
    };
  });
}
