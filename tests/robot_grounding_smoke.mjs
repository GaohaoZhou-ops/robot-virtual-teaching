import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ROBOT_GROUND_CLEARANCE, robotGroundLift } from '../src/lib/robotLoader.js';

const layer = new THREE.Group();
const robot = new THREE.Group();
layer.add(robot);
const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.3));
const foot = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1));
const joint = new THREE.Group();
joint.position.z = -0.45;
joint.add(foot);
robot.add(body, joint);
const collision = new THREE.Mesh(new THREE.BoxGeometry(8, 8, 8));
collision.userData.robotCollisionGeometry = true;
collision.visible = false;
robot.add(collision);

const lowestVisualVertex = () => {
  layer.updateMatrixWorld(true);
  const point = new THREE.Vector3();
  let bottom = Infinity;
  for (const mesh of [body, foot]) {
    const positions = mesh.geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i += 1) {
      point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      bottom = Math.min(bottom, point.z);
    }
  }
  return bottom;
};
const localVertices = body.geometry.getAttribute('position').array.slice();
layer.position.set(4, -2, 0);
layer.rotation.z = 0.7;
assert(Math.abs(robotGroundLift(robot) - 0.501) < 1e-7, 'Use restored joints, exclude collision shapes');
assert.equal(layer.position.z, 0, 'Measuring clearance must not change the pose');
layer.position.z += robotGroundLift(robot);
assert(Math.abs(lowestVisualVertex() - ROBOT_GROUND_CLEARANCE) < 1e-8);
assert.equal(robotGroundLift(robot), 0, 'Repeated loads must not accumulate height');
layer.position.z += 1.25;
assert.equal(robotGroundLift(robot), 0, 'Preserve a manually raised robot');

layer.position.z = -0.4;
layer.rotation.set(0.3, -0.45, 1.2);
const before = lowestVisualVertex();
const lift = robotGroundLift(robot);
assert(lift > 0);
layer.position.z += lift;
assert(lowestVisualVertex() >= ROBOT_GROUND_CLEARANCE - 1e-8);
assert(Math.abs(lowestVisualVertex() - before - lift) < 1e-8);
assert.deepEqual(robot.position.toArray(), [0, 0, 0]);
assert.equal(joint.position.z, -0.45);
assert.deepEqual(body.geometry.getAttribute('position').array, localVertices);
assert.equal(robotGroundLift(new THREE.Group()), 0);
for (const mesh of [body, foot, collision]) {
  mesh.geometry.dispose();
  mesh.material.dispose();
}
console.log('PASS: robot ground clearance, restored joints/rotation, collision exclusion and no height drift');
