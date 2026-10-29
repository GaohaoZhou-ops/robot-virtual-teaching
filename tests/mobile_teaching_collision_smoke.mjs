import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createMobileCollisionChecker } from "../src/features/teaching/mobile/model/mobileTeachingCollision.js";
import { restoreMobileTeachingRobot, serializeMobileTeachingRobot } from "../src/features/teaching/mobile/model/mobileTeachingKinematics.js";
import { collectRobotCollisionProxies } from "../src/features/robot/model/robotCollision.js";

const robot = new THREE.Group(), layer = new THREE.Group(); layer.add(robot);
function box(name, position, chain, halfSize = [0.1, 0.1, 0.1]) {
  const node = new THREE.Object3D(); node.name = name; node.position.fromArray(position);
  node.userData.mobileCollision = { linkName: name, chain, center: [0, 0, 0], halfSize };
  robot.add(node); return node;
}
const body = box('base_link', [0, 0, 0.5], []);
const arm = box('left_L7', [1, 0, 0.5], ['shoulder', 'elbow', 'wrist']);
const far = { positions: new Float32Array([100, 100, 100]), kind: 'points' };
const checker = await createMobileCollisionChecker(robot, far);
assert.equal(checker.check().clear, true);
arm.position.x = 0.05;
assert.deepEqual(checker.check().selfPairs, [['left_L7', 'base_link']]);
arm.position.set(1, 0, -0.2);
assert.deepEqual(checker.check().groundLinks, ['left_L7']);
arm.position.set(1, 0, 0.5);

// A large triangle cuts through a chassis box while every vertex is far away.
// Sparse vertex/centroid sampling would miss this collision.
const triangle = { positions: new Float32Array([0, -10, -10, 0, 10, -10, 0, 0, 10]), indices: new Uint32Array([0, 1, 2]), kind: 'mesh' };
const wall = await createMobileCollisionChecker(robot, triangle);
assert.deepEqual(wall.check().environmentLinks, ['base_link']);
const floor = { positions: new Float32Array([-10, -10, 0, 10, -10, 0, 0, 10, 0]), kind: 'mesh' };
assert.equal((await createMobileCollisionChecker(robot, floor)).check().clear, true, 'support-plane contact is allowed');
const enclosing = new THREE.BoxGeometry(20, 20, 20);
assert.deepEqual((await createMobileCollisionChecker(robot, { positions: enclosing.attributes.position.array,
  indices: enclosing.index.array, kind: 'mesh' })).check().environmentLinks.sort(), ['base_link', 'left_L7'],
  'a robot fully inside a closed obstacle is not clear merely because no surface crosses its boxes');
enclosing.dispose();
layer.position.set(5, 3, 0); layer.rotation.z = 0.7;
assert.equal(wall.check().clear, true, 'world transforms apply to every detection box');
layer.position.set(0, 0, 0); layer.rotation.z = 0;
const point = await createMobileCollisionChecker(robot, { positions: new Float32Array([1, 0, 0.5]), kind: 'points' });
assert.deepEqual(point.check().environmentLinks, ['left_L7']);
const adjacent = box('left_L6', [1, 0, 0.5], ['shoulder', 'elbow']);
assert.equal((await createMobileCollisionChecker(robot, far)).check().clear, true, 'adjacent linked geometry is not a self collision');
robot.remove(adjacent);
const forearm = box('forearm', [1, 0, 0.5], ['shoulder']);
forearm.userData.mobileCollision.jointLink = true;
Object.assign(arm.userData.mobileCollision, { jointSpacing: [null, 0.3, 0], jointLink: true });
assert.equal((await createMobileCollisionChecker(robot, far)).check().clear, true, 'coincident wrist axes share their joint housing');
arm.userData.mobileCollision.jointLink = false;
assert.ok((await createMobileCollisionChecker(robot, far)).check().selfPairs.some((pair) => pair.includes('forearm')),
  'camera/tool attachments do not inherit a joint-housing exemption');
robot.remove(forearm);
const offset = box('offset-arm', [0, 0, 0], ['other-shoulder', 'other-elbow', 'other-wrist']);
offset.userData.mobileCollision.center = [2, 0, 0.5]; offset.rotation.z = Math.PI / 2;
arm.position.set(0, 2, 0.5);
assert.ok((await createMobileCollisionChecker(robot, far)).check().selfPairs.some((pair) => pair.includes('offset-arm')),
  'off-centre collision geometry rotates around its link origin');
arm.position.set(2, 0, 0.5);
assert.equal((await createMobileCollisionChecker(robot, far)).check().selfPairs.length, 0);
robot.remove(offset); arm.position.set(1, 0, 0.5);
await assert.rejects(() => createMobileCollisionChecker(robot), /缺少当前工件/);
await assert.rejects(() => createMobileCollisionChecker(new THREE.Group(), far), /缺少碰撞检测体/);
let checkpoints = 0;
await assert.rejects(() => createMobileCollisionChecker(robot, far, async () => { checkpoints += 1; throw new DOMException('cancel', 'AbortError'); }), { name: 'AbortError' });
assert.equal(checkpoints, 1);

// Preserve chassis proxies in a worker snapshot without mesh buffers or any
// material changes; interactive collision monitoring keeps its existing scope.
const live = new THREE.Group(), base = new THREE.Group(); base.name = 'base_link'; base.userData.urdfType = 'link'; live.add(base);
const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.3), new THREE.MeshBasicMaterial()); mesh.position.z = 0.2; base.add(mesh);
const originalMaterial = mesh.material;
assert.equal(collectRobotCollisionProxies(live, [], { highlights: false }).proxies.length, 0);
const snapshot = serializeMobileTeachingRobot(live, { includeCollision: true });
const restored = restoreMobileTeachingRobot(structuredClone(snapshot)); const restoredLayer = new THREE.Group(); restoredLayer.add(restored);
assert.equal(mesh.material, originalMaterial);
assert.equal((await createMobileCollisionChecker(restored, triangle)).check().clear, false);
restored.traverse((node) => assert.equal(node.geometry, undefined));
mesh.geometry.dispose(); mesh.material.dispose();
console.log('Mobile collision: full triangle/point checks, chassis, self collision, adjacency, support plane, transforms, snapshots and fail-closed initialization passed.');
