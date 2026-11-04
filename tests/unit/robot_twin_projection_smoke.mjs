import assert from 'node:assert/strict';
import * as THREE from 'three';
import { robotTwinCapturePose } from '../../src/shared/protocols/robotTwinCapturePose.js';
import { RobotTwinCapturePoses } from '../../src/features/robot-twin/model/robotTwinCapturePoses.js';
import { RobotTwinCaptureCache } from '../../src/features/robot-twin/model/robotTwinCaptureCache.js';
import { createRobotTwinProjectionKinematics, prepareRobotTwinProjection, RobotTwinProjectionCoverage } from '../../src/features/robot-twin/model/robotTwinProjection.js';
import { createRobotCaptureHistory } from '../../src/server/robots/robotTwinMonitor.js';

const time = 1_800_000_000_000, names = Array.from({ length: 20 }, (_, i) => `joint${i}`);
const raw = { source: 'capture_request', captured_ns: String(BigInt(time) * 1_000_000n), robot_model: 'fixture',
  joints_rad: { torso: [0, 0, 0, 0], head: [0, 0], left_arm: [Math.PI / 2, 0, 0, 0, 0, 0, 0], right_arm: [0, 0, 0, 0, 0, 0, 0] },
  localization: { quaternion_wxyz: [0, 0, 0, 1] } };
const saved = robotTwinCapturePose(raw);
assert.equal(saved.capturedAt, time);
assert.equal(saved.jointsRad.length, 20);
assert.equal(saved.localization, undefined, 'never pass odometry off as SLAM');
for (const bad of [null, {}, { ...raw, captured_ns: 'not-a-time' }, { ...raw, captured_ns: 1 }, { ...raw, joints_rad: { ...raw.joints_rad, head: [0, NaN] } }]) {
  assert.equal(robotTwinCapturePose(bad), null);
}
const poses = new RobotTwinCapturePoses();
const snapshot = (sampledAt, x, angle = 0) => ({ sampledAt, pose: { x, y: 2, yaw: 30 }, joints: Object.fromEntries(names.map((name) => [name, angle])),
  localizationFresh: true, jointCount: 20, jointNames: names, modelName: 'fixture' });
poses.observe(snapshot(time - 200, 1)); poses.observe(snapshot(time + 600, 7, 100));
const capture = { id: 'a'.repeat(32), createdAt: new Date(time).toISOString(), robotPose: saved,
  sides: { left: { image: false, cloud: true }, right: { image: false, cloud: false } } };
const pose = poses.resolve(capture);
assert.equal(pose.pose.x, 1, 'slow image/algorithm completion uses capture-time SLAM');
assert.equal(pose.joints.joint6, 90, 'saved capture joints override current telemetry');
assert.equal(pose.pose.yaw, 30, 'capture odometry must not rotate the SLAM frame');
const legacy = poses.resolve({ ...capture, robotPose: null });
assert.equal(legacy.pose.x, 1); assert.equal(legacy.joints.joint6, 0, 'legacy jobs use capture-time feedback, not the arm after movement');
assert.equal(poses.resolve({ ...capture, robotPose: { ...saved, modelName: 'wrong' } }), null);
assert.equal(poses.resolve({ ...capture, robotPose: null, createdAt: new Date(time - 10_000).toISOString() }), null);
poses.observe({ ...snapshot(time + 900, 99), localizationFresh: false });
assert.equal(poses.samples.length, 2, 'expired data cannot seed a projection');
const cache = new RobotTwinCaptureCache({ request: async () => { throw new Error('unexpected media transfer'); }, resolvePose: (item) => poses.resolve(item) });
cache.remember({ captures: [capture] });
const held = cache.projections[0];
poses.observe(snapshot(time + 1000, 20));
cache.remember({ captures: [{ ...capture, pointName: 'updated inspection' }] });
assert.equal(cache.projections.length, 1, 'metadata polling cannot duplicate projections');
assert.equal(cache.projections[0], held, 'capture pose stays immutable');
cache.remember({ captures: [{ ...capture, sides: { ...capture.sides, right: { cloud: true } } }] });
assert.equal(cache.projections.length, 2, 'a late second arm appends independently');
assert.equal(cache.projections[1].pose.x, 1);
cache.reset(); assert.equal(cache.projections.length, 0);
poses.reset(); assert.equal(poses.resolve(capture), null, 'new connections cannot reuse old poses');

const runId = 'b'.repeat(32);
const history = createRobotCaptureHistory(async (path) => path.includes('/captures?')
  ? { ok: true, run_id: runId, captures: [{ id: capture.id, side: 'left', sequence: 1 }], total: 1, next_offset: 1 }
  : { job: { state: 'complete', robot_pose: raw, cameras: { left: { files: [{ kind: 'png', url: `${path}/left/png` }] } } } });
assert.deepEqual((await history(runId, 0)).captures[0].robotPose, saved, 'the real proxy history forwards bounded capture metadata');

const model = new THREE.Group(), joint = new THREE.Group(); joint.name = 'joint6';
joint.userData = { jointType: 'revolute', jointAxis: [0, 0, 1], restPosition: [0, 0, 0], restQuaternion: [0, 0, 0, 1], jointValue: 0 };
model.add(joint);
for (const side of ['left', 'right']) {
  const optical = new THREE.Group(); optical.name = `zivid_${side}_optical_frame`; optical.position.x = side === 'left' ? 1 : -1; joint.add(optical);
}
const kinematics = createRobotTwinProjectionKinematics(model);
const record = kinematics({ ...held, key: 'robot1/left', side: 'left', pose: { x: 3, y: 0, yaw: 0 } }, .2);
assert.ok(Math.abs(record.frame.opticalPose.position.x - 3) < 1e-8);
assert.ok(Math.abs(record.frame.opticalPose.position.y - 1) < 1e-8);
assert.equal(record.frame.opticalPose.position.z, .2);
assert.equal(joint.rotation.z, 0, 'projection kinematics never modifies the visible robot');
const before = structuredClone(record);
kinematics({ ...held, side: 'right', joints: { joint6: -90 } }, 9);
assert.deepEqual(record, before, 'later captures cannot move older optical poses');

const opticalRecord = (key, side, x = 0) => ({ key, side, frame: { opticalPose: {
  position: { x, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } } } });
// No corner of this mesh is in view; the interior still receives a continuous
// projection. A second surface behind it must stay unpainted.
const positions = new Float32Array([-1, -1, .7, 1, -1, .7, 1, 1, .7, -1, 1, .7, 0, 0, .7, 0, 0, 1.1, 0, 0, -.7, 5, 0, .7]);
const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
const left = prepareRobotTwinProjection(opticalRecord('robot1/left', 'left'), positions, indices);
assert.equal(left.grid.surfaceCellCount, left.grid.columns * left.grid.rows);
const coverage = new RobotTwinProjectionCoverage(positions, indices);
let mask = coverage.sync([left.record]).mask;
assert.equal(mask[4], 1); assert.equal(mask[5], 0, 'rear geometry is occluded');
assert.equal(mask[6], 0, 'geometry behind the camera is excluded'); assert.equal(mask[7], 0, 'outside the view is excluded');
const right = prepareRobotTwinProjection(opticalRecord('robot2/right', 'right'), positions, indices);
mask = coverage.sync([left.record, right.record]).mask; assert.equal(mask[4], 3, 'independent left/right flags survive overlap');
assert.equal(coverage.sync([right.record]).mask[4], 2, 'removing one robot preserves the other');
assert.equal(coverage.sync([left.record, left.record]).mask[4], 1, 'repeated coverage is a union');
assert.equal(coverage.sync([]).mask[4], 0, 'disconnect removes all coverage');
const cloud = new Float32Array([-.02, 0, .7, .02, 0, .7, 0, 0, 1.1]);
const cloudFrame = prepareRobotTwinProjection(opticalRecord('points', 'left'), cloud, null);
assert.equal(new RobotTwinProjectionCoverage(cloud, null).sync([cloudFrame.record]).mask[0], 1, 'point-only maps are supported');
console.log('Twin projections: capture metadata, delayed poses, immutable FK, cache deduplication, arm isolation, sparse meshes, occlusion and point maps passed.');
