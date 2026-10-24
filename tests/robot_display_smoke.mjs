import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyRobotModelOpacity } from '../src/lib/robotDisplay.js';
import { applyRobotCollisionHighlights, collectRobotCollisionProxies, disposeRobotCollisionProxies } from '../src/lib/robotCollision.js';
import { serializeMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';

const robot = new THREE.Group();
const link = new THREE.Group(); link.name = 'left_L3'; link.userData.urdfType = 'link'; robot.add(link);
const solid = new THREE.MeshStandardMaterial({ color: '#768a90' });
const glass = new THREE.MeshStandardMaterial({ opacity: 0.4, transparent: true, depthWrite: false });
const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), [solid, glass]); link.add(mesh);
const invisible = new THREE.MeshBasicMaterial({ opacity: 0, transparent: true, colorWrite: false, depthWrite: false });
const helper = new THREE.Mesh(mesh.geometry, invisible); link.add(helper);
const snapshot = () => serializeMobileTeachingRobot(robot, { includeCollision: true, includeCollisionHulls: true });
const originalSnapshot = snapshot();
const originalColor = solid.color.getHex();

for (const opacity of [0.35, 0.7, 0, 0.01, 1]) {
  applyRobotModelOpacity(robot, opacity);
  assert.equal(solid.opacity, opacity);
  assert.equal(glass.opacity, 0.4 * opacity, 'preserve source glass alpha without cumulative scaling');
  assert.equal(solid.transparent, opacity < 1);
  assert.equal(solid.depthWrite, opacity === 1);
  assert.equal(glass.transparent, true);
  assert.equal(glass.depthWrite, false);
  assert.equal(invisible.opacity, 0, 'interaction helpers must remain invisible');
  assert.equal(solid.color.getHex(), originalColor);
  assert.deepEqual(snapshot(), originalSnapshot, 'opacity, including zero, must not remove fallback collision geometry');
}

applyRobotModelOpacity(robot, 0.35);
const collection = collectRobotCollisionProxies(robot);
assert.equal(collection.visualFallbackProxyCount, 1);
applyRobotCollisionHighlights(collection, { collisionLinks: ['left_L3'] });
assert.equal(mesh.material[0].opacity, 0.35, 'warning materials inherit the selected opacity');
applyRobotModelOpacity(robot, 0);
applyRobotCollisionHighlights(collection, { nearLinks: ['left_L3'] });
assert.equal(mesh.material[0].opacity, 0);
assert.deepEqual(snapshot(), originalSnapshot);
applyRobotCollisionHighlights(collection, {});
assert.equal(mesh.material[0], solid);
assert.equal(solid.opacity, 0, 'restoring a safe material uses the latest slider value');
applyRobotCollisionHighlights(collection, { collisionLinks: ['left_L3'] });
applyRobotModelOpacity(robot, 1);
disposeRobotCollisionProxies(collection);
assert.equal(mesh.material[0], solid);
assert.equal(solid.opacity, 1);
assert.equal(solid.transparent, false);
assert.equal(solid.depthWrite, true);
assert.equal(glass.opacity, 0.4);
mesh.geometry.dispose(); [solid, glass, invisible].forEach((material) => material.dispose());
console.log('Robot display: opacity/restoration, material arrays, original alpha, invisible helpers, collision highlight transitions and unchanged worker collision snapshots passed.');
