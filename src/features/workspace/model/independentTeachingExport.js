import { normalizeTeachingTasks } from "./io.js";
import { mapRouteSyncStatus } from "../../navigation/model/mapRouteSync.js";
import { boundTeachingTransform, transferMatrix, transformTeachingPose, transformTeachingTasks } from "../../teaching/model/teachingTransfer.js";

// Build an export-only map snapshot. Do not place geometry, write back tasks,
// or reuse the map workspace's potentially older copy of this teaching group.
export function buildIndependentMapTeachingExport(payload, independentMap, mapConfig) {
  if (payload.workspace?.teachingSpaceMode !== 'independent') {
    throw new Error('请在独立示教中选择地图任务导出');
  }
  const status = mapRouteSyncStatus(independentMap, payload.workspace.transfer, mapConfig);
  if (!status.available) throw new Error(status.reason);
  const background = mapConfig.config.project;
  const map = { ...background.map, mapId: mapConfig.mapId, name: background.map.fileName };
  const localToMap = boundTeachingTransform(independentMap, payload.workspace.transfer,
    map, background.workspace?.transfer);
  const matrix = transferMatrix(localToMap);
  const tasks = transformTeachingTasks(normalizeTeachingTasks(payload), matrix, 'map', map);
  const previous = background.workspace?.transfer;
  const previousPlacements = previous?.kind === 'placement'
    ? [previous, ...(previous.previousPlacements || [])].map(({ previousPlacements: earlier, ...placement }) => placement)
    : [];
  return {
    ...background,
    exportedAt: payload.exportedAt,
    workspace: {
      ...background.workspace,
      activeTeachingTaskId: payload.workspace.activeTeachingTaskId,
      activeTeachingParkingPointId: payload.workspace.activeTeachingParkingPointId,
      // The existing station matcher also uses this saved transform to resolve
      // historical local-height offsets, without changing navigation tolerance.
      transfer: { version: 1, kind: 'placement', localToMap,
        ...(previousPlacements.length ? { previousPlacements } : {}),
        sourceMap: { mapId: independentMap.mapId, sourceHash: independentMap.sourceHash,
          teachingGroupId: independentMap.teachingGroupId, name: independentMap.name } },
    },
    robot: payload.robot ? { ...payload.robot,
      origin: transformTeachingPose(payload.robot.origin, matrix, 'map') } : null,
    virtualTeaching: { ...payload.virtualTeaching, coordinateFrame: 'map', tasks },
  };
}
