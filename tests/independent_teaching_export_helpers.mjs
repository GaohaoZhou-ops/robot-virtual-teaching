import { buildExport, normalizeTeachingTasks } from '../src/lib/io.js';
import { abxRouteToProject } from '../src/lib/abxRoute.js';
import { transferMatrix, transformTeachingPose, transformTeachingTasks } from '../src/lib/teachingTransfer.js';
import { teachingTransferFixture } from './teaching_transfer_helpers.mjs';
import { abxTeachingFixture } from './abx_teaching_helpers.mjs';
import { Matrix4 } from 'three';

export function independentTeachingExportFixture() {
  const { payload, robotPackage, values } = abxTeachingFixture();
  const map = teachingTransferFixture('map'), local = teachingTransferFixture('independent');
  local.map.teachingGroupId = 'export-group';
  const localToMap = { position: { x: 5, y: -3, z: 1 }, rpy: { roll: 8, pitch: -5, yaw: 90 } };
  const route = { schema_version: 1, id: 'independent-export', name: '完整路网', scene_name: 'big_map_1',
    nodes: [{ id: 0, label: '停车点 A', x_m: 1.25, y_m: -2.5, yaw_rad: Math.PI / 2 },
      { id: 31, label: '停车点 B', x_m: 4.5, y_m: 6.75, yaw_rad: -Math.PI },
      { id: 99, label: '未示教站点', x_m: 12, y_m: 15, yaw_rad: null }],
    edges: [{ id: 257, start: 0, end: 31 }, { id: 258, start: 31, end: 99 }] };
  const task = normalizeTeachingTasks(payload)[0];
  task.id = 'current-local-task'; task.name = '当前独立任务';
  const stale = structuredClone(task);
  stale.id = 'map-only-task'; stale.name = '地图已有旧任务';
  task.parkingPoints[0].poses[0].fullBodyJoints.values.left_J1 = 42 * Math.PI / 180;
  const inverse = transferMatrix(localToMap).invert();
  for (const fixture of [map, local]) {
    const independent = fixture === local;
    fixture.map.portableRobotPackage = robotPackage;
    const project = buildExport({ mapData: fixture.map, teachingSpaceMode: fixture.mode, heightRange: [0, 2],
      ...(independent ? { waypoints: [], edges: [] } : abxRouteToProject(route)),
      robot: payload.robot, robotJointValues: values,
      robotPose: independent ? transformTeachingPose(task.parkingPoints[0].mapPose, inverse) : task.parkingPoints[0].mapPose,
      teachingTasks: transformTeachingTasks(independent ? [task] : [stale], independent ? inverse : new Matrix4(), fixture.mode, fixture.map),
      transfer: independent ? { version: 1, kind: 'alignment', localToMap,
        sourceMap: { mapId: map.map.mapId, sourceHash: map.map.sourceHash } } : null,
    });
    fixture.config.config = { schemaVersion: 1, project,
      ui: { selectedRobot: project.robot, mapRouteSyncEnabled: independent } };
  }
  return { map, local, route, robotPackage, task, localToMap };
}
