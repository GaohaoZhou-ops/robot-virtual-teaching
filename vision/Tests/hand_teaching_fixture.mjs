import { readFile, writeFile } from 'node:fs/promises';
import { Euler, Quaternion } from 'three';
import { buildProjectArchive } from '../../src/features/workspace/model/projectArchive.js';
import { teachingTransferFixture } from '../../tests/teaching_transfer_helpers.mjs';

// Tiny procedural visuals with the existing BOTX kinematics: tests never read
// the user's robot folders, maps, browser state or networked robots.
const source = JSON.parse(await readFile(new URL('../../tests/fixtures/mobile-teaching-botx.json', import.meta.url), 'utf8'));
const parts = ['<robot name="Vision 双臂验证机器人">'];
const linkName = node => node.userData.urdfType === 'joint' ? `${node.name}_test_link` : node.name;
function visit(node, parent = null) {
  const link = linkName(node), data = node.userData;
  const visual = node.name === 'base_link' || /^(left|right)_J[1-7]$/.test(node.name)
    ? '<visual><geometry><box size="0.025 0.025 0.025"/></geometry></visual>' : '';
  parts.push(`<link name="${link}">${visual}</link>`);
  if (parent) {
    const euler = new Euler().setFromQuaternion(new Quaternion().fromArray(data.restQuaternion || node.quaternion), 'ZYX');
    const type = data.jointType || 'fixed', name = data.jointType ? node.name : `${node.name}_test_mount`;
    parts.push(`<joint name="${name}" type="${type}"><parent link="${parent}"/><child link="${link}"/>
      <origin xyz="${(data.restPosition || node.position).join(' ')}" rpy="${[euler.x, euler.y, euler.z].join(' ')}"/>
      <axis xyz="${(data.jointAxis || [0, 0, 1]).join(' ')}"/>
      <limit lower="${data.jointLimit?.lower ?? -3.14}" upper="${data.jointLimit?.upper ?? 3.14}" effort="100" velocity="2"/></joint>`);
  }
  for (const child of node.children) visit(child, link);
}
visit(source.robot); parts.push('</robot>');
const fixture = teachingTransferFixture('map');
// Keep the UI fixture around the immersive origin. The transfer fixture's
// disconnected triangles tens of metres away are useful for archive tests,
// but put the robot outside the initial view and provide no usable nearby floor.
Object.assign(fixture.map, {
  positionBuffer: new Float32Array([-3,-3,0, 3,-3,0, 3,3,0, -3,3,0]).buffer,
  colorBuffer: new Uint8Array([90,110,120, 90,110,120, 90,110,120, 90,110,120]).buffer,
  indexBuffer: new Uint16Array([0,1,2, 0,2,3]).buffer,
  pointCount: 4, faceCount: 2,
  bounds: { min: { x: -3, y: -3, z: 0 }, max: { x: 3, y: 3, z: 0 } },
});
const robot = { id: 'vision-hands/robot.urdf', relativePath: 'vision-hands/robot.urdf', name: 'Vision 双臂验证机器人',
  fileName: 'robot.urdf', format: 'urdf', packageName: 'vision-hands', packagePath: 'vision-hands',
  origin: { position: { x: 0.4, y: -0.3, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: 20 } },
  joints: Object.fromEntries(['left', 'right'].flatMap(side => [-20, -30, 15, 45, -12, 5, 8].map((v, i) => [`${side}_J${i + 1}`, side === 'left' ? v : -v]))),
};
const project = fixture.config.config.project;
project.robot = robot;
Object.assign(project.map, { bounds: fixture.map.bounds, pointCount: 4, faceCount: 2 });
project.waypoints = []; project.paths = [];
project.virtualTeaching.tasks.forEach(task => {
  task.robot = robot;
  task.parkingPoints.forEach((parking, index) => {
    parking.mapPose = { frameId: 'map', ...structuredClone(robot.origin),
      position: { ...robot.origin.position, x: robot.origin.position.x + index } };
    parking.poses.forEach(pose => {
      pose.mapPose = structuredClone(parking.mapPose);
      pose.fullBodyJoints = { values: { ...robot.joints } };
      pose.opticalTargets = {};
      delete pose.cameraCapture; delete pose.replanningHistory;
    });
    delete parking.mergeHistory;
  });
});
fixture.map.portableRobotPackage = { ...robot, files: [{ path: robot.relativePath, mimeType: 'application/xml', bytes: new TextEncoder().encode(parts.join('\n')) }] };
const archive = await buildProjectArchive(project, { mapResource: fixture.map, existingRobotPackage: fixture.map.portableRobotPackage });
await writeFile(process.argv[2], archive.bytes);
