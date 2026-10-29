import assert from 'node:assert/strict';
import * as THREE from 'three';
import { serializeCollisionHull, collisionHullsSeparated } from "../src/features/robot/model/robotCollisionHull.js";
import { createMobileCollisionChecker } from "../src/features/teaching/mobile/model/mobileTeachingCollision.js";

const cube = new THREE.BoxGeometry(1, 1, 1), hull = serializeCollisionHull(cube);
const transform = (x, y = 0, z = 0) => new THREE.Matrix4().makeTranslation(x, y, z);
assert.ok(hull && hull.vertices.length >= 24);
assert.equal(serializeCollisionHull(cube), hull, 'static robot geometry reuses its hull');
assert.equal(collisionHullsSeparated(hull, hull, transform(1.1)), true);
assert.equal(collisionHullsSeparated(hull, hull, transform(0.9)), false, 'intersecting solids remain blocked');
assert.equal(collisionHullsSeparated(hull, hull, transform(1)), false, 'touching faces remain blocked');
assert.equal(collisionHullsSeparated(hull, hull, new THREE.Matrix4().makeScale(.1, .1, .1)), false,
  'a solid contained entirely in another is still a collision');
assert.equal(collisionHullsSeparated(hull, hull, new THREE.Matrix4().makeScale(-.1, .1, .1)), false);
assert.equal(collisionHullsSeparated(hull, hull, new THREE.Matrix4().makeScale(0, 1, 1)), false);
assert.equal(collisionHullsSeparated(null, hull, transform(10)), false, 'missing geometry cannot certify separation');
const flat = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)]);
assert.equal(serializeCollisionHull(flat), null);
cube.translate(2, 0, 0);
assert.notEqual(serializeCollisionHull(cube), hull, 'updated geometry invalidates the hull cache');

// These two tetrahedra have overlapping boxes but disjoint solids. Moving a
// link must invalidate a previously cached separating-plane certificate.
const tetra = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1),
]);
const robot = new THREE.Group(), layer = new THREE.Group(); layer.add(robot);
for (const [name, shift] of [['body', 0], ['arm', .6]]) {
  const node = new THREE.Object3D(); node.name = name; node.position.set(shift, shift, 2 + shift);
  node.userData.mobileCollision = { linkName: name, chain: name === 'body' ? [] : ['j1', 'j2'],
    center: [.5, .5, .5], halfSize: [.5, .5, .5], hull: serializeCollisionHull(tetra) };
  robot.add(node);
}
const checker = await createMobileCollisionChecker(robot, { positions: new Float32Array([100, 100, 100]), kind: 'points' });
assert.equal(checker.check().clear, true);
assert.equal(checker.check().clear, true, 'fixed relative transforms reuse separation');
robot.getObjectByName('arm').position.set(.1, .1, 2.1);
assert.deepEqual(checker.check().selfPairs, [['arm', 'body']]);
robot.getObjectByName('arm').position.set(.6, .6, 2.6);
assert.equal(checker.check().clear, true);
layer.rotation.set(.3, -.2, .7); layer.scale.set(2, .5, 1.5); layer.position.set(5, -2, 3);
assert.equal(checker.check().clear, true, 'common rotated/scaled parent preserves separation');
cube.dispose(); flat.dispose(); tetra.dispose();
console.log('Collision hulls: separation, intersection, touching, containment, degenerate fallback, geometry and relative-pose cache invalidation passed.');
