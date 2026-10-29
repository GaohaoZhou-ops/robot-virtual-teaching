import assert from 'node:assert/strict';
import { sharedRobotPresetEntries, withSharedRobotPresets, withSharedRobotPresetConfig, mergeImportedRobotPresets, mergeLegacyJointConsolePresets } from "../src/features/robot/model/sharedRobotPresets.js";
import { createRobotJointPreset } from "../src/features/robot/model/robotJointPresets.js";

const preset = createRobotJointPreset({ id: 'map-preset', name: '准备', robot: { id: 'robot-a' },
  joints: [{ name: 'left_J1', type: 'revolute', lower: -180, upper: 180 }], values: { left_J1: 30 } });
const recorded = { id: 'recorded', sequence: 1, name: '停车点关节记录', joints: { source: 'urdf-movable-joints', values: { left_J1: 8 } } };
const library = sharedRobotPresetEntries([recorded, preset]);
assert.deepEqual(library.map(pose => pose.id), ['map-preset']);
assert.deepEqual(sharedRobotPresetEntries([{ ...preset, sequence: 88 }]), library, 'workspace-local ordering is not a library edit');
const oldIndependent = { ...preset, id: 'reimported', name: '独立中重复导入', joints: { ...preset.joints, values: { left_J1: 90 } } };
const config = { project: { virtualTeaching: { tasks: [{ id: 'task', parkingPoints: [] }], jointPoses: [recorded, oldIndependent] } }, ui: { unchanged: true } };
const before = structuredClone(config);
const migrated = withSharedRobotPresetConfig(config, library);
assert.deepEqual(migrated.project.virtualTeaching.jointPoses[0], recorded);
assert.deepEqual(migrated.project.virtualTeaching.jointPoses.map(pose => pose.id), ['recorded', 'map-preset']);
assert.equal(migrated.project.virtualTeaching.tasks, config.project.virtualTeaching.tasks);
assert.equal(migrated.ui, config.ui);
assert.deepEqual(config, before, 'migration never mutates its input');
assert.deepEqual(withSharedRobotPresets([recorded, oldIndependent], []), [recorded], 'an empty shared library removes all obsolete copies');
const imported = mergeImportedRobotPresets(library, [
  { ...preset, id: 'duplicate-name' },
  { ...preset, name: '旧名称', joints: { ...preset.joints, values: { left_J1: -90 } } },
  { ...preset, id: 'new-preset', name: '新增' },
  { ...preset, id: 'other-robot', robot: { id: 'robot-b' } },
]);
assert.deepEqual(imported.map(pose => pose.id), ['map-preset', 'new-preset', 'other-robot']);
assert.equal(imported[0].joints.values.left_J1, 30, 'older imported copies do not replace shared edits');
assert.equal(imported[0].name, '准备');
const consolePose = { ...preset, id: 'console-map', name: '关节记录',
  joints: { ...preset.joints, source: 'joint-console', values: { left_J1: 12 } } };
const consoleIndependent = { ...consolePose, id: 'console-independent', joints: { ...consolePose.joints, values: { left_J1: 34 } } };
const consoleMigrated = mergeLegacyJointConsolePresets(library, [
  [consolePose], [consoleIndependent, { ...consolePose, joints: { ...consolePose.joints, values: { left_J1: 99 } } }, oldIndependent],
]);
assert.deepEqual(consoleMigrated.map(pose => pose.id), ['map-preset', 'console-map', 'console-independent']);
assert.deepEqual(consoleMigrated.map(pose => pose.joints.values.left_J1), [30, 12, 34], 'same-name records keep distinct values; current copies win by ID');
assert.deepEqual(sharedRobotPresetEntries([consolePose]).map(pose => pose.id), ['console-map']);
assert.deepEqual(withSharedRobotPresets([recorded, consolePose], []), [recorded], 'deleted console presets cannot survive as local copies');
assert.equal(mergeImportedRobotPresets([], [consolePose])[0].id, consolePose.id, 'old portable projects can import console presets');
console.log('Shared robot presets: map authority, independent duplicate removal, ordinary pose preservation, empty library, portable import deduplication and robot binding passed.');
