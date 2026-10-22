import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DEFAULT_MOBILE_SOLVE_OPTIONS, measureMobileTarget, mobileReportSolveOptions } from '../src/lib/mobileTeachingSolver.js';
import { formatMobileConstraintValue, mobileAxisWithinTolerance, mobileRowFailureReason,
  mobileSolutionFailureReasons, mobileTargetWithinTolerance } from '../src/lib/mobileTeachingDiagnostics.js';

const options = structuredClone(DEFAULT_MOBILE_SOLVE_OPTIONS);
const solution = {
  feasible: false, positionError: { x: 0.01, y: -0.02, z: 0.03 }, rotationError: { roll: 1, pitch: -2, yaw: 3 },
  chestTilt: 0.01, collision: { checked: true, clear: false, selfPairs: [['left_L3', 'waist_yaw_L']], environmentLinks: [], groundLinks: [] },
};
assert.equal(mobileTargetWithinTolerance(solution, options), true);
assert.deepEqual(mobileSolutionFailureReasons(solution, options), ['机器人自身干涉：left_L3 ↔ waist_yaw_L']);
assert.match(mobileRowFailureReason({ feasible: false, solutions: { left: solution } }, options), /左臂：XYZ \/ RPY 均在容差内.*自身干涉/);
const tilted = { ...solution, chestTilt: 0.25001, collision: { checked: false, clear: false } };
assert.match(mobileSolutionFailureReasons(tilted, options)[0], /倾角 0.25001° > 0.25°/);
assert.equal(mobileSolutionFailureReasons(tilted, options).length, 1, 'an unperformed collision check is not a collision failure');

const crowded = { ...solution, collision: { ...solution.collision, selfPairs: [], armBodyClearance: {
  checked: true, clear: false, minimum: 0.02, required: 0.05, bySide: { left: 0.1, right: 0.02 },
  limitingPair: ['right_L4', 'waist_yaw_L'],
} } };
assert.match(mobileSolutionFailureReasons(crowded, options)[0], /保守下界 2.00 cm，要求 ≥ 5.00 cm（right_L4 ↔ waist_yaw_L）/,
  'the idle arm can be the failing body-clearance constraint');
const allBlocked = { ...solution, chestTilt: 0.6,
  positionError: { ...solution.positionError, x: -0.06 }, rotationError: { ...solution.rotationError, yaw: 5.1 },
  collision: { ...crowded.collision, selfPairs: solution.collision.selfPairs, environmentLinks: ['base_link'], groundLinks: ['left_L7'] } };
const allReasons = mobileSolutionFailureReasons(allBlocked, options);
assert.equal(allReasons.length, 7, 'show every recorded failed constraint, not just the first one');
assert.match(allReasons.join('\n'), /\|X 误差\| 6.00 cm > 5.00 cm/);
assert.match(allReasons.join('\n'), /工件干涉：base_link/);
assert.match(allReasons.join('\n'), /低于支撑平面：left_L7/);

// The previous UI used 1e-7 m while IK uses 1e-9 m. A +20 nm error
// must be highlighted even though both values used to display as 5.00 cm.
const frame = new THREE.Object3D(), target = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
for (const [x, expected] of [[0.05, true], [0.0500000005, true], [0.05000002, false], [-0.05000002, false]]) {
  frame.position.x = x; frame.updateMatrixWorld(true);
  assert.equal(measureMobileTarget(frame, target, options).withinTolerance, expected);
  assert.equal(mobileAxisWithinTolerance(x, 0.05, 'positionTolerance'), expected);
}
assert.equal(mobileAxisWithinTolerance(5 + 5e-8, 5, 'rotationTolerance'), true);
assert.equal(mobileAxisWithinTolerance(5 + 2e-7, 5, 'rotationTolerance'), false);
assert.notEqual(formatMobileConstraintValue(0.05000002, 0.05, 100), formatMobileConstraintValue(0.05, 0.05000002, 100));
assert.equal(formatMobileConstraintValue(-0.05000002, 0.05, 100), '-5.000002');
assert.equal(formatMobileConstraintValue(null, 0.05, 100), '—');
assert.equal(mobileTargetWithinTolerance({ positionError: solution.positionError }, options), false, 'missing angles must not be labelled within tolerance');

assert.deepEqual(mobileSolutionFailureReasons({ ...solution, feasible: true }, options), []);
assert.deepEqual(mobileSolutionFailureReasons({ ...solution, skipped: true }, options), []);
assert.equal(mobileRowFailureReason({ feasible: true, solutions: { right: solution } }, options), '', 'a passing row is not failed by an unused arm');
assert.equal(mobileRowFailureReason(null, null), '');
assert.deepEqual(mobileSolutionFailureReasons({ feasible: false, reason: '目标超出该停车点的机械臂位置范围' }, options), ['目标超出该停车点的机械臂位置范围']);
assert.match(mobileSolutionFailureReasons({ feasible: false }, options)[0], /未记录具体失败原因/);
assert.match(mobileRowFailureReason({ feasible: false, solutions: {}, reason: '历史原因' }, options), /历史原因/);
const disabled = { ...options, checkCollisions: false, lockChestVertical: false };
assert.deepEqual(mobileSolutionFailureReasons({ ...solution, chestTilt: 8, reason: '历史原因' }, disabled), ['历史原因'],
  'disabled checks must not be presented as rejection reasons');
const legacyOptions = mobileReportSolveOptions({ version: 5, options: {} });
assert.equal(legacyOptions.armBodyClearance, 0);
assert.equal(mobileSolutionFailureReasons(crowded, legacyOptions).some((reason) => reason.includes('间距不足')), false);
assert.deepEqual(solution.positionError, { x: 0.01, y: -0.02, z: 0.03 }, 'diagnostics leave reports untouched');
console.log('Mobile diagnostics: all constraint failures, within-tolerance rejection, legacy reports, idle arm and exact display/IK boundaries passed.');
