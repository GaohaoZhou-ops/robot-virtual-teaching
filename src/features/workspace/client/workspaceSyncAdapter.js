import { buildExport, normalizeProject } from '../model/io.js';
import { createGeometryCache } from '../model/workspaceGeometry.js';
import { syncDocument, retainSyncReferences } from '../../../shared/protocols/workSyncDocument.js';
import { TEMPORARY_MAP_ROUTE_SOURCE } from '../../teaching/model/teachingNavigation.js';
import { placedObjectLayers } from '../../viewport/model/placedObjectRendering.js';

export const workspaceSyncIdentity = (current) => JSON.stringify([
  current.teachingSpaceMode, current.mapData?.mapId,
  current.mapData?.sourceHash, current.selectedRobot?.relativePath || '',
]);

export function mergeWorkspaceSyncDocument(current, document) {
  const { displaySettings, ...sharedDocument } = document;
  const next = Object.fromEntries(Object.entries(sharedDocument)
    .map(([key, value]) => [key, retainSyncReferences(current[key], value)]));
  const temporaryPoints = current.waypoints.filter((point) => point.source === TEMPORARY_MAP_ROUTE_SOURCE);
  if (temporaryPoints.length) {
    const temporaryIds = new Set(temporaryPoints.map((point) => point.id));
    next.waypoints = [...next.waypoints, ...temporaryPoints];
    const ids = new Set(next.waypoints.map((point) => point.id));
    next.edges = [...next.edges, ...current.edges.filter((edge) =>
      (edge.source === TEMPORARY_MAP_ROUTE_SOURCE || temporaryIds.has(edge.from) || temporaryIds.has(edge.to))
      && ids.has(edge.from) && ids.has(edge.to))];
  }
  return { next, displaySettings };
}

/**
 * Adapt the workspace to the collaboration protocol without owning React state.
 * `workspace` supplies current snapshots and explicit apply/install/persist
 * operations; reads stay live during long archive transfers and reconnects.
 */
export function createWorkspaceSyncAdapter({ deviceName, workspace, checkpoints }) {
  const identity = () => workspaceSyncIdentity(workspace.read());
  const payload = () => {
    const current = workspace.read();
    return buildExport({ ...current, robot: current.selectedRobot,
      transfer: current.workspaceTransfer, ...workspace.views() });
  };
  return {
    deviceName,
    ready: () => workspace.ready(),
    identity,
    project() {
      const current = workspace.read();
      if (!workspace.available() || !current.mapData?.geometry) return null;
      return { key: identity(), mode: current.teachingSpaceMode,
        name: current.independentTeachingName || current.mapData.name || '当前工程' };
    },
    readDocument: () => syncDocument(normalizeProject(payload())),
    applyDocument(document) {
      const { next, displaySettings } = mergeWorkspaceSyncDocument(workspace.read(), document);
      workspace.apply(next, displaySettings);
    },
    async buildInitial(onProgress) {
      const current = workspace.read();
      if (!current.mapData?.geometry || workspace.transferBlocked()) throw new Error('请先完成当前工程加载');
      const localIdentity = identity(), project = payload();
      project.workspace.transfer = null;
      const document = syncDocument(normalizeProject(project)), map = current.mapData;
      const mapResource = createGeometryCache(map.geometry, map.bounds, map.byteLength, map.sourceHash, map.sourceHashKind, {
        geometryLayers: placedObjectLayers(map, current.workspaceTransfer),
        fileModifiedAt: map.fileModifiedAt, mimeType: map.mimeType, loadedAt: map.loadedAt,
        sourceKind: map.sourceKind, sourceBlob: map.sourceBlob, teachingSpaceMode: current.teachingSpaceMode,
        teachingGroupId: map.teachingGroupId,
      });
      mapResource.mapId = map.mapId;
      const portable = workspace.robotPackage();
      const existingRobotPackage = portable?.relativePath === current.selectedRobot?.relativePath ? portable : null;
      const { buildProjectArchive } = await import('../model/projectArchive.js');
      const archive = await buildProjectArchive(project, { mapResource, existingRobotPackage, onProgress,
        geometryTransfer: current.workspaceTransfer, loadGeometrySource: workspace.loadGeometrySource });
      return { bytes: archive.bytes, document, localIdentity };
    },
    async installInitial(bytes, project, isActive, onProgress) {
      const { readProjectArchive } = await import('../model/projectArchive.js');
      const imported = await readProjectArchive(bytes, {
        onProgress: (value) => onProgress?.({ ...value, progress: (Number(value.progress) || 0) * 0.8 }),
      });
      if (!isActive()) return;
      onProgress?.({ phase: '恢复地图、机器人与示教结果', progress: 0.85 });
      await workspace.install(imported, project);
      await workspace.afterPaint();
      onProgress?.({ phase: '保存恢复后的工程', progress: 1 });
    },
    persist: workspace.persist,
    loadCheckpoint: checkpoints.load,
    saveCheckpoint: checkpoints.save,
  };
}
