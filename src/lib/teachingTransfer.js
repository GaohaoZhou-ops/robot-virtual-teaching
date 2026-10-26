import { Euler, Matrix4, Quaternion, Vector3, MathUtils } from 'three';
import { buildExport, createId, normalizeProject, teachingCoordinateFrame } from './io.js';
import { sha256Bytes } from './hash.js';
import { appendPlacedObjectLayers } from './placedObjectRendering.js';
import { transformPolyline, polylineBoundsPoints } from './polylineTeaching.js';

const axes = ['x', 'y', 'z'];
const rotationAxes = ['roll', 'pitch', 'yaw'];
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));
const hashObject = (value) => sha256Bytes(new TextEncoder().encode(
  JSON.stringify(value, (key, item) => key === 'sequence' ? undefined : item),
));

export const identityTransferPose = () => ({
  position: { x: 0, y: 0, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: 0 },
});

const sameTeachingMap = (expected, actual) => {
  if (expected?.teachingGroupId || actual?.teachingGroupId) {
    return Boolean(expected?.teachingGroupId && expected.teachingGroupId === actual?.teachingGroupId
      && (!expected.sourceHash || !actual.sourceHash || expected.sourceHash === actual.sourceHash));
  }
  if (expected?.sourceHash && actual?.sourceHash) return expected.sourceHash === actual.sourceHash;
  return Boolean(expected?.mapId && expected.mapId === actual?.mapId);
};

// Placing another group changes the map geometry, but preserves its coordinate
// frame. Remember those source maps for alignments that have not been placed yet.
export function isTeachingAlignmentTarget(relation, map, mapTransfer) {
  if (relation?.kind !== 'alignment' || !map) return false;
  const sources = mapTransfer?.kind === 'placement' && Array.isArray(mapTransfer.mapFrameSources)
    ? mapTransfer.mapFrameSources : [];
  return [map, ...sources].some((candidate) => sameTeachingMap(relation.sourceMap, candidate));
}

// Keep earlier placements so a restored independent group can reuse its own
// transform. A new group may use the same PLY, but must not inherit that binding.
export function boundTeachingRelation(independentMap, independentTransfer, map, mapTransfer) {
  const placements = mapTransfer?.kind === 'placement'
    ? [mapTransfer, ...(Array.isArray(mapTransfer.previousPlacements) ? mapTransfer.previousPlacements : [])] : [];
  const relation = placements.find((item) => item?.kind === 'placement' && sameTeachingMap(item.sourceMap, independentMap))
    || ((independentTransfer?.kind === 'extraction' && sameTeachingMap(independentTransfer.sourceMap, map))
      || isTeachingAlignmentTarget(independentTransfer, map, mapTransfer)
      ? independentTransfer : null);
  return relation?.localToMap ? relation : null;
}

export function boundTeachingTransform(...args) {
  const relation = boundTeachingRelation(...args);
  return relation ? structuredClone(relation.localToMap) : null;
}

export function transferMatrix(pose) {
  requireValue(axes.every((axis) => Number.isFinite(pose?.position?.[axis]))
    && rotationAxes.every((axis) => Number.isFinite(pose?.rpy?.[axis])), '位置和角度必须是有效数值');
  return new Matrix4().compose(
    new Vector3(...axes.map((axis) => pose.position[axis])),
    new Quaternion().setFromEuler(new Euler(
      ...rotationAxes.map((axis) => MathUtils.degToRad(pose.rpy[axis])), 'ZYX',
    )),
    new Vector3(1, 1, 1),
  );
}

// TXT rows describe p_map = T * p_local, with translation in meters.
export function parseTransferMatrix(text) {
  return parseTransferMatrixFile(text).matrix;
}

export function parseTransferMatrixFile(text) {
  const rows = String(text).replace(/^\uFEFF/, '').trim().split(/\r\n?|\n/)
    .map((row) => row.trim()).filter(Boolean).map((row) => row.split(/\s+/));
  requireValue(rows.length === 4 && rows.every((row) => row.length === 4), '转换矩阵必须为 4 行，每行 4 个数值，以空格或制表符分隔');
  const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const values = rows.map((row, rowIndex) => row.map((value, columnIndex) => {
    requireValue(decimal.test(value) && Number.isFinite(Number(value)), `转换矩阵第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列必须是有效数值`);
    return Number(value);
  }));
  requireValue(values[3].every((value, index) => Math.abs(value - (index === 3 ? 1 : 0)) <= 1e-8),
    '转换矩阵最后一行必须是 0 0 0 1');
  const matrix = new Matrix4().set(...values.flat());
  // Allow rounding in six-decimal text exports, but reject scale, shear and reflections.
  const columns = [0, 1, 2].map((axis) => new Vector3().setFromMatrixColumn(matrix, axis));
  const tolerance = 1e-4;
  requireValue(columns.every((column, index) => columns.every((other, otherIndex) => (
    Math.abs(column.dot(other) - (index === otherIndex ? 1 : 0)) <= tolerance
  ))) && Math.abs(matrix.determinant() - 1) <= tolerance,
  '转换矩阵旋转部分必须为正交旋转矩阵，不支持缩放、剪切或镜像');
  return {
    values: values.flat(),
    matrix: new Matrix4().compose(
      new Vector3(values[0][3], values[1][3], values[2][3]),
      new Quaternion().setFromRotationMatrix(matrix).normalize(),
      new Vector3(1, 1, 1),
    ),
  };
}

const matrixFileKey = (values) => Array.isArray(values) && values.length === 16
  && values.every((value) => typeof value === 'number' && Number.isFinite(value))
  ? JSON.stringify(values) : null;

export function normalizeTransferMatrixImports(imports) {
  const seen = new Set();
  return (Array.isArray(imports) ? imports : []).flatMap((entry) => {
    const key = matrixFileKey(entry?.values);
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [{ name: String(entry.name || '转换矩阵.txt'), values: [...entry.values] }];
  });
}

export function hasLoadedTransferMatrix(file, imports, legacyBoundPose = null) {
  const key = matrixFileKey(file?.values);
  if (!key) return false;
  if (normalizeTransferMatrixImports(imports).some((entry) => matrixFileKey(entry.values) === key)) return true;
  // Older projects only saved a pose. Compare the rigid transform when the
  // original 16 file values were not recorded; do not loosen new-file matching.
  if (!legacyBoundPose) return false;
  const saved = transferMatrix(legacyBoundPose).elements;
  return file.matrix.elements.every((value, index) => Math.abs(value - saved[index]) < 1e-10);
}

export function transformTeachingPose(pose, matrix, frameId) {
  const composed = matrix.clone().multiply(transferMatrix(pose));
  const position = new Vector3().setFromMatrixPosition(composed);
  const angles = new Euler().setFromRotationMatrix(composed, 'ZYX');
  return {
    ...(frameId ? { frameId } : {}),
    position: { x: position.x, y: position.y, z: position.z },
    rpy: { roll: MathUtils.radToDeg(angles.x), pitch: MathUtils.radToDeg(angles.y), yaw: MathUtils.radToDeg(angles.z) },
  };
}

export function placementTransform(destinationPose, sourceAnchor = identityTransferPose()) {
  return transformTeachingPose(identityTransferPose(), transferMatrix(destinationPose)
    .multiply(transferMatrix(sourceAnchor).invert()));
}

export function insideTransferBounds(position, bounds) {
  return axes.every((axis) => position[axis] >= bounds.min[axis] && position[axis] <= bounds.max[axis]);
}

export function validateTransferBounds(bounds) {
  requireValue(axes.every((axis) => Number.isFinite(bounds?.min?.[axis])
    && Number.isFinite(bounds?.max?.[axis]) && bounds.min[axis] <= bounds.max[axis]), '裁剪范围无效：最小值不能大于最大值');
  requireValue(bounds.max.x > bounds.min.x && bounds.max.y > bounds.min.y, '请框选一个有面积的区域');
}

const transformOpticalPose = (pose, matrix) => {
  const position = new Vector3(pose.position.x, pose.position.y, pose.position.z).applyMatrix4(matrix);
  const quaternion = new Quaternion().setFromRotationMatrix(matrix).multiply(
    new Quaternion(pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w),
  ).normalize();
  return { ...pose, position: { x: position.x, y: position.y, z: position.z },
    quaternion: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w } };
};

export function transformTeachingTasks(tasks, matrix, mode, map) {
  const frame = teachingCoordinateFrame(mode);
  const pose = (value) => transformTeachingPose(value, matrix, frame);
  return tasks.map((task) => ({
    ...task, coordinateFrame: frame,
    ...(task.polylines ? { polylines: task.polylines.map((path) => transformPolyline(path, matrix)) } : {}),
    ...(task.mobileSolveSource?.initialMapPose ? { mobileSolveSource: { ...task.mobileSolveSource,
      initialMapPose: pose(task.mobileSolveSource.initialMapPose) } } : {}),
    ...(task.mobileCapture ? { mobileTransform: matrix.clone().multiply(new Matrix4().fromArray(task.mobileTransform)).toArray(), mobileSolve: null } : {}),
    map: { id: map.mapId, fileName: map.name, sourceHash: map.sourceHash, teachingSpaceMode: mode, coordinateFrame: frame },
    parkingPoints: task.parkingPoints.map((parking) => ({
      ...parking, mapPose: pose(parking.mapPose),
      mergeHistory: parking.mergeHistory.map((entry) => ({ ...entry,
        sourceParkingPoints: entry.sourceParkingPoints.map((source) => ({ ...source, mapPose: pose(source.mapPose) })),
      })),
      poses: parking.poses.map((point) => ({
        ...point, mapPose: pose(point.mapPose),
        opticalTargets: Object.fromEntries(Object.entries(point.opticalTargets || {})
          .map(([side, target]) => [side, transformOpticalPose(target, matrix)])),
        cameraCapture: point.cameraCapture ? { ...point.cameraCapture,
          // RGB and camera-local XYZ stay unchanged; only the camera's world pose moves.
          frames: Object.fromEntries(Object.entries(point.cameraCapture.frames).map(([side, camera]) => [side, {
            ...camera, opticalPose: transformOpticalPose(camera.opticalPose, matrix),
          }])),
        } : null,
        replanningHistory: point.replanningHistory.map((entry) => ({ ...entry,
          sourceMapPose: pose(entry.sourceMapPose), commonMapPose: pose(entry.commonMapPose),
        })),
      })),
    })),
  }));
}

const transformWaypoints = (points, matrix) => points.map((point) => {
  const pose = transformTeachingPose({ position: point.pose,
    rpy: { roll: point.pose.roll, pitch: point.pose.pitch, yaw: point.pose.yaw } }, matrix);
  return { ...point, pose: { ...pose.position, ...pose.rpy } };
});

const positionsOf = (map) => {
  requireValue(map?.positionBuffer instanceof ArrayBuffer, '请先打开包含完整点云的工程');
  const positions = new Float32Array(map.positionBuffer);
  requireValue(positions.length > 0 && positions.length % 3 === 0, '工程点云数据不完整');
  return positions;
};
const indicesOf = (map) => map.indexBuffer instanceof ArrayBuffer
  ? map.indexComponentType === 'uint16' ? new Uint16Array(map.indexBuffer) : new Uint32Array(map.indexBuffer)
  : new Uint32Array();
const colorsOf = (map) => map.colorBuffer instanceof ArrayBuffer ? new Uint8Array(map.colorBuffer) : null;

async function geometryRecord(name, positions, colors, indices, mode, robotPackage) {
  const bounds = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[offset + axis];
      requireValue(Number.isFinite(value), '转换后的点云含无效坐标，请检查位置数值');
      bounds.min[axes[axis]] = Math.min(bounds.min[axes[axis]], value);
      bounds.max[axes[axis]] = Math.max(bounds.max[axes[axis]], value);
    }
    if (offset && offset % 750000 === 0) await yieldToUI();
  }
  const hashes = await Promise.all([positions, colors || new Uint8Array(), indices].map(sha256Bytes));
  return {
    name, mapId: createId('map-transfer'), geometryCacheVersion: 1,
    positionBuffer: positions.buffer, colorBuffer: colors?.buffer || null,
    indexBuffer: indices.length ? indices.buffer : null, indexComponentType: 'uint32',
    pointCount: positions.length / 3, faceCount: indices.length / 3, bounds,
    byteLength: positions.byteLength + (colors?.byteLength || 0) + indices.byteLength,
    sourceHash: await hashObject(hashes), sourceHashKind: 'geometry',
    sourceKind: 'teaching-transfer', sourceBlob: null, loadedAt: new Date().toISOString(),
    teachingSpaceMode: mode, coordinateFrame: teachingCoordinateFrame(mode),
    portableRobotPackage: robotPackage || null,
  };
}

export async function cropTeachingGeometry(map, bounds, localToMap, name = `${map.name.replace(/\.ply$/i, '')}-local.ply`) {
  validateTransferBounds(bounds);
  const source = positionsOf(map);
  const sourceColors = colorsOf(map);
  const sourceIndices = indicesOf(map);
  const remap = new Int32Array(source.length / 3).fill(-1);
  let count = 0;
  for (let index = 0; index < remap.length; index += 1) {
    if (insideTransferBounds({ x: source[index * 3], y: source[index * 3 + 1], z: source[index * 3 + 2] }, bounds)) remap[index] = count++;
    if (index && index % 250000 === 0) await yieldToUI();
  }
  requireValue(count > 0, '选定范围内没有点云，请扩大裁剪范围');
  const positions = new Float32Array(count * 3);
  const colors = sourceColors ? new Uint8Array(count * 3) : null;
  const inverse = transferMatrix(localToMap).invert();
  const point = new Vector3();
  for (let index = 0; index < remap.length; index += 1) {
    if (remap[index] < 0) continue;
    const offset = remap[index] * 3;
    point.fromArray(source, index * 3).applyMatrix4(inverse).toArray(positions, offset);
    if (colors) colors.set(sourceColors.subarray(index * 3, index * 3 + 3), offset);
    if (index && index % 250000 === 0) await yieldToUI();
  }
  const faces = [];
  for (let index = 0; index < sourceIndices.length; index += 3) {
    const a = remap[sourceIndices[index]], b = remap[sourceIndices[index + 1]], c = remap[sourceIndices[index + 2]];
    if (a >= 0 && b >= 0 && c >= 0) faces.push(a, b, c);
  }
  return geometryRecord(name, positions, colors, Uint32Array.from(faces), 'independent', map.portableRobotPackage);
}

export async function placeTeachingGeometry(source, target, localToMap) {
  const background = positionsOf(target), local = positionsOf(source);
  const positions = new Float32Array(background.length + local.length);
  positions.set(background);
  const matrix = transferMatrix(localToMap), point = new Vector3();
  for (let offset = 0; offset < local.length; offset += 3) {
    point.fromArray(local, offset).applyMatrix4(matrix).toArray(positions, background.length + offset);
    if (offset && offset % 750000 === 0) await yieldToUI();
  }
  const sourceColors = colorsOf(source), targetColors = colorsOf(target);
  const colors = sourceColors || targetColors ? new Uint8Array(positions.length).fill(255) : null;
  if (targetColors) colors.set(targetColors);
  if (sourceColors) colors.set(sourceColors, background.length);
  const backgroundIndices = indicesOf(target), localIndices = indicesOf(source);
  const indices = new Uint32Array(backgroundIndices.length + localIndices.length);
  indices.set(backgroundIndices);
  for (let index = 0; index < localIndices.length; index += 1) indices[backgroundIndices.length + index] = localIndices[index] + background.length / 3;
  return geometryRecord(target.name, positions, colors, indices, 'map', source.portableRobotPackage || target.portableRobotPackage);
}

const snapshotProject = (snapshot) => {
  requireValue(snapshot?.config?.config?.project, '工程配置尚未保存，请稍后再试');
  return normalizeProject(snapshot.config.config.project);
};

const mapIdentity = async (map) => ({
  name: map.name, mapId: map.mapId,
  sourceHash: map.sourceHash || await sha256Bytes(positionsOf(map)),
  ...(map.teachingGroupId ? { teachingGroupId: map.teachingGroupId } : {}),
});

export function hasLoadedMapWorkspace(snapshot) {
  return Boolean(snapshot?.mode === 'map' && snapshot.map?.mapId
    && snapshot.map.geometryCacheVersion === 1
    && snapshot.map.positionBuffer instanceof ArrayBuffer
    && snapshot.map.positionBuffer.byteLength > 0 && snapshot.map.positionBuffer.byteLength % 12 === 0
    && snapshot.config?.mapId === snapshot.map.mapId
    && snapshot.config.config?.project?.workspace?.teachingSpaceMode === 'map');
}

// A new model can know its map alignment before any geometry or teaching data
// is placed on the map. Keep this distinct from an extraction/write-back link.
export async function createTeachingAlignment(target, { localToMap, matrixImports = [] }) {
  requireValue(hasLoadedMapWorkspace(target), '请先加载完整的地图示教工程，再设置转换矩阵');
  transferMatrix(localToMap);
  return {
    version: 1, kind: 'alignment', id: createId('transfer'),
    sourceMap: await mapIdentity(target.map),
    localToMap: structuredClone(localToMap),
    matrixImports: normalizeTransferMatrixImports(matrixImports),
    createdAt: new Date().toISOString(),
  };
}

function snapshotResult(project, map, mode, transfer, suspended = true) {
  const payload = buildExport({
    ...project, mapData: map,
    heightRange: project.slice || [map.bounds.min.z, map.bounds.max.z],
    robotPose: project.robot?.origin, robotJointValues: project.robot?.joints,
    lockedRobotJointNames: project.robot?.lockedJoints, robotHeightLocked: project.robot?.heightLocked,
    ignoredRobotCollisionJointNames: project.robot?.collisionIgnoredJoints,
    ...project.workspace, teachingSpaceMode: mode,
    meshRenderQuality: project.rendering?.meshQuality || 'auto',
    transfer, directoryAutosaveSuspended: suspended,
  });
  const ui = {
    ...payload.workspace, mode: 'select', selectedWaypointId: null, selectedEdgeId: null, connectionSourceId: null,
    meshRenderQuality: payload.rendering.meshQuality, validation: { status: 'idle', unreachableCount: 0, checkedAt: null },
    robotHeightLocked: payload.robot?.heightLocked === true, selectedRobot: payload.robot,
  };
  return { map, config: { schemaVersion: 1, project: payload, ui }, mode };
}

async function createBaseline(project) {
  return {
    tasks: await Promise.all(project.teachingTasks.map(async (task) => ({
      id: task.id, name: task.name,
      ...(task.mobileCapture ? { mobileHash: await hashObject({ capture: task.mobileCapture, transform: task.mobileTransform }) } : {}),
      ...(task.polylines ? { polylines: await Promise.all(task.polylines.map(async (path) => ({ id: path.id, hash: await hashObject(path) }))) } : {}),
      parkingPoints: await Promise.all(task.parkingPoints.map(async (point) => ({ id: point.id, hash: await hashObject(point) }))),
    }))),
    waypoints: await Promise.all(project.waypoints.map(async (point) => ({ id: point.id, hash: await hashObject(point) }))),
    edges: await Promise.all(project.edges.map(async (edge) => ({ id: edge.id, hash: await hashObject(edge) }))),
    jointPoses: await Promise.all((project.jointPoses || []).map(async (pose) => ({ id: pose.id, hash: await hashObject(pose) }))),
  };
}

export async function extractTeachingWorkspace(source, { bounds, localToMap, name, matrixImports = [] }) {
  const project = snapshotProject(source);
  requireValue(project.workspace.teachingSpaceMode === 'map', '只能从地图示教提取局部工程');
  const map = await cropTeachingGeometry(source.map, bounds, localToMap, name);
  const selected = {
    ...project,
    teachingTasks: project.teachingTasks.map((task) => ({ ...task,
      ...(task.polylines ? { polylines: task.polylines.filter((path) => polylineBoundsPoints(path).every((point) =>
        insideTransferBounds(point, bounds))) } : {}),
      parkingPoints: task.parkingPoints.filter((point) => insideTransferBounds(point.mapPose.position, bounds)),
    })).filter((task) => task.parkingPoints.length || task.polylines?.length || task.mobileCapture?.samples.some((sample) => {
      const p = sample.cameraPose.position;
      return insideTransferBounds(new Vector3(p.x, p.y, p.z).applyMatrix4(new Matrix4().fromArray(task.mobileTransform)), bounds);
    })),
    waypoints: project.waypoints.filter((point) => insideTransferBounds(point.pose, bounds)),
  };
  const ids = new Set(selected.waypoints.map((point) => point.id));
  selected.edges = project.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  const transfer = { version: 1, kind: 'extraction', id: createId('transfer'),
    sourceMap: await mapIdentity(source.map), localToMap, bounds,
    matrixImports: normalizeTransferMatrixImports(matrixImports),
    createdAt: new Date().toISOString(), baseline: await createBaseline(selected),
    robotPath: project.robot?.relativePath || null,
  };
  const inverse = transferMatrix(localToMap).invert();
  return snapshotResult({ ...selected,
    robot: project.robot ? { ...project.robot, origin: transformTeachingPose(project.robot.origin, inverse) } : null,
    teachingTasks: transformTeachingTasks(selected.teachingTasks, inverse, 'independent', map),
    waypoints: transformWaypoints(selected.waypoints, inverse),
    edges: selected.edges.map((edge) => ({ ...edge, status: 'unchecked' })),
    slice: [map.bounds.min.z, map.bounds.max.z], view2d: null, view3d: null,
  }, map, 'independent', transfer);
}

function assertRobotCompatibility(source, target) {
  if (!source.robot || !target.robot || !target.teachingTasks.length) return;
  requireValue(source.robot.relativePath === target.robot.relativePath,
    '两个工程使用不同机器人；请先在地图工程中选择相同机器人，再转换示教内容');
}

export async function placeTeachingWorkspace(source, target, { localToMap, matrixImports }) {
  const local = snapshotProject(source), background = snapshotProject(target);
  requireValue(local.workspace.teachingSpaceMode === 'independent' && background.workspace.teachingSpaceMode === 'map', '请选择独立工程和目标地图工程');
  assertRobotCompatibility(local, background);
  const map = await placeTeachingGeometry(source.map, target.map, localToMap);
  const matrix = transferMatrix(localToMap);
  const remap = new Map();
  const newId = (id) => { if (!remap.has(id)) remap.set(id, createId('transferred')); return remap.get(id); };
  const importedTasks = transformTeachingTasks(local.teachingTasks, matrix, 'map', map).map((task) => ({ ...task,
    ...(task.polylines ? { polylines: task.polylines.map((path) => ({ ...path, id: newId(path.id) })) } : {}),
    id: newId(task.id), parkingPoints: task.parkingPoints.map((point) => ({ ...point,
      id: newId(point.id), poses: point.poses.map((pose) => ({ ...pose, id: newId(pose.id) })),
    })),
  }));
  const points = transformWaypoints(local.waypoints, matrix).map((point) => ({ ...point, id: newId(point.id) }));
  const sourceRobot = local.robot || background.robot;
  const previousTransfer = background.workspace.transfer;
  const priorPlacements = previousTransfer?.kind === 'placement'
    ? [previousTransfer, ...(previousTransfer.previousPlacements || [])] : [];
  const mapFrameSources = [await mapIdentity(target.map),
    ...(previousTransfer?.kind === 'placement' && Array.isArray(previousTransfer.mapFrameSources)
      ? previousTransfer.mapFrameSources : [])];
  const previousPlacements = priorPlacements
    .filter((item) => source.map.teachingGroupId
      ? item.sourceMap.teachingGroupId !== source.map.teachingGroupId
      : item.sourceMap.mapId !== source.map.mapId)
    .map(({ previousPlacements: earlier, mapFrameSources: earlierFrames, geometryLayers: earlierLayers, ...placement }) => placement);
  map.portableRobotPackage = [source.map.portableRobotPackage, target.map.portableRobotPackage]
    .find((candidate) => candidate?.relativePath === sourceRobot?.relativePath) || null;
  const result = snapshotResult({ ...background,
    robot: local.robot ? { ...local.robot, origin: transformTeachingPose(local.robot.origin, matrix) } : sourceRobot,
    teachingTasks: [...transformTeachingTasks(background.teachingTasks, new Matrix4(), 'map', map), ...importedTasks],
    waypoints: [...background.waypoints, ...points],
    edges: [...background.edges, ...local.edges.map((edge) => ({ ...edge, id: newId(edge.id), from: newId(edge.from), to: newId(edge.to), status: 'unchecked' }))],
    jointPoses: [...background.jointPoses, ...local.jointPoses.map((pose) => ({ ...pose, id: newId(pose.id) }))],
    workspace: { ...background.workspace,
      activeTeachingTaskId: importedTasks[0]?.id || background.workspace.activeTeachingTaskId,
      activeTeachingParkingPointId: importedTasks[0]?.parkingPoints[0]?.id || null,
    },
  }, map, 'map', { version: 1, kind: 'placement', id: createId('transfer'),
    geometryLayers: appendPlacedObjectLayers(map, target.map, previousTransfer, source.map.pointCount),
    sourceMap: await mapIdentity(source.map), localToMap, createdAt: new Date().toISOString(),
    mapFrameSources: mapFrameSources.filter((item, index, all) => all.findIndex(
      (candidate) => candidate.sourceHash === item.sourceHash && candidate.mapId === item.mapId,
    ) === index),
    ...(previousPlacements.length ? { previousPlacements } : {}),
    matrixImports: normalizeTransferMatrixImports(matrixImports ?? boundTeachingRelation(
      source.map, local.workspace.transfer, target.map, background.workspace.transfer,
    )?.matrixImports),
  });
  return result;
}

async function verifyBaseline(baseline, project) {
  const verifyItems = async (saved, current) => {
    const byId = new Map(current.map((item) => [item.id, item]));
    for (const item of saved) {
      requireValue(byId.has(item.id) && await hashObject(byId.get(item.id)) === item.hash,
        '原地图中的对应内容已修改，无法直接回写；请重新提取局部以避免覆盖修改');
    }
  };
  for (const saved of baseline.tasks) {
    const task = project.teachingTasks.find((item) => item.id === saved.id);
    requireValue(task, '原地图中的来源任务已删除，请重新提取局部');
    if (saved.mobileHash) requireValue(await hashObject({ capture: task.mobileCapture, transform: task.mobileTransform }) === saved.mobileHash,
      '原地图中的 iPad 示教已修改，请重新提取局部');
    await verifyItems(saved.parkingPoints, task.parkingPoints);
    await verifyItems(saved.polylines || [], task.polylines || []);
  }
  await verifyItems(baseline.waypoints, project.waypoints);
  await verifyItems(baseline.edges, project.edges);
  await verifyItems(baseline.jointPoses || [], project.jointPoses);
}

export async function writeBackTeachingWorkspace(source, target) {
  const local = snapshotProject(source), background = snapshotProject(target);
  const transfer = local.workspace.transfer;
  requireValue(transfer?.version === 1 && transfer.kind === 'extraction', '当前工程没有可回写的地图来源');
  requireValue((await mapIdentity(target.map)).sourceHash === transfer.sourceMap.sourceHash,
    '当前地图不是提取时的原地图，请先打开对应地图工程');
  requireValue((local.robot?.relativePath || null) === transfer.robotPath, '局部工程已更换机器人，请使用提取时的机器人进行回写');
  assertRobotCompatibility(local, background);
  await verifyBaseline(transfer.baseline, background);
  const matrix = transferMatrix(transfer.localToMap);
  const tasks = transformTeachingTasks(local.teachingTasks, matrix, 'map', target.map);
  const selectedTaskIds = new Set(transfer.baseline.tasks.map((task) => task.id));
  const targetTaskIds = new Set(background.teachingTasks.map((task) => task.id));
  for (const task of tasks) requireValue(selectedTaskIds.has(task.id) || !targetTaskIds.has(task.id), '新增任务与原地图 ID 冲突，请重新创建该任务');
  const mergedTasks = background.teachingTasks.map((task) => {
    const saved = transfer.baseline.tasks.find((item) => item.id === task.id);
    if (!saved) return task;
    const edited = tasks.find((item) => item.id === task.id);
    const selected = new Set(saved.parkingPoints.map((item) => item.id));
    const untouched = task.parkingPoints.filter((point) => !selected.has(point.id));
    const untouchedIds = new Set(untouched.map((point) => point.id));
    requireValue(!edited?.parkingPoints.some((point) => untouchedIds.has(point.id)), '局部停车点与原地图其他停车点 ID 冲突');
    requireValue(!edited || edited.name === saved.name || task.name === saved.name || task.name === edited.name,
      '任务名称在两种模式下都已修改，请统一名称后回写');
    const edits = new Map((edited?.parkingPoints || []).map((point) => [point.id, point]));
    const parkingPoints = task.parkingPoints.flatMap((point) => selected.has(point.id)
      ? edits.has(point.id) ? [edits.get(point.id)] : [] : [point]);
    parkingPoints.push(...(edited?.parkingPoints || []).filter((point) => !selected.has(point.id)));
    const selectedPolylines = new Set((saved.polylines || []).map((path) => path.id));
    const untouchedPolylines = (task.polylines || []).filter((path) => !selectedPolylines.has(path.id));
    requireValue(!(edited?.polylines || []).some((path) => untouchedPolylines.some((other) => other.id === path.id)), '局部折线与原地图其他折线 ID 冲突');
    const polylines = [...untouchedPolylines, ...(edited?.polylines || [])];
    return { ...task, name: edited && edited.name !== saved.name ? edited.name : task.name,
      ...(task.polylines || edited?.polylines ? { polylines } : {}),
      ...(saved.mobileHash ? { mobileCapture: edited?.mobileCapture, mobileTransform: edited?.mobileTransform } : {}),
      parkingPoints, updatedAt: new Date().toISOString() };
  }).filter((task) => !selectedTaskIds.has(task.id) || task.parkingPoints.length || task.polylines?.length || tasks.some((edited) => edited.id === task.id));
  mergedTasks.push(...tasks.filter((task) => !selectedTaskIds.has(task.id)));
  const mergeGraph = (original, edited, saved) => {
    const selected = new Set(saved.map((item) => item.id));
    const untouched = original.filter((item) => !selected.has(item.id));
    const used = new Set(untouched.map((item) => item.id));
    requireValue(!edited.some((item) => used.has(item.id)), '局部数据与原地图 ID 冲突');
    return [...untouched, ...edited];
  };
  const points = transformWaypoints(local.waypoints, matrix);
  const waypoints = mergeGraph(background.waypoints, points, transfer.baseline.waypoints);
  const pointIds = new Set(waypoints.map((point) => point.id));
  const touchedPoints = new Set([...points, ...transfer.baseline.waypoints].map((point) => point.id));
  const edges = mergeGraph(background.edges, local.edges, transfer.baseline.edges)
    .filter((edge) => pointIds.has(edge.from) && pointIds.has(edge.to))
    .map((edge) => ({ ...edge, status: touchedPoints.has(edge.from) || touchedPoints.has(edge.to) ? 'unchecked' : edge.status }));
  const nextProject = { ...background, teachingTasks: mergedTasks, waypoints, edges,
    robot: local.robot ? { ...local.robot, origin: transformTeachingPose(local.robot.origin, matrix) } : background.robot,
    jointPoses: mergeGraph(background.jointPoses, local.jointPoses, transfer.baseline.jointPoses || []),
  };
  const result = snapshotResult(nextProject, { ...target.map,
    portableRobotPackage: source.map.portableRobotPackage || target.map.portableRobotPackage,
  }, 'map', background.workspace.transfer, background.workspace.directoryAutosaveSuspended);
  const savedProject = normalizeProject(result.config.project);
  const updatedBaseline = await createBaseline({
    teachingTasks: savedProject.teachingTasks.flatMap((task) => {
      const localTask = tasks.find((item) => item.id === task.id);
      if (!localTask) return [];
      const parkingIds = new Set(localTask.parkingPoints.map((point) => point.id));
      return [{ ...task, parkingPoints: task.parkingPoints.filter((point) => parkingIds.has(point.id)),
        ...(task.polylines ? { polylines: task.polylines.filter((path) => localTask.polylines?.some((localPath) => localPath.id === path.id)) } : {}) }];
    }),
    waypoints: savedProject.waypoints.filter((point) => points.some((localPoint) => localPoint.id === point.id)),
    edges: savedProject.edges.filter((edge) => local.edges.some((localEdge) => localEdge.id === edge.id)),
    jointPoses: savedProject.jointPoses.filter((pose) => local.jointPoses.some((localPose) => localPose.id === pose.id)),
  });
  result.sourceConfig = { ...source.config.config,
    project: { ...source.config.config.project,
      virtualTeaching: { ...source.config.config.project.virtualTeaching,
        tasks: source.config.config.project.virtualTeaching.tasks.map((task) => ({ ...task,
          name: savedProject.teachingTasks.find((item) => item.id === task.id)?.name || task.name,
        })),
      },
      workspace: { ...source.config.config.project.workspace,
        transfer: { ...transfer, baseline: updatedBaseline, lastWrittenAt: new Date().toISOString() },
      },
    },
  };
  return result;
}
