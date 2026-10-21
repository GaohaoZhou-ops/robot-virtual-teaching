import { teachingTransferFixture, transferSnapshot } from './teaching_transfer_helpers.mjs';
import { placeTeachingWorkspace } from '../src/lib/teachingTransfer.js';
import { createRobotJointPreset } from '../src/lib/robotJointPresets.js';

export async function projectCollectionFixture() {
  const fixture = (mode, group) => {
    const snapshot = teachingTransferFixture(mode);
    const project = snapshot.config.config.project;
    if (group) {
      snapshot.map.mapId = `fixture-group-${group}`;
      snapshot.map.teachingGroupId = `group-${group}`;
      snapshot.map.name = 'same-model.ply';
      snapshot.config.mapId = snapshot.map.mapId;
      Object.assign(project.map, { teachingGroupId: snapshot.map.teachingGroupId, fileName: snapshot.map.name });
      project.virtualTeaching.tasks[0].name = `独立组 ${group}`;
    }
    for (const task of project.virtualTeaching.tasks) {
      for (const point of task.parkingPoints) {
        point.poses.forEach((pose) => { pose.cameraCapture.frames.left.rgb.byteLength = 5; });
      }
    }
    project.virtualTeaching.jointPoses.push(createRobotJointPreset({
      id: `preset-${group || mode}`, name: `预设 ${group || mode}`, robot: project.robot,
      joints: [{ name: 'shoulder', type: 'revolute', lower: -180, upper: 180 }], values: { shoulder: 23 },
    }));
    // The receiver has no copy of this URDF or its external mesh.
    snapshot.map.portableRobotPackage.files = [
      { path: 'transfer/robot.urdf', bytes: new TextEncoder().encode(`<robot name="portable_mesh_robot">
        <link name="base_link"><visual><geometry><mesh filename="meshes/body.stl"/></geometry></visual></link>
        <link name="arm"/><joint name="shoulder" type="revolute"><parent link="base_link"/><child link="arm"/>
        <axis xyz="0 0 1"/><limit lower="-3.14" upper="3.14" effort="1" velocity="1"/></joint>
        <link name="lift_link"/><joint name="lift" type="prismatic"><parent link="arm"/><child link="lift_link"/>
        <axis xyz="0 0 1"/><limit lower="0" upper="1" effort="1" velocity="1"/></joint></robot>`) },
      { path: 'transfer/meshes/body.stl', bytes: new TextEncoder().encode(`solid body
        facet normal 0 0 1
        outer loop
        vertex 0 0 0
        vertex 0.5 0 0
        vertex 0 0.3 0
        endloop
        endfacet
        endsolid body`) },
    ];
    return snapshot;
  };
  let map = fixture('map');
  const a = fixture('independent', 'A');
  const b = fixture('independent', 'B');
  const c = fixture('independent', 'C'); // Same geometry/name, but not yet placed.
  for (const [index, source] of [a, b].entries()) {
    const x = 5 + index * 9;
    map = transferSnapshot(await placeTeachingWorkspace(source, map, {
      localToMap: { position: { x, y: -3, z: 1 }, rpy: { roll: 0, pitch: 0, yaw: 0 } },
      matrixImports: [{ name: `group-${index}.txt`, values: [1, 0, 0, x, 0, 1, 0, -3, 0, 0, 1, 1, 0, 0, 0, 1] }],
    }));
  }
  map.config.config.ui.showSlice3D = false;
  a.config.config.ui.mapRouteSyncEnabled = true;
  return {
    activeMode: 'map', workspaces: { map, independent: c },
    independentHistory: [{ ...b, archivedAt: 1800000002000 }, { ...a, archivedAt: 1800000001000 }],
  };
}

export const projectCollectionOptions = (collection, mode) => ({
  mapResource: collection.workspaces[mode].map,
  existingRobotPackage: collection.workspaces[mode].map.portableRobotPackage,
  workspaceUI: collection.workspaces[mode].config.config.ui,
  companionWorkspace: collection.workspaces[mode === 'map' ? 'independent' : 'map'],
  independentHistory: collection.independentHistory,
});
