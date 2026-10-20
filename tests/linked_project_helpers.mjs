import { teachingTransferFixture, transferSnapshot } from './teaching_transfer_helpers.mjs';
import { extractTeachingWorkspace, placeTeachingWorkspace } from '../src/lib/teachingTransfer.js';

export async function linkedProjectFixture(kind = 'placement') {
  const map = teachingTransferFixture('map');
  const independent = teachingTransferFixture('independent');
  for (const workspace of [map, independent]) {
    for (const task of workspace.config.config.project.virtualTeaching.tasks) {
      for (const point of task.parkingPoints) {
        point.poses.forEach((pose) => { pose.cameraCapture.frames.left.rgb.byteLength = 5; });
      }
    }
  }
  const localToMap = { position: { x: 5, y: -3, z: 1 }, rpy: { roll: 0, pitch: 0, yaw: 90 } };
  const matrixImports = [{ name: 'binding.txt', values: [0, -1, 0, 5, 1, 0, 0, -3, 0, 0, 1, 1, 0, 0, 0, 1] }];
  const pair = kind === 'extraction'
    ? { map, independent: transferSnapshot(await extractTeachingWorkspace(map, {
      bounds: { min: { x: 9, y: 19, z: 0 }, max: { x: 12, y: 22, z: 2 } },
      localToMap, name: 'local.ply', matrixImports,
    })) }
    : { map: transferSnapshot(await placeTeachingWorkspace(independent, map, { localToMap, matrixImports })), independent };
  pair.independent.config.config.ui.mapRouteSyncEnabled = true;
  pair.map.config.config.ui.showSlice3D = false;
  return pair;
}
