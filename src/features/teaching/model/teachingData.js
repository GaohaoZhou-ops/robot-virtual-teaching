export const TEACHING_DATA_FORMAT = 'atlas-route-studio-teaching-data';
export const TEACHING_DATA_VERSION = 1;

const fields = (value, names) => Object.fromEntries(
  names.filter((name) => value?.[name] !== undefined).map((name) => [name, value[name]]),
);
const robotIdentity = (robot) => fields(robot, ['id', 'name', 'fileName', 'relativePath', 'format', 'packageName']);
const mapIdentity = (map) => fields(map, ['id', 'fileName', 'sourceHash', 'sourceHashKind', 'coordinateFrame', 'teachingSpaceMode']);
const vector = (value) => fields(value, ['x', 'y', 'z']);
const pose = (value, frame) => ({
  frameId: value?.frameId || frame,
  position: vector(value?.position || value),
  rpy: fields(value?.rpy || value, ['roll', 'pitch', 'yaw']),
});
const opticalPose = (value) => value ? {
  frameName: value.frameName,
  position: vector(value.position),
  quaternion: fields(value.quaternion, ['x', 'y', 'z', 'w']),
} : null;
const joints = (value) => {
  const values = Object.fromEntries(Object.entries(value?.values || {}).filter(([, number]) => Number.isFinite(number)));
  return {
    angularUnit: value?.angularUnit || 'degree',
    linearUnit: value?.linearUnit || 'meter',
    count: Object.keys(values).length,
    values,
  };
};

const parkingPointData = (parking, frame, sequence) => ({
  ...fields(parking, ['id', 'name', 'createdAt', 'updatedAt']),
  sequence,
  mapPose: pose(parking.mapPose, frame),
  poses: (parking.poses || []).map((point, pointIndex) => ({
    ...fields(point, ['id', 'name', 'capturedAt', 'mobileSampleId']),
    ...(Array.isArray(point.mobileSampleIds) ? { mobileSampleIds: [...point.mobileSampleIds] } : {}),
    sequence: pointIndex + 1,
    mapPose: pose(point.mapPose, frame),
    fullBodyJoints: joints(point.fullBodyJoints),
    opticalTargets: Object.fromEntries(['left', 'right'].flatMap((side) => {
      const target = point.opticalTargets?.[side] || point.cameraCapture?.frames?.[side]?.opticalPose;
      return target ? [[side, opticalPose(target)]] : [];
    })),
  })),
});

// Temporary clipboard contract; keep it separate from the robot ZIP format.
export function buildTeachingParkingPointCopy(task, parkingPoint) {
  const index = task?.parkingPoints?.findIndex((item) => item.id === parkingPoint?.id) ?? -1;
  if (index < 0) throw new Error('未找到选中的停车点');
  const frame = task.coordinateFrame || parkingPoint.mapPose?.frameId || 'map';
  const data = parkingPointData(parkingPoint, frame, index + 1);
  if (parkingPoint.abx) data.located = parkingPoint.abx.located !== false;
  data.poses.forEach((point, pointIndex) => {
    const source = parkingPoint.poses[pointIndex];
    if (source.abx) point.located = source.abx.located !== false;
  });
  return structuredClone({
    format: 'atlas-route-studio-parking-point',
    version: 1,
    task: fields(task, ['id', 'name']),
    coordinateSystem: { frameId: frame, distanceUnit: 'meter', angleUnit: 'degree', rotationOrder: 'ZYX' },
    robot: robotIdentity(task.robot),
    sourceMap: mapIdentity(task.map),
    parkingPoint: data,
  });
}

// Only pose data crosses this boundary. Preview images, point clouds, solver
// reports and future fields on the project must never inflate an exchange file.
const mobileCapture = (capture) => ({
  ...fields(capture, ['protocol', 'id', 'sessionId', 'modelHash', 'coordinateFrame', 'createdAt', 'completedAt']),
  device: fields(capture.device, ['model', 'lidar', 'platform', 'poseSource']),
  calibrations: (capture.calibrations || []).map((calibration) => ({
    ...fields(calibration, ['id', 'createdAt', 'capturedAt', 'yawDegrees', 'rollDegrees', 'pitchDegrees']),
    worldFromModel: [...calibration.worldFromModel],
    ...(calibration.referencePoint ? { referencePoint: vector(calibration.referencePoint) } : {}),
  })),
  samples: (capture.samples || []).map((sample) => ({
    ...fields(sample, ['id', 'name', 'kind', 'segmentId', 'capturedAt', 'tracking', 'origin', 'arm']),
    cameraPose: opticalPose(sample.cameraPose),
    ...(sample.surfacePoint ? { surfacePoint: vector(sample.surfacePoint) } : {}),
  })),
});

export function buildTeachingDataExport(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new Error('没有可导出的示教数据');
  }
  const mode = (project.workspace?.teachingSpaceMode ?? project.teachingSpace?.mode) === 'independent'
    ? 'independent' : 'map';
  const frame = project.coordinateSystem?.frameId || (mode === 'independent' ? 'virtual_origin' : 'map');
  const tasks = (project.virtualTeaching?.tasks || []).map((task, taskIndex) => {
    const taskFrame = task.coordinateFrame || frame;
    return {
      ...fields(task, ['id', 'name', 'createdAt', 'updatedAt']),
      sequence: taskIndex + 1,
      coordinateFrame: taskFrame,
      ...(task.polylines ? { polylines: structuredClone(task.polylines) } : {}),
      robot: robotIdentity(task.robot),
      sourceMap: mapIdentity(task.map),
      parkingPoints: (task.parkingPoints || []).map((parking, parkingIndex) => (
        parkingPointData(parking, taskFrame, parkingIndex + 1)
      )),
      ...(task.mobileCapture ? {
        mobileCapture: mobileCapture(task.mobileCapture),
        ...(task.mobileTransform ? { mobileTransform: [...task.mobileTransform] } : {}),
      } : {}),
    };
  });
  const jointPoses = (project.virtualTeaching?.jointPoses || []).map((preset, index) => ({
    ...fields(preset, ['id', 'name', 'createdAt', 'updatedAt']),
    sequence: index + 1,
    robot: robotIdentity(preset.robot),
    joints: joints(preset.joints),
  }));
  const waypoints = (project.waypoints || []).map((point) => ({
    ...fields(point, ['id', 'name']),
    pose: fields(point.pose, ['x', 'y', 'z', 'roll', 'pitch', 'yaw']),
  }));
  const paths = (project.paths || []).map((path) => ({
    ...fields(path, ['id', 'from', 'to', 'directed']),
    limits: fields(path.limits, ['minSpeed', 'maxSpeed', 'minAcceleration', 'maxAcceleration']),
    motion: fields(path.motion, ['direction', 'enable3DObstacleAvoidance']),
  }));

  return structuredClone({
    format: TEACHING_DATA_FORMAT,
    version: TEACHING_DATA_VERSION,
    exportedAt: project.exportedAt || new Date().toISOString(),
    source: { teachingSpaceMode: mode, map: mapIdentity(project.map) },
    coordinateSystem: {
      frameId: frame,
      horizontalPlane: 'XY',
      verticalAxis: 'Z',
      angleUnit: project.coordinateSystem?.angleUnit || 'degree',
      distanceUnit: project.coordinateSystem?.distanceUnit || 'meter',
      rotationOrder: 'ZYX',
      matrixLayout: 'column-major',
    },
    robot: project.robot ? {
      ...robotIdentity(project.robot),
      mapPose: pose(project.robot.origin, frame),
      fullBodyJoints: joints({ values: project.robot.joints }),
    } : null,
    navigation: { coordinateFrame: frame, waypoints, paths },
    jointPoses,
    tasks,
    statistics: {
      taskCount: tasks.length,
      parkingPointCount: tasks.reduce((total, task) => total + task.parkingPoints.length, 0),
      poseCount: tasks.reduce((total, task) => total + task.parkingPoints.reduce((sum, parking) => sum + parking.poses.length, 0), 0),
      devicePoseCount: tasks.reduce((total, task) => total + (task.mobileCapture?.samples.length || 0), 0),
      jointPoseCount: jointPoses.length,
      waypointCount: waypoints.length,
      pathCount: paths.length,
    },
  });
}
