export const TEACHING_WAYPOINT_SOURCE = 'teaching-parking-point';

const poseAxes = ['x', 'y', 'z', 'roll', 'pitch', 'yaw'];

export const parkingWaypointPose = (mapPose) => ({
  ...mapPose.position,
  ...mapPose.rpy,
});

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
