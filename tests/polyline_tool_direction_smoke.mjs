import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { applyRobotJointValues, getRobotEndEffector, readRobotJointValues } from '../src/lib/robotLoader.js';
import { restoreMobileTeachingRobot, serializeMobileTeachingRobot } from '../src/lib/mobileTeachingKinematics.js';
import { createMobileCollisionChecker } from '../src/lib/mobileTeachingCollision.js';
import { normalizePolyline, readPolylineTcp, samplePolylinePlan, transformPolyline } from '../src/lib/polylineTeaching.js';
import { polylineWithSide } from '../src/lib/polylineTeachingTool.js';
import { planPolylineWithApproach } from '../src/lib/polylineTeachingApproach.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/mobile-teaching-botx.json', import.meta.url), 'utf8')).robot;
// Older camera preferences must not flip saved offsets on load or arm switch.
// Zero-distance paths also retain the explicit direction for the next edit.
for (const mode of [undefined, 'manual', 'camera']) for (const direction of [-1, 1]) for (const distance of [0, .2]) {
  const saved = { side: 'left', toolAxisMode: mode, toolAxisDirection: direction,
    tcpOffset: [.01, -.02, direction * distance], quaternion: [0, 0, 0, 1],
    points: [{ position: [1, 2, 3] }, { position: [1.1, 2, 3] }] };
  const path = normalizePolyline(saved);
  assert.equal(path.toolAxisMode, 'manual');
  assert.deepEqual(path.tcpOffset, saved.tcpOffset);
  for (const side of ['right', 'left']) {
    const switched = polylineWithSide(path, side);
    assert.equal(switched.side, side);
    assert.equal(switched.quaternion, null);
    assert.equal(switched.toolAxisDirection, direction);
    assert.deepEqual(switched.tcpOffset, saved.tcpOffset);
    assert.deepEqual(switched.points, saved.points.map((point, index) => ({ ...point, id: `p${index}` })));
  }
  const restored = normalizePolyline(JSON.parse(JSON.stringify(path)));
  assert.equal(restored.toolAxisDirection, direction);
  assert.deepEqual(restored.tcpOffset, [.01, -.02, distance ? direction * distance : 0]);
  const transformed = transformPolyline(restored, new THREE.Matrix4().makeRotationZ(.5));
  assert.equal(transformed.toolAxisMode, 'manual');
  assert.equal(transformed.toolAxisDirection, direction);
  assert.deepEqual(transformed.tcpOffset, restored.tcpOffset);
  assert.equal(saved.toolAxisMode, mode, 'normalization must not mutate imported records');
}

// Actual BOTX kinematics and collision boxes, with mirrored arm poses,
// workpieces and strokes. This controlled case is not the user's live scene.
const posed = restoreMobileTeachingRobot(fixture), world = new THREE.Group(); world.add(posed);
applyRobotJointValues(posed, { left_J2: -90, left_J4: 110, right_J2: 90, right_J4: -110 });
world.updateMatrixWorld(true);
const snapshot = serializeMobileTeachingRobot(posed, { includeCollision: true });
const tool = getRobotEndEffector(posed, 'left').frame;
const quaternion = tool.getWorldQuaternion(new THREE.Quaternion()), origin = tool.getWorldPosition(new THREE.Vector3());
const out = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion), tangent = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
const p0 = origin.clone().addScaledVector(out, .2).addScaledVector(tangent, .015);
const points = [p0, p0.clone().addScaledVector(tangent, .015)];
const solid = new THREE.BoxGeometry(.16, .15, .1).applyQuaternion(quaternion).translate(...p0.clone().addScaledVector(out, .05).toArray());
const mirror = new THREE.Matrix4().makeScale(1, -1, 1);
for (const [side, direction] of [['left', -1], ['right', -1], ['right', 1]]) {
  const geometry = solid.clone(); if (side === 'right') geometry.applyMatrix4(mirror);
  const path = normalizePolyline({ side, toolAxisMode: 'manual', tcpOffset: [0, 0, direction * .2], base: { waistAssist: true, allowPartial: true },
    points: points.map((point) => ({ position: (side === 'right' ? point.clone().applyMatrix4(mirror) : point).toArray() })) });
  const environment = { kind: 'mesh', positions: geometry.attributes.position.array, indices: geometry.index.array };
  const result = await planPolylineWithApproach({ snapshot, parentMatrix: world.matrixWorld.toArray(), path, environment });
  if (side === 'right' && direction === -1) {
    assert.equal(result.executable, false);
    assert.equal(result.issue.phase, 'approach');
    assert.equal(result.issue.code, 'tool-goal-collision');
    assert.ok(result.startToolCheck.originalIssue.collision.environmentClearanceLinks.includes('zivid_right_link'));
    assert.ok(result.issue.collision.environmentLinks.length > 0);
    assert.ok(result.issue.collision.environmentLinks.every(name => ['zivid_right_link', 'right_L7'].includes(name)),
      'the blocked goal involves only bodies rigidly attached to the controlled flange');
    assert.equal(result.approachSearch, undefined);
    assert.equal(result.startToolCheck.oppositeDirection.direction, 1);
  } else {
    assert.equal(result.complete, true, JSON.stringify(result.issue));
    const replay = restoreMobileTeachingRobot(snapshot), base = new THREE.Group(); base.add(replay); base.updateMatrixWorld(true);
    const matrix = base.matrixWorld.clone(), initial = readRobotJointValues(replay);
    const orientation = getRobotEndEffector(replay, side).frame.getWorldQuaternion(new THREE.Quaternion());
    const checker = await createMobileCollisionChecker(replay, environment);
    for (let i = 0; i <= 600; i += 1) {
      const sample = samplePolylinePlan(result, result.durationMs * i / 600);
      applyRobotJointValues(replay, sample.joints); base.updateMatrixWorld(true);
      assert.ok(base.matrixWorld.equals(matrix)); assert.ok(checker.check().clear);
      assert.ok(readPolylineTcp(replay, path).distanceTo(new THREE.Vector3().fromArray(sample.target)) < path.settings.tolerance * 1.01);
      assert.ok(getRobotEndEffector(replay, side).frame.getWorldQuaternion(new THREE.Quaternion()).angleTo(orientation) < THREE.MathUtils.degToRad(path.settings.rotationTolerance));
      for (const [name, value] of Object.entries(sample.joints)) if (name.startsWith(side === 'left' ? 'right_' : 'left_')) assert.ok(Math.abs(value - initial[name]) < 1e-9);
    }
  }
  geometry.dispose();
}
solid.dispose();
console.log('Polyline tool direction: explicit axes, legacy camera-offset preservation, arm switching, zero distance, transfer and actual BOTX mirrored collision failure/recovery with full playback verified.');
