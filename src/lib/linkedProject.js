import { createId, normalizeProject } from './io.js';
import { boundTeachingRelation, transferMatrix } from './teachingTransfer.js';

export const LINKED_WORKSPACE_MODES = ['map', 'independent'];

// Use the same identity check as teaching conversion and temporary route sync.
// Merely having two cached workspaces does not make them a bound pair.
export function linkedWorkspaceRelation(workspaces) {
  const independent = workspaces?.independent;
  const map = workspaces?.map;
  return boundTeachingRelation(
    independent?.map,
    independent?.config?.config?.project?.workspace?.transfer,
    map?.map,
    map?.config?.config?.project?.workspace?.transfer,
  );
}

export function validateLinkedWorkspaces(workspaces, { requireRobotResources = true } = {}) {
  for (const mode of LINKED_WORKSPACE_MODES) {
    const snapshot = workspaces?.[mode];
    const payload = snapshot?.config?.config?.project;
    if (snapshot?.mode !== mode || typeof snapshot.map?.mapId !== 'string' || !snapshot.map.mapId || !payload
      || payload.workspace?.teachingSpaceMode !== mode
      || snapshot.config.mapId !== snapshot.map.mapId
      || snapshot.map.geometryCacheVersion !== 1
      || !(snapshot.map.positionBuffer instanceof ArrayBuffer)
      || !snapshot.map.positionBuffer.byteLength || snapshot.map.positionBuffer.byteLength % 12 !== 0
      || (requireRobotResources && payload.robot && !snapshot.map.portableRobotPackage)) {
      throw new Error(`双边工程中的${mode === 'map' ? '地图示教' : '独立示教'}资源不完整`);
    }
    normalizeProject(payload);
  }
  const relation = linkedWorkspaceRelation(workspaces);
  if (!relation) throw new Error('双边工程的地图示教与独立示教绑定关系不匹配');
  transferMatrix(relation.localToMap);
}

// New local identities prevent an imported project from inheriting an older
// project's file handles. Rewrite only identity references, never coordinates,
// transformation matrices, baseline hashes, or teaching data.
export function prepareLinkedProjectImport(workspaces) {
  validateLinkedWorkspaces(workspaces);
  const ids = Object.fromEntries(LINKED_WORKSPACE_MODES.map((mode) => [mode, createId('map-portable')]));
  return Object.fromEntries(LINKED_WORKSPACE_MODES.map((mode) => {
    const original = workspaces[mode];
    const opposite = workspaces[mode === 'map' ? 'independent' : 'map'];
    const project = structuredClone(original.config.config.project);
    const transfer = project.workspace.transfer;
    if (transfer?.sourceMap && (transfer.sourceMap.mapId === opposite.map.mapId
      || (transfer.sourceMap.sourceHash && transfer.sourceMap.sourceHash === opposite.map.sourceHash))) {
      transfer.sourceMap.mapId = ids[opposite.mode];
    }
    // A portable import must never reconnect to a previously remembered folder.
    project.workspace.directoryAutosaveSuspended = true;
    const ui = {
      ...project.workspace,
      ...original.config.config.ui,
      teachingSpaceMode: mode,
      selectedRobot: project.robot,
    };
    return [mode, {
      mode,
      map: { ...original.map, mapId: ids[mode] },
      config: { mapId: ids[mode], config: { schemaVersion: 1, project, ui } },
    }];
  }));
}
