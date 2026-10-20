import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createRobotJointPreset, groupPresetJoints, jointPresetErrors,
  jointValueFromInput, jointValueToInput, presetJointDefinitions, presetMatchesRobot, readRobotPresetFile,
} from '../src/lib/robotJointPresets.js';
import { buildExport, normalizeProject } from '../src/lib/io.js';

const revolute = (name, lower = -180, upper = 180) => ({ name, type: 'revolute', lower, upper });
const definitions = [
  revolute('left_J1'), revolute('right_J1'), revolute('waist_yaw_J', -120, 120),
  revolute('head_pitch_J', -30, 30),
  { name: 'torso_lift', type: 'prismatic', lower: 0, upper: 0.5 },
  { name: 'wheel_LF_J', type: 'continuous', lower: null, upper: null },
  { name: 'fixed_tool', type: 'fixed' },
  revolute('left_J1'),
];
const joints = presetJointDefinitions(definitions);
assert.deepEqual(joints.map((joint) => joint.name), ['left_J1', 'right_J1', 'waist_yaw_J', 'head_pitch_J', 'torso_lift']);
assert.deepEqual(groupPresetJoints(joints).map((group) => [group.id, group.joints.length]),
  [['left', 1], ['right', 1], ['body', 2], ['head', 1]]);

assert.equal(jointValueToInput(180, joints[0], 'radian'), Math.PI);
assert.equal(jointValueFromInput(String(Math.PI / 2), joints[0], 'radian'), 90);
assert.equal(jointValueToInput(0.25, joints[4], 'radian'), 0.25);
assert.equal(jointValueFromInput('0.25', joints[4], 'radian'), 0.25);
for (const value of ['', '  ', 'NaN', 'Infinity', 'invalid']) {
  assert.ok(Number.isNaN(jointValueFromInput(value, joints[0], 'degree')), value);
}

const values = { left_J1: -90, right_J1: 45, waist_yaw_J: 30, head_pitch_J: -10, torso_lift: 0.25 };
const robot = { id: 'robot-a', name: 'Robot A', relativePath: 'robot-a.urdf' };
assert.deepEqual(jointPresetErrors(joints, values), {});
assert.ok(jointPresetErrors(joints, { ...values, head_pitch_J: 31 }).head_pitch_J);
assert.ok(jointPresetErrors(joints, { ...values, torso_lift: -0.1 }).torso_lift);
assert.ok(jointPresetErrors(joints, { ...values, left_J1: Number.NaN }).left_J1);

const pose = createRobotJointPreset({ id: 'preset-a', name: ' 准备姿态 ', robot, joints: definitions,
  values: { ...values, wheel_LF_J: 250, unknown: 12 } });
assert.equal(pose.name, '准备姿态');
assert.equal(pose.joints.source, 'robot-preset');
assert.equal(pose.joints.angularUnit, 'degree');
assert.equal(pose.joints.linearUnit, 'meter');
assert.deepEqual(pose.joints.values, values);
assert.ok(presetMatchesRobot(pose, robot));
assert.equal(presetMatchesRobot(pose, { ...robot, id: 'robot-b' }), false);
assert.equal(presetMatchesRobot(pose, null), false);
assert.throws(() => createRobotJointPreset({ id: 'bad', name: ' ', robot, joints, values }), /名称/);
assert.throws(() => createRobotJointPreset({ id: 'bad', name: '越界', robot, joints, values: { ...values, right_J1: 181 } }), /限位/);

for (const mode of ['map', 'independent']) {
  const exported = buildExport({ mapData: { name: 'fixture.ply' }, teachingSpaceMode: mode,
    heightRange: [0, 1], waypoints: [], edges: [], jointPoses: [pose], robot });
  const restored = normalizeProject(JSON.parse(JSON.stringify(exported)));
  assert.deepEqual(restored.jointPoses[0], pose);
}

const sampleText = await readFile(new URL('./fixtures/sample-pre-teaching-pose.json', import.meta.url), 'utf8');
const sample = JSON.parse(sampleText);
const wireNames = {
  head: ['head_yaw_J', 'head_pitch_J'],
  torso: ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J', 'waist_yaw_J'],
  left_arm: ['left_J1', 'left_J2', 'left_J3', 'left_J4', 'left_J5', 'left_J6', 'left_J7'],
  right_arm: ['right_J1', 'right_J2', 'right_J3', 'right_J4', 'right_J5', 'right_J6', 'right_J7'],
};
const expected = Object.fromEntries(Object.entries(wireNames).flatMap(([group, names]) => (
  names.map((name, index) => [name, sample.joints[group][index]])
)));
// Deliberately reverse URDF order: file array positions must resolve by joint names.
const fullJoints = Object.keys(expected).reverse().map((name) => revolute(name));
const imported = readRobotPresetFile(sampleText, fullJoints, 'sample-pre-teaching-pose.json');
assert.equal(imported.name, 'sample-pre-teaching-pose');
assert.equal(imported.unit, 'degree');
assert.equal(imported.joints.length, 20);
assert.deepEqual(imported.values, expected);
assert.equal(readRobotPresetFile(`\uFEFF${sampleText}`, fullJoints, '准备姿态.JSON').name, '准备姿态');

const radians = { unit: 'rad', joints: Object.fromEntries(Object.entries(sample.joints)
  .map(([group, entries]) => [group, entries.map((value) => value * Math.PI / 180)])) };
const fromRadians = readRobotPresetFile(JSON.stringify(radians), fullJoints, '弧度姿态.json');
assert.equal(fromRadians.unit, 'radian');
Object.entries(expected).forEach(([name, value]) => assert.ok(Math.abs(fromRadians.values[name] - value) < 1e-12));

for (const [mutate, message] of [
  [(data) => { delete data.unit; }, /unit/],
  [(data) => { data.unit = 'unknown'; }, /unit/],
  [(data) => { delete data.joints.head; }, /四组/],
  [(data) => { data.joints.extra = [1]; }, /四组/],
  [(data) => { data.joints.left_arm.pop(); }, /left_arm.*7/],
  [(data) => { data.joints.torso.push(0); }, /torso.*4/],
  [(data) => { data.joints.head[0] = null; }, /有效数值/],
  [(data) => { data.joints.head[0] = '1'; }, /有效数值/],
  [(data) => { data.joints.head[0] = 999; }, /限位/],
]) {
  const data = structuredClone(sample);
  mutate(data);
  assert.throws(() => readRobotPresetFile(JSON.stringify(data), fullJoints, 'bad.json'), message);
}
for (const text of ['{bad json', 'null', '[]', sampleText.replace('"deg"', '"deg", "unit": "rad"')]) {
  assert.throws(() => readRobotPresetFile(text, fullJoints, 'bad.json'));
}
assert.throws(() => readRobotPresetFile(sampleText, fullJoints.filter((joint) => joint.name !== 'head_yaw_J'), 'bad.json'), /head_yaw_J/);
assert.throws(() => readRobotPresetFile(sampleText, fullJoints.map((joint) => (
  joint.name === 'head_yaw_J' ? { ...joint, type: 'prismatic' } : joint
)), 'bad.json'), /旋转关节/);
const importedPose = createRobotJointPreset({ ...imported, id: 'imported-preset', robot });
assert.equal(importedPose.joints.source, 'robot-preset');
assert.deepEqual(normalizeProject({ jointPoses: [importedPose] }).jointPoses[0].joints.values, expected);
console.log('robot joint presets: units, limits, model binding and project persistence passed');
console.log('sample preset import: 20-joint mapping, deg/rad, validation and persistence passed');
