import { createId, normalizeProject } from './io.js';
import { isTeachingAlignmentTarget, transferMatrix } from './teachingTransfer.js';

export const PROJECT_WORKSPACE_MODES = ['map', 'independent'];

export function validateProjectWorkspace(snapshot, { requireRobotResources = true } = {}) {
  const payload = snapshot?.config?.config?.project;
  const mode = snapshot?.mode;
  if (!PROJECT_WORKSPACE_MODES.includes(mode)
    || typeof snapshot.map?.mapId !== 'string' || !snapshot.map.mapId || !payload
    || payload.workspace?.teachingSpaceMode !== mode
    || snapshot.config.mapId !== snapshot.map.mapId
    || snapshot.map.geometryCacheVersion !== 1
    || !(snapshot.map.positionBuffer instanceof ArrayBuffer)
    || !snapshot.map.positionBuffer.byteLength || snapshot.map.positionBuffer.byteLength % 12 !== 0
    || (requireRobotResources && payload.robot
      && snapshot.map.portableRobotPackage?.relativePath !== payload.robot.relativePath)) {
    throw new Error(`工程中的${mode === 'map' ? '地图示教' : '独立示教'}资源不完整`);
  }
  normalizeProject(payload);
  const transfer = payload.workspace.transfer;
  for (const relation of [transfer, ...(transfer?.previousPlacements || [])]) {
    if (relation) transferMatrix(relation.localToMap);
  }
}

export function validateWorkspaceCollection(collection, options = {}) {
  const { workspaces, independentHistory, activeMode } = collection || {};
  if (!workspaces || !PROJECT_WORKSPACE_MODES.includes(activeMode) || !workspaces[activeMode]
    || Object.keys(workspaces).some((mode) => !PROJECT_WORKSPACE_MODES.includes(mode))
    || !Array.isArray(independentHistory)) {
    throw new Error('完整工程的工作区或独立示教列表无效');
  }
  const ids = new Set();
  const snapshots = [...Object.values(workspaces), ...independentHistory];
  for (const snapshot of snapshots) {
    validateProjectWorkspace(snapshot, options);
    if (ids.has(snapshot.map.mapId)) throw new Error('完整工程包含重复的工作区身份');
    ids.add(snapshot.map.mapId);
  }
  for (const [mode, snapshot] of Object.entries(workspaces)) {
    if (snapshot.mode !== mode) throw new Error('完整工程的工作区模式不匹配');
  }
  for (const snapshot of independentHistory) {
    if (snapshot.mode !== 'independent' || !Number.isFinite(snapshot.archivedAt) || snapshot.archivedAt < 0) {
      throw new Error('独立示教缓存记录无效');
    }
  }
}

// File handles belong to the importing device. Give every workspace a fresh
// local ID, including historical groups referenced by previous placements.
// Geometry, group identities, matrices and extraction baselines stay intact.
export function prepareWorkspaceCollectionImport(collection) {
  validateWorkspaceCollection(collection);
  const snapshots = [...Object.values(collection.workspaces), ...collection.independentHistory];
  const ids = new Map(snapshots.map((snapshot) => [snapshot.map.mapId, createId('map-portable')]));
  const prepare = (original) => {
    const project = structuredClone(original.config.config.project);
    const transfer = project.workspace.transfer;
    for (const relation of [transfer, ...(transfer?.previousPlacements || [])]) {
      const source = relation?.sourceMap;
      if (!source) continue;
      const candidates = snapshots.filter((snapshot) => snapshot.mode !== original.mode);
      const exact = candidates.find(({ map }) => source.mapId === map.mapId
        && (!source.teachingGroupId || source.teachingGroupId === map.teachingGroupId));
      const matches = candidates.filter(({ map, config }) => (source.teachingGroupId
        ? source.teachingGroupId === map.teachingGroupId
        : !map.teachingGroupId && source.sourceHash && source.sourceHash === map.sourceHash)
        || isTeachingAlignmentTarget(relation, map, config.config.project.workspace.transfer));
      const target = exact || (matches.length === 1 ? matches[0] : null);
      if (target) source.mapId = ids.get(target.map.mapId);
    }
    project.workspace.directoryAutosaveSuspended = true;
    const mapId = ids.get(original.map.mapId);
    return {
      ...original,
      map: { ...original.map, mapId,
        portableOriginalMapId: original.map.portableOriginalMapId || original.map.mapId,
        workspaceViews: { view2d: project.view2d || null, view3d: project.view3d || null } },
      config: { mapId, config: { schemaVersion: 1, project, ui: {
        ...project.workspace,
        ...structuredClone(original.config.config.ui || {}),
        teachingSpaceMode: original.mode,
        selectedRobot: project.robot,
      } } },
    };
  };
  return {
    activeMode: collection.activeMode,
    workspaces: Object.fromEntries(Object.entries(collection.workspaces).map(([mode, snapshot]) => [mode, prepare(snapshot)])),
    independentHistory: collection.independentHistory.map(prepare),
  };
}
