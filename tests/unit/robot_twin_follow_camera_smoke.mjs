import assert from 'node:assert/strict';
import { BoxGeometry, Group, Mesh, Vector3 } from 'three';
import { createRobotTwinFollowCamera, renderRobotTwinFollowView, normalizeRobotTwinBevAngles } from '../../src/features/robot-twin/model/robotTwinFollowCamera.js';

const near = (actual, expected) => assert.ok(actual.distanceTo(new Vector3(...expected)) < 1e-9,
  `${actual.toArray()} != ${expected}`);
const pose = { position: { x: 2, y: -3, z: 0.2 }, rpy: { roll: 0, pitch: 0, yaw: 0 } };
const layer = new Group(), robot = new Group(), torso = new Group(), mount = new Group();
layer.add(robot); robot.add(torso); torso.add(mount);
layer.position.set(2, -3, 0.2); torso.position.z = 1.2;
mount.name = 'camera_waist_L'; mount.position.set(0.1, 0, 0.2);
const camera = createRobotTwinFollowCamera(pose, 1.8, { mode: 'chest', robot });
near(camera.position, [2.15, -3, 1.6]);
near(camera.target, [5.15, -3, 1.6]);
near(camera.up, [0, 0, 1]);

// A turning torso changes the camera even when chassis telemetry is unchanged.
torso.rotation.z = Math.PI / 2;
camera.update(pose);
near(camera.position, [2, -2.85, 1.6]);
near(camera.target, [2, 0.15, 1.6]);

// Read freshly changed parent transforms without needing a previous render.
layer.position.set(-4, 5, 0.3); layer.rotation.z = Math.PI / 2;
camera.update(pose);
near(camera.position, [-4.15, 5, 1.7]);
near(camera.target, [-7.15, 5, 1.7]);

// Chest pitch and roll must rotate the optical direction and image up together.
layer.rotation.z = 0; torso.rotation.set(0, Math.PI / 2, 0);
camera.update(pose);
near(camera.position, [-3.8, 5, 1.35]);
near(camera.target, [-3.8, 5, -1.65]);
near(camera.up, [1, 0, 0]);
torso.rotation.set(Math.PI / 2, 0, 0);
camera.update(pose);
near(camera.position, [-3.85, 4.8, 1.5]);
near(camera.target, [-0.85, 4.8, 1.5]);
near(camera.up, [0, -1, 0]);
near(mount.position, [0.1, 0, 0.2]);

// Direct mesh / third-party models have a useful body-relative fallback.
const fallback = createRobotTwinFollowCamera(pose, 2, { mode: 'chest' });
near(fallback.position, [2.4, -3, 1.64]);
const next = { position: { x: -1, y: 4, z: 0 }, rpy: { yaw: 90 } };
fallback.update(next);
near(fallback.position, [-1, 4.4, 1.44]);
near(fallback.target, [-1, 7.4, 1.44]);
const held = fallback.position.clone();
fallback.update({ position: { x: NaN }, rpy: {} });
assert.ok(fallback.position.equals(held));
assert.equal(pose.position.x, 2, 'following never changes telemetry');

const bev = createRobotTwinFollowCamera(pose, 1.8, { mode: 'bev', robot });
const original = createRobotTwinFollowCamera(pose, 1.8);
assert.ok(bev.position.equals(original.position) && bev.target.equals(original.target), 'BEV retains the original framing');
near(bev.up, [0, 0, 1]);

const originalDistance = original.position.distanceTo(original.target);
const previousPosition = new Vector3(pose.position.x - 3.96, pose.position.y, pose.position.z + 3.2);
assert.ok(Math.abs(originalDistance / previousPosition.distanceTo(original.target) - .85) < 1e-9,
  'default BEV distance is 15% shorter');
assert.ok(original.position.clone().sub(original.target).normalize()
  .distanceTo(previousPosition.sub(original.target).normalize()) < 1e-9, 'closer BEV preserves the viewing angle');
for (const height of [.3, 1.8, 3]) {
  const framed = createRobotTwinFollowCamera(pose, height);
  assert.ok(framed.position.z > pose.position.z + height, 'default BEV remains above the robot');
}
bev.setAngles({ roll: 45 });
assert.ok(bev.position.distanceTo(original.position) < 1e-9, 'roll tilts the image without orbiting');
assert.ok(bev.target.equals(original.target));
const viewDirection = original.target.clone().sub(original.position).normalize();
const screenUp = up => up.clone().addScaledVector(viewDirection, -up.dot(viewDirection)).normalize();
assert.ok(Math.abs(screenUp(bev.up).dot(screenUp(original.up)) - Math.SQRT1_2) < 1e-9);
bev.setAngles({ pitch: 25 });
assert.ok(bev.position.z > original.position.z, 'positive pitch raises the observation angle');
assert.ok(bev.target.equals(original.target), 'pitch preserves the observation target');
assert.ok(Math.abs(bev.position.distanceTo(bev.target) - originalDistance) < 1e-9);
bev.setAngles({ yaw: 90 });
assert.ok(Math.abs(bev.position.x - bev.target.x) < 1e-9);
assert.ok(bev.position.y < bev.target.y, 'yaw orbits the target instead of looking away');

const adjustments = { roll: 20, pitch: -15, yaw: 35 };
bev.setAngles(adjustments);
const relative = bev.position.clone().sub(new Vector3(2, -3, .2)), priorUp = bev.up.clone();
const moved = { position: { x: -4, y: 8, z: .3 }, rpy: { yaw: 90 } };
bev.update(moved);
assert.ok(bev.position.distanceTo(relative.applyAxisAngle(new Vector3(0, 0, 1), Math.PI / 2)
  .add(new Vector3(-4, 8, .3))) < 1e-9, 'custom framing follows chassis motion and heading');
assert.ok(bev.up.distanceTo(priorUp.applyAxisAngle(new Vector3(0, 0, 1), Math.PI / 2)) < 1e-9);
assert.deepEqual(adjustments, { roll: 20, pitch: -15, yaw: 35 });
for (const pitch of [-90, 90]) {
  bev.setAngles({ pitch, roll: 180, yaw: -180 });
  assert.ok([...bev.position, ...bev.up].every(Number.isFinite));
  assert.ok(bev.up.clone().cross(bev.target.clone().sub(bev.position).normalize()).length() > .5,
    'vertical orbits do not create a degenerate look direction');
}
bev.setAngles({ roll: 0, pitch: 0, yaw: 0 });
const reset = createRobotTwinFollowCamera(moved, 1.8);
assert.ok(bev.position.equals(reset.position) && bev.target.equals(reset.target) && bev.up.equals(reset.up),
  'zero offsets restore the original BEV framing exactly');
assert.deepEqual(normalizeRobotTwinBevAngles({ roll: Infinity, pitch: -100, yaw: 230 }),
  { roll: 0, pitch: -90, yaw: 180 });

const headRobot = new Group(), headPivot = new Group(), stereo = new Group();
headRobot.position.set(2, -3, 0.2); headRobot.add(headPivot);
headPivot.name = 'head_pitch_L'; headPivot.position.z = 1.5; headPivot.add(stereo);
stereo.name = 'camera_head_L'; stereo.position.set(0.1, 0, 0.05);
const stereoVisual = new Group(), shell = new Group(), collision = new Group();
stereoVisual.userData.urdfType = shell.userData.urdfType = 'visual';
collision.userData.urdfType = 'collision';
stereoVisual.position.set(0.003, 0, 0.002);
for (const side of [-1, 1]) {
  const lens = new Mesh(new BoxGeometry(0.02, 0.015, 0.015));
  lens.position.set(0.012, side * 0.032, 0.004); stereoVisual.add(lens);
}
collision.add(new Mesh(new BoxGeometry(100, 100, 100)));
stereo.add(stereoVisual, collision); headPivot.add(shell); shell.visible = false;
const head = createRobotTwinFollowCamera(pose, 1.8, { mode: 'head', robot: headRobot });
near(head.position, [2.115, -3, 1.756]);
near(head.target, [5.115, -3, 1.756]);
near(head.up, [0, 0, 1]);
headPivot.rotation.z = Math.PI / 2;
head.update(pose);
near(head.position, [2, -2.885, 1.756]);
near(head.target, [2, 0.115, 1.756]);
headPivot.rotation.set(0, Math.PI / 2, 0);
head.update(pose);
near(head.position, [2.056, -3, 1.585]);
near(head.target, [2.056, -3, -1.415]);
near(head.up, [1, 0, 0]);
const otherRobot = headRobot.clone(true);
renderRobotTwinFollowView(head, () => {
  assert.equal(stereoVisual.visible, false);
  assert.equal(shell.visible, false);
  assert.equal(otherRobot.getObjectByName('camera_head_L').children[0].visible, true,
    'only the observed robot hides its own head');
});
assert.equal(stereoVisual.visible, true);
assert.equal(shell.visible, false, 'preserve pre-existing visibility');
assert.throws(() => renderRobotTwinFollowView(head, () => { throw new Error('render failed'); }));
assert.equal(stereoVisual.visible, true, 'failed renders also restore the model');
renderRobotTwinFollowView(bev, () => assert.equal(stereoVisual.visible, true));
assert.equal(headRobot.clone(true).getObjectByName('camera_head_L').children[0].visible, true,
  'fleet clones retain the complete head after rendering');
const headFallback = createRobotTwinFollowCamera(pose, 2, { mode: 'head' });
near(headFallback.position, [2.24, -3, 2.08]);
near(headFallback.target, [5.24, -3, 2.08]);
console.log('Twin follow cameras: BEV RPY orbits/reset, chest/head articulation, stereo geometry center, temporary self-occlusion and fallback passed.');
