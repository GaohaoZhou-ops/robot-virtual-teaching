import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  applyRobotCollisionHighlights,
  collectRobotCollisionProxies,
  disposeRobotCollisionProxies,
  getRobotCollisionJointOptions,
  serializeRobotCollisionProxies,
} from '../src/lib/robotCollision.js';
import { resolveRobotCollisionBackend } from '../src/lib/robotCollisionBackend.js';
import { setRobotVisualBounds } from '../src/lib/robotLoader.js';

const material = () => new THREE.MeshBasicMaterial({ color: '#78909c' });

const createLink = (name, { collision = true } = {}) => {
  const link = new THREE.Group();
  link.name = name;
  link.userData.urdfType = 'link';
  const visualGroup = new THREE.Group();
  visualGroup.userData.urdfType = 'visual';
  const visual = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material());
  visualGroup.add(visual);
  link.add(visualGroup);
  if (collision) {
    const collisionGroup = new THREE.Group();
    collisionGroup.userData.urdfType = 'collision';
    collisionGroup.visible = false;
    collisionGroup.position.z = 10;
    const collider = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.6, 0.8), material());
    collider.userData.robotCollisionGeometry = true;
    collisionGroup.add(collider);
    link.add(collisionGroup);
  }
  return { link, visual };
};

const robot = new THREE.Group();
robot.name = 'test-robot';
const arm = createLink('arm_link');
const tool = createLink('tool_link', { collision: false });
const base = createLink('base_link');
tool.link.position.set(1, 0, 0);
robot.add(arm.link, tool.link, base.link);
robot.updateMatrixWorld(true);

const collection = collectRobotCollisionProxies(robot);
assert.deepEqual(collection.excludedLinks, ['base_link']);
assert.equal(collection.collisionModelProxyCount, 1);
assert.equal(collection.visualFallbackProxyCount, 1);
assert.equal(collection.proxies.length, 2);
assert.equal(
  collection.proxies.find((proxy) => proxy.linkName === 'arm_link').source,
  'urdf-collision',
);
assert.equal(
  collection.proxies.find((proxy) => proxy.linkName === 'tool_link').source,
  'visual-fallback',
);

const serialized = serializeRobotCollisionProxies(collection);
const armProxy = serialized.records.find((proxy) => proxy.linkName === 'arm_link');
assert.deepEqual(armProxy.halfSize.map((value) => Number(value.toFixed(3))), [0.2, 0.3, 0.4]);
assert.equal(armProxy.source, 'urdf-collision');

const armMaterial = arm.visual.material;
applyRobotCollisionHighlights(collection, { collisionLinks: ['arm_link'] });
assert.notEqual(arm.visual.material, armMaterial);
assert.equal(collection.proxies[0].mesh.visible, true);
applyRobotCollisionHighlights(collection, {});
assert.equal(arm.visual.material, armMaterial);
disposeRobotCollisionProxies(collection);

const visualBounds = setRobotVisualBounds(new THREE.Box3(), robot);
assert.deepEqual(
  visualBounds.getSize(new THREE.Vector3()).toArray().map((value) => Number(value.toFixed(3))),
  [3, 2, 2],
);

// Ignoring a joint removes only its child link from both collision and distance
// queries. Downstream joints and the other arm remain independently monitored.
const articulated = new THREE.Group();
const left = createLink('left_L1');
const elbow = createLink('left_L2', { collision: false });
const right = createLink('right_L1');
const wheel = createLink('wheel_left');
const joint = (name, child, type = 'fixed') => {
  const node = new THREE.Group();
  node.name = name;
  node.userData = { urdfType: 'joint', jointType: type };
  node.add(child);
  return node;
};
left.link.add(joint('left_elbow', elbow.link, 'revolute'));
articulated.add(joint('left_shoulder', left.link, 'revolute'),
  joint('right_mount', right.link), joint('wheel_joint', wheel.link));
assert.deepEqual(getRobotCollisionJointOptions(articulated).map((option) => option.name),
  ['left_elbow', 'left_shoulder', 'right_mount']);
const initial = collectRobotCollisionProxies(articulated);
const leftMaterial = left.visual.material;
applyRobotCollisionHighlights(initial, { collisionLinks: ['left_L1'], nearLinks: ['right_L1'] });
disposeRobotCollisionProxies(initial);
assert.equal(left.visual.material, leftMaterial);
const ignored = collectRobotCollisionProxies(articulated, ['left_shoulder', 'left_shoulder', 'unknown']);
assert.deepEqual(ignored.ignoredLinks, ['left_L1']);
assert.deepEqual(ignored.excludedLinks, ['left_L1', 'wheel_left']);
assert.deepEqual(ignored.monitoredLinks, ['left_L2', 'right_L1']);
assert.deepEqual(serializeRobotCollisionProxies(ignored).records.map((record) => record.linkName).sort(),
  ['left_L2', 'right_L1']);
applyRobotCollisionHighlights(ignored, { collisionLinks: ['left_L1'], nearLinks: ['right_L1'] });
assert.equal(left.visual.material, leftMaterial);
disposeRobotCollisionProxies(ignored);
const allIgnored = collectRobotCollisionProxies(articulated, ['left_shoulder', 'left_elbow', 'right_mount']);
assert.equal(allIgnored.proxies.length, 0);
assert.equal(allIgnored.highlightEntries.length, 0);
disposeRobotCollisionProxies(allIgnored);
const restored = collectRobotCollisionProxies(articulated);
assert.equal(restored.proxies.length, 3);
disposeRobotCollisionProxies(restored);

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({
    apiVersion: 1,
    requestedBackend: 'auto',
    activeBackend: 'local',
    localAvailable: true,
    isaac: { available: false, error: 'offline' },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const fallback = await resolveRobotCollisionBackend();
  assert.equal(fallback.activeBackend, 'local');
  assert.equal(fallback.requestedBackend, 'auto');

  globalThis.fetch = async () => new Response(JSON.stringify({
    apiVersion: 1,
    requestedBackend: 'isaac',
    activeBackend: 'unavailable',
    localAvailable: true,
    isaac: { available: false, error: 'PhysX offline' },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(resolveRobotCollisionBackend(), /PhysX offline/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('URDF collision preference, joint exclusions, visual fallback/highlight, and backend policy passed.');
