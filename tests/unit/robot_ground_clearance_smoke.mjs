import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRobotChassisClearance, isRobotChassisAirborne, robotChassisGroundedPose } from '../../src/features/robot/model/robotGroundClearance.js';
import { ROBOT_GROUND_CLEARANCE } from '../../src/features/robot/model/robotLoader.js';

const layer = new THREE.Group(), robot = new THREE.Group();
layer.add(robot);
const link = (name, parent) => {
  const node = new THREE.Group(); node.name = name; node.userData.urdfType = 'link'; parent.add(node); return node;
};
const visual = (parent, geometry) => {
  const group = new THREE.Group(); group.userData.urdfType = 'visual'; parent.add(group);
  const mesh = new THREE.Mesh(geometry); group.add(mesh); return mesh;
};
const base = link('base_link', robot);
const body = visual(base, new THREE.BoxGeometry(.4, .3, .1)); body.position.z = .12;
const wheel = visual(link('wheel_LF_L', base), new THREE.CylinderGeometry(.08, .08, .04, 32));
wheel.position.set(.15, .12, .08);
const arm = visual(link('left_L1', base), new THREE.BoxGeometry(.1, .1, 2));
arm.position.z = -2;
const collision = new THREE.Group(); collision.userData.urdfType = 'collision'; base.add(collision);
collision.add(new THREE.Mesh(new THREE.BoxGeometry(100, 100, 100)));
const helper = new THREE.Mesh(new THREE.BoxGeometry(100, 100, 100), new THREE.MeshBasicMaterial({ colorWrite: false }));
base.add(helper);
const read = createRobotChassisClearance(robot);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const bottom = () => {
  let result = Infinity;
  const point = new THREE.Vector3();
  for (const mesh of [body, wheel]) {
    mesh.updateWorldMatrix(true, false);
    const p = mesh.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) result = Math.min(result, point.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld).z);
  }
  return result;
};
near(read(), bottom());
assert.equal(isRobotChassisAirborne(read()), false, 'grounded wheels keep an elevated chassis body from warning');
for (const height of [.0499, .05, .0501, .2, .03, -.1]) {
  layer.position.z += height - read();
  near(read(), height);
  assert.equal(isRobotChassisAirborne(read()), height > .05, `threshold at ${height} m`);
}
// Read against transformed vertices; tilted round wheels cannot use the empty
// corners of a transformed bounding box as the ground contact point.
layer.position.set(4, -2, .8); layer.rotation.set(.31, -.43, 1.2);
near(read(), bottom());
layer.position.set(-8, 6, .37); layer.rotation.z = -.5;
near(read(), bottom());
arm.position.z = -100;
near(read(), bottom());
// Landing lowers only world Z using the current, tilted support geometry.
const pose = { position: { x: layer.position.x, y: layer.position.y, z: layer.position.z },
  rpy: { roll: 31, pitch: -43, yaw: 120 } };
const original = structuredClone(pose), height = read();
const grounded = robotChassisGroundedPose(pose, height);
assert.deepEqual(pose, original, 'landing must not mutate the saved pose');
assert.equal(grounded.position.x, pose.position.x);
assert.equal(grounded.position.y, pose.position.y);
assert.deepEqual(grounded.rpy, pose.rpy);
layer.position.z = grounded.position.z;
near(read(), ROBOT_GROUND_CLEARANCE);
assert.equal(robotChassisGroundedPose(grounded, read()), null, 'repeated clicks must not drift');
assert.equal(robotChassisGroundedPose(pose, null), null);
assert.equal(robotChassisGroundedPose(pose, NaN), null);
assert.equal(robotChassisGroundedPose(pose, -.1), null);
const originalTraverse = robot.traverse;
robot.traverse = () => { throw new Error('Do not walk the full robot after indexing'); };
near(read(), bottom());
robot.traverse = originalTraverse;
// Geometry edits invalidate the cached support height as well as pose edits.
const positions = wheel.geometry.getAttribute('position');
positions.setZ(0, -3); positions.needsUpdate = true;
near(read(), bottom());
const plain = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
plain.position.z = .55;
near(createRobotChassisClearance(plain)(), .05);
assert.equal(createRobotChassisClearance(new THREE.Group())(), null);
assert.equal(createRobotChassisClearance(null)(), null);
assert.equal(isRobotChassisAirborne(null), false);
assert.equal(isRobotChassisAirborne(NaN), false);
const resources = new Set();
for (const root of [robot, plain]) root.traverse((node) => {
  if (node.geometry) resources.add(node.geometry);
  if (node.material) resources.add(node.material);
});
for (const resource of resources) resource.dispose();
console.log('PASS: chassis/wheel clearance, 5 cm threshold, rotated geometry, moving arms, helper exclusion and cached readings');
