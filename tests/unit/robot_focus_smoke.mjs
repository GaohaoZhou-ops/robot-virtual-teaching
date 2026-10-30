import assert from 'node:assert/strict';
import * as THREE from 'three';
import { robotFocusView } from '../../src/features/viewport/model/robotFocus.js';
import { setRobotVisualBounds } from '../../src/features/robot/model/robotLoader.js';
import { VIEWPORT_FOV } from '../../src/features/viewport/model/viewportNavigation.js';

const layer = new THREE.Group();
const robot = new THREE.Group();
layer.add(robot);
const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.6, 1.6));
body.position.z = 0.8;
robot.add(body);
const arm = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.2, 0.2));
arm.position.set(0.8, 0, 1.4);
arm.rotation.z = 0.7;
robot.add(arm);
const collision = new THREE.Mesh(new THREE.BoxGeometry(200, 200, 200));
collision.userData.urdfType = 'collision';
robot.add(collision);

for (const offset of [new THREE.Vector3(), new THREE.Vector3(1842, -576, 32)]) {
  layer.position.copy(offset);
  layer.rotation.set(0.1, -0.2, 1.1);
  const before = { body: body.position.toArray(), arm: arm.position.toArray() };
  const bounds = setRobotVisualBounds(new THREE.Box3(), robot);
  assert(bounds.getSize(new THREE.Vector3()).length() < 5, 'collision helpers must not inflate framing');
  for (const aspect of [0.28, 0.65, 1, 1.8, 3.2]) {
    for (const bottomFraction of [0, 0.18, 0.4]) {
      const camera = new THREE.PerspectiveCamera(VIEWPORT_FOV, aspect, 0.001, 100000);
      camera.up.set(0, 0, 1);
      const oldTarget = offset.clone().add(new THREE.Vector3(-100, 40, -3));
      camera.position.copy(oldTarget).add(new THREE.Vector3(-25, -40, 17));
      camera.zoom = 1e8;
      camera.lookAt(oldTarget);
      const oldDirection = camera.position.clone().sub(oldTarget).normalize();
      const originalPosition = camera.position.clone();
      const view = robotFocusView(camera, oldTarget, bounds, { bottomFraction });
      assert(camera.position.equals(originalPosition), 'computing the framing must not mutate the camera');
      assert(view.position.clone().sub(view.target).normalize().distanceTo(oldDirection) < 1e-10);
      camera.position.copy(view.position);
      camera.zoom = 1;
      camera.lookAt(view.target);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      // Check the actual visual vertices after the robot's local/world transforms,
      // across landscape/portrait windows and a visible playback dock.
      for (const mesh of [body, arm]) {
        const vertices = mesh.geometry.attributes.position;
        for (let index = 0; index < vertices.count; index++) {
          const projected = new THREE.Vector3().fromBufferAttribute(vertices, index)
            .applyMatrix4(mesh.matrixWorld).project(camera);
          assert(Math.abs(projected.x) < 1, `robot clipped horizontally at aspect ${aspect}`);
          assert(projected.y < 1 && projected.y > -1 + bottomFraction * 2, 'robot overlaps screen edge or dock');
          assert(projected.z > -1 && projected.z < 1, 'robot outside clipping range');
        }
      }
    }
  }
  assert.deepEqual(body.position.toArray(), before.body);
  assert.deepEqual(arm.position.toArray(), before.arm);
  assert(layer.position.equals(offset), 'finding the robot never relocates its base');
}

const camera = new THREE.PerspectiveCamera(VIEWPORT_FOV, 1, 0.01, 100);
camera.up.set(0, 0, 1);
const bounds = new THREE.Box3(new THREE.Vector3(-1, -1, 0), new THREE.Vector3(1, 1, 2));
const fallback = robotFocusView(camera, camera.position, bounds);
assert(fallback.position.toArray().every(Number.isFinite));
assert(fallback.distance > 0);
assert.equal(robotFocusView(camera, camera.position, new THREE.Box3()), null);
assert.equal(robotFocusView(camera, camera.position, new THREE.Box3(new THREE.Vector3(), new THREE.Vector3())), null);
assert.equal(robotFocusView(camera, camera.position, new THREE.Box3(new THREE.Vector3(-Infinity, 0, 0), new THREE.Vector3(1, 1, 1))), null);
for (const mesh of [body, arm, collision]) { mesh.geometry.dispose(); mesh.material.dispose(); }
console.log('PASS: robot framing preserves direction and pose, fits articulated world geometry in narrow/wide views, and clears the playback dock.');
