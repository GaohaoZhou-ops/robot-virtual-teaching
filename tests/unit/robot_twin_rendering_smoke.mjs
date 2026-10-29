import assert from 'node:assert/strict';
import { Group, Object3D, Scene } from 'three';
import { applyRobotJointValues, createRobotMeasuredJointUpdater } from "../../src/features/robot/model/robotLoader.js";
import { RobotTwinScene } from "../../src/features/robot-twin/model/robotTwinScene.js";

const model = new Group();
for (let i = 0; i < 20; i++) {
  const joint = new Group(); joint.name = `joint-${i}`;
  joint.userData = { jointType: i === 0 ? 'prismatic' : 'revolute', jointAxis: [0, 0, 1],
    restPosition: [i / 20, 0, 1], restQuaternion: [0, 0, 0, 1], jointValue: 0 };
  model.add(joint);
  // A detailed robot has many visual/collision descendants per joint.
  for (let part = 0; part < 30; part++) joint.add(new Group());
}
const reference = model.clone(true), measured = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`joint-${i}`, i ? 120 - i : .42]));
const updater = createRobotMeasuredJointUpdater(model);
updater.apply(measured); applyRobotJointValues(reference, measured, { measured: true });
for (const joint of updater.joints) {
  const expected = reference.getObjectByName(joint.name);
  assert.ok(joint.position.distanceTo(expected.position) < 1e-10);
  assert.ok(1 - Math.abs(joint.quaternion.dot(expected.quaternion)) < 1e-10);
}
const revision = updater.revision;
assert.equal(updater.apply({ ...measured }), false, 'unchanged joints do no transform work');
assert.equal(updater.revision, revision);

// Minimal labels let the real Three scene run without a browser or GPU.
const originalDocument = globalThis.document;
const element = () => ({ append() {}, remove() {}, addEventListener() {}, setAttribute() {},
  style: { setProperty() {} } });
globalThis.document = { createElement: element };
const scene = new Scene(), layer = new Group(); layer.add(model); scene.add(layer);
const fleet = new RobotTwinScene(scene, element(), () => {});
const robot = (id, time) => ({ id, name: id, phase: 'live', color: id === 'a' ? '#62c7a0' : '#6baff2',
  motionSample: { time, id: time + 1 },
  pose: { position: { x: time / 1000 + (id === 'a' ? 0 : 10), y: 0, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: 0 } },
  joints: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`joint-${i}`, time / 10])) });
try {
  fleet.sync(model, layer, [robot('a', 0), robot('b', 0)], 'a', true);
  fleet.update(0, 'a');
  const robots = [robot('a', 500), robot('b', 500)];
  fleet.sync(model, layer, robots, 'a', true);
  fleet.update(500, 'a');
  let otherUpdates = 0, walks = 0, searches = 0;
  const other = fleet.entries.get('b'), apply = other.joints.apply.bind(other.joints);
  other.joints.apply = (values) => { otherUpdates++; return apply(values); };
  const traverse = Object3D.prototype.traverse, find = Object3D.prototype.getObjectByName;
  Object3D.prototype.traverse = function (...args) { walks++; return traverse.apply(this, args); };
  Object3D.prototype.getObjectByName = function (...args) { searches++; return find.apply(this, args); };
  try {
    for (let now = 516; now <= 900; now += 16) fleet.update(now, 'a');
  } finally { Object3D.prototype.traverse = traverse; Object3D.prototype.getObjectByName = find; }
  assert.equal(walks, 0, 'following never traverses the full model');
  assert.equal(searches, 0, 'joint nodes are indexed once');
  assert.equal(otherUpdates, 0, 'unfollowed robot does no per-frame joint work');
  assert.deepEqual([...fleet.motion.keys()], ['a']);
  assert.ok(layer.position.x > .3 && layer.position.x < .5);
  assert.equal(other.group.position.x, 10.5, 'other robot displays latest telemetry without buffer delay');
  fleet.sync(model, layer, robots, 'b', true); fleet.update(900, 'b');
  assert.deepEqual([...fleet.motion.keys()], ['b']);
  assert.equal(fleet.entries.get('a').group.position.x, .5);
  fleet.update(950);
  assert.equal(fleet.motion.size, 0, 'manual viewing leaves no smoothing buffers');
} finally { fleet.dispose(); globalThis.document = originalDocument; }
console.log('Robot rendering: measured transforms preserved; only followed robot interpolates; zero per-frame model traversals/searches or other-robot joint updates.');
