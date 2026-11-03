import { Matrix4, Vector3 } from 'three';
import { buildExport, normalizeProject } from '../../workspace/model/io.js';
import { createGeometryCache, restoreGeometryFromCache, serializeBounds } from '../../workspace/model/workspaceGeometry.js';
import { placedObjectLayers, recoverPlacedObjectLayers } from '../../viewport/model/placedObjectRendering.js';
import { sha256Bytes } from '../../../shared/utils/hash.js';
import { hasLoadedMapWorkspace, mapTeachingCalibrationMatrix, parseTransferMatrixFile,
  transformTeachingPose, transformTeachingTasks } from './teachingTransfer.js';

export async function readMapTeachingMatrix(file) {
  if (!/\.txt$/i.test(file.name)) throw new Error('请选择 TXT 转换矩阵文件');
  if (file.size > 1024 * 1024) throw new Error('转换矩阵文件不能超过 1 MB');
  const { values } = parseTransferMatrixFile(await file.text());
  return { version: 1, name: file.name, values };
}

// The stored matrix is an absolute virtual-to-map calibration. Replacing A
// with B uses B * inverse(A), never B * A. This also preserves edits made in
// the calibrated frame, without retaining a stale copy of the whole project.
export async function transformMapTeachingWorkspace(source, imported, { loadSource } = {}) {
  if (!hasLoadedMapWorkspace(source)) throw new Error('请先加载完整的地图示教工程');
  const project = normalizeProject(source.config.config.project);
  const nextMatrix = mapTeachingCalibrationMatrix(imported);
  const previous = project.workspace.mapTransform;
  const previousMatrix = mapTeachingCalibrationMatrix(previous);
  const unchanged = nextMatrix.elements.every((value, index) => Math.abs(value - previousMatrix.elements[index]) < 1e-12);
  const delta = unchanged ? new Matrix4() : nextMatrix.clone().multiply(previousMatrix.clone().invert());
  const originalTransfer = project.workspace.transfer;
  let layers = placedObjectLayers(source.map, originalTransfer);
  if (originalTransfer?.kind === 'placement' && !layers?.complete) {
    layers = await recoverPlacedObjectLayers(source.map, originalTransfer, loadSource || (async () => null));
    if (!layers?.complete) throw new Error('无法确认地图中独立对象的完整范围，请先恢复对应的独立示教工程再加载转换矩阵');
  }
  if (layers && !layers.complete) throw new Error('地图中的独立对象范围不完整，无法应用转换矩阵');

  let map = source.map;
  if (!unchanged && layers?.objectRanges.length) {
    // Only appended independent objects move. The original map scan remains
    // byte-for-byte unchanged, even where it overlaps an independent object.
    const positions = new Float32Array(source.map.positionBuffer.slice(0));
    const point = new Vector3();
    for (const { start, count } of layers.objectRanges) {
      for (let index = start; index < start + count; index += 1) {
        const offset = index * 3;
        point.fromArray(positions, offset).applyMatrix4(delta).toArray(positions, offset);
        if (!Number.isFinite(positions[offset]) || !Number.isFinite(positions[offset + 1]) || !Number.isFinite(positions[offset + 2])) {
          throw new Error('转换后的独立对象坐标无效，请检查转换矩阵');
        }
        if (index && index % 250000 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    const hashes = await Promise.all([positions, source.map.colorBuffer || new Uint8Array(),
      source.map.indexBuffer || new Uint8Array()].map((value) => sha256Bytes(value instanceof ArrayBuffer ? new Uint8Array(value) : value)));
    const sourceHash = await sha256Bytes(new TextEncoder().encode(JSON.stringify(hashes)));
    layers = { ...layers, sourceHash };
    const geometry = restoreGeometryFromCache({ ...source.map, positionBuffer: positions.buffer, bounds: null, sphere: null });
    try {
      map = { ...source.map,
        ...createGeometryCache(geometry, serializeBounds(geometry.boundingBox),
          positions.byteLength + (source.map.colorBuffer?.byteLength || 0) + (source.map.indexBuffer?.byteLength || 0),
          sourceHash, 'geometry', { ...source.map, sourceBlob: null, geometryLayers: layers, sourceKind: 'map-teaching-transform' }),
        blob: null,
      };
    } finally { geometry.dispose(); }
  }

  const transformPlacement = (placement) => ({ ...placement,
    localToMap: unchanged ? placement.localToMap : transformTeachingPose(placement.localToMap, delta),
  });
  const transfer = originalTransfer?.kind === 'placement' ? {
    ...transformPlacement(originalTransfer), geometryLayers: layers,
    ...(originalTransfer.previousPlacements ? {
      previousPlacements: originalTransfer.previousPlacements.map(transformPlacement),
    } : {}),
    mapFrameSources: [...(originalTransfer.mapFrameSources || []),
      ...((originalTransfer.mapFrameSources || []).some((item) => item.sourceHash === source.map.sourceHash)
        ? [] : [{ mapId: source.map.mapId, name: source.map.name, sourceHash: source.map.sourceHash }])],
  } : originalTransfer;
  const waypoints = unchanged ? project.waypoints : project.waypoints.map((point) => {
    const pose = transformTeachingPose({ position: point.pose,
      rpy: { roll: point.pose.roll, pitch: point.pose.pitch, yaw: point.pose.yaw } }, delta);
    return { ...point, pose: { ...pose.position, ...pose.rpy } };
  });
  const payload = buildExport({
    ...project, ...project.workspace, mapData: map,
    heightRange: project.slice || [map.bounds.min.z, map.bounds.max.z],
    waypoints, edges: unchanged ? project.edges : project.edges.map((edge) => ({ ...edge, status: 'unchecked' })),
    teachingTasks: unchanged ? project.teachingTasks : transformTeachingTasks(project.teachingTasks, delta, 'map', map),
    robotPose: project.robot && !unchanged ? transformTeachingPose(project.robot.origin, delta) : project.robot?.origin,
    robotJointValues: project.robot?.joints, lockedRobotJointNames: project.robot?.lockedJoints,
    ignoredRobotCollisionJointNames: project.robot?.collisionIgnoredJoints, robotHeightLocked: project.robot?.heightLocked,
    meshRenderQuality: project.rendering?.meshQuality || 'auto',
    transfer, mapTransform: imported,
    // Geometry changes must not be written into an old directory's config
    // without replacing its geometry resources; use the normal Save As flow.
    directoryAutosaveSuspended: true,
  });
  const ui = { ...source.config.config.ui, ...payload.workspace, selectedRobot: payload.robot,
    robotWaypointLocation: null, validation: { status: 'idle', unreachableCount: 0, checkedAt: null } };
  return { mode: 'map', map, config: { ...source.config.config, project: payload, ui } };
}
