import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { buildExport, clampSlice, createId } from './io.js';
import { createGeometryCache, serializeBounds, suggestedSlice } from './workspaceGeometry.js';
import { defaultIndependentTeachingName, validateIndependentTeachingName } from './independentTeachingName.js';
import { normalizeRobotPose } from '../../robot/model/robotLoader.js';
import { createTeachingAlignment, identityTransferPose, parseTransferMatrixFile, placeTeachingWorkspace,
  transformTeachingPose } from '../../teaching/model/teachingTransfer.js';
import { mapRouteSyncStatus } from '../../navigation/model/mapRouteSync.js';
import { prepareMapGeometryTopology } from '../../../shared/geometry/mapGeometry.js';
import { sha256ArrayBuffer } from '../../../shared/utils/hash.js';

const stem = (name) => String(name).replace(/\.(ply|txt)$/i, '').toLowerCase();
const numberedStem = (name) => stem(name).match(/^(?:model|position|transform|matrix)[_-]?(\d+)$/)?.[1];

// Match only unambiguous names, never the order returned by a file picker.
export function matchingBatchMatrix(modelName, matrices) {
  const exact = matrices.filter((item) => stem(item.name) === stem(modelName));
  if (exact.length) return exact.length === 1 ? exact[0].id : '';
  const number = numberedStem(modelName);
  const numbered = number === undefined ? [] : matrices.filter((item) => numberedStem(item.name) === number);
  return numbered.length === 1 ? numbered[0].id : '';
}

export function newIndependentBatchRow(modelId, fileName, preferences = {}) {
  return { id: createId('batch-row'), modelId, name: defaultIndependentTeachingName(fileName),
    matrixId: '', matrixManual: false, syncRoute: preferences.syncRoute === true,
    placeInMap: preferences.placeInMap === true };
}

export async function readIndependentBatchMatrix(file) {
  if (!/\.txt$/i.test(file.name)) throw new Error('请选择 TXT 转换矩阵文件');
  if (file.size > 1024 * 1024) throw new Error('转换矩阵文件不能超过 1 MB');
  const parsed = parseTransferMatrixFile(await file.text());
  return { name: file.name, values: parsed.values,
    localToMap: transformTeachingPose(identityTransferPose(), parsed.matrix) };
}

async function readModel(file) {
  const buffer = await file.arrayBuffer();
  const geometry = new PLYLoader().parse(buffer);
  try {
    const positions = geometry.getAttribute('position')?.array;
    if (!positions?.length || positions.length % 3 || !positions.every(Number.isFinite)) {
      throw new Error('PLY 文件中没有有效的顶点坐标');
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    prepareMapGeometryTopology(geometry);
    const bounds = serializeBounds(geometry.boundingBox);
    return { cache: createGeometryCache(geometry, bounds, buffer.byteLength, await sha256ArrayBuffer(buffer), 'file', {
      sourceBlob: file, fileModifiedAt: file.lastModified, mimeType: file.type, loadedAt: Date.now(),
      sourceKind: 'independent-teaching-file', teachingSpaceMode: 'independent',
    }), slice: clampSlice(suggestedSlice(positions, bounds), bounds) };
  } finally {
    geometry.dispose();
  }
}

// Prepare everything before opening a storage transaction. Repeated instances
// share parsing work, but receive distinct group identities and configurations.
export async function prepareIndependentTeachingBatch(entries, { targetMap, settings, robotPackage, onProgress = () => {} }) {
  if (!entries?.length) throw new Error('请先添加独立示教组');
  for (const [index, entry] of entries.entries()) {
    try {
      validateIndependentTeachingName(entry.name);
      if (!/\.ply$/i.test(entry.file?.name || '')) throw new Error('请选择 PLY 模型');
      if ((entry.syncRoute || entry.placeInMap) && !entry.matrix) throw new Error('同步路网或放入地图需要转换矩阵');
    } catch (error) { throw new Error(`第 ${index + 1} 组：${error.message}`); }
  }
  const models = new Map();
  const replacements = [];
  let mapPlacement = null;
  for (const [index, entry] of entries.entries()) {
    const name = validateIndependentTeachingName(entry.name);
    onProgress({ progress: index / entries.length * 0.9, phase: `准备第 ${index + 1} / ${entries.length} 组`, detail: name });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      let model = models.get(entry.file);
      if (!model) { model = await readModel(entry.file); models.set(entry.file, model); }
      // All matrices refer to the original target map frame, independently.
      const transfer = entry.matrix ? await createTeachingAlignment(targetMap, {
        localToMap: entry.matrix.localToMap, matrixImports: [{ name: entry.matrix.name, values: entry.matrix.values }],
      }) : null;
      const map = { ...model.cache, name: entry.file.name, mapId: createId('map'),
        teachingGroupId: createId('teaching-group'), portableRobotPackage: robotPackage };
      if (entry.syncRoute) {
        const status = mapRouteSyncStatus(map, transfer, targetMap?.config);
        if (!status.available) throw new Error(status.reason);
      }
      const project = buildExport({
        mapData: map, teachingSpaceMode: 'independent', independentTeachingName: name, heightRange: model.slice,
        waypoints: [], edges: [], robot: settings.selectedRobot, robotPose: normalizeRobotPose(null), robotJointValues: {},
        robotArmSoftLimitRatio: settings.robotArmSoftLimitRatio, robotArmSoftLimitOverrides: settings.robotArmSoftLimitOverrides,
        robotArmJointCouplingEnabled: settings.robotArmJointCouplingEnabled,
        meshRenderQuality: settings.meshRenderQuality, pointColorMode: settings.pointColorMode,
        placedObjectColorMode: settings.placedObjectColorMode, showPaths3D: settings.showPaths3D,
        annotationsOnTop3D: settings.annotationsOnTop3D, showParkingPoints3D: settings.showParkingPoints3D,
        showWaypoints3D: entry.syncRoute || settings.showWaypoints3D, showWaypointNames3D: settings.showWaypointNames3D,
        showPathNames3D: settings.showPathNames3D, showHeightLegend3D: settings.showHeightLegend3D,
        collapsedPanel: settings.collapsedPanel, inspectorCollapsed: settings.inspectorCollapsed,
        directoryAutosaveSuspended: true, transfer,
      });
      const config = { schemaVersion: 1, project, ui: { ...project.workspace, mode: 'select',
        mapRouteSyncEnabled: entry.syncRoute, selectedRobot: project.robot,
        meshRenderQuality: project.rendering.meshQuality, showSlice3D: settings.showSlice3D } };
      replacements.push({ map, config });
      if (entry.placeInMap) {
        onProgress({ progress: (index + 0.5) / entries.length * 0.9, phase: `放置第 ${index + 1} / ${entries.length} 组`, detail: name });
        const target = mapPlacement ? { mode: 'map', map: mapPlacement.map,
          config: { mapId: mapPlacement.map.mapId, config: mapPlacement.config } } : targetMap;
        // Batch placement adds aligned objects without relocating the map robot.
        mapPlacement = await placeTeachingWorkspace({ mode: 'independent', map, config: { mapId: map.mapId, config } },
          target, { localToMap: transfer.localToMap, matrixImports: transfer.matrixImports, preserveTargetRobot: true });
      }
    } catch (error) { throw new Error(`第 ${index + 1} 组「${name}」：${error.message}`); }
  }
  return { replacements, mapPlacement };
}
