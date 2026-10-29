import { normalizeJointPoses } from "../../workspace/model/io.js";
import { isRobotJointPreset } from "./robotJointPresets.js";

export const isSharedRobotPreset = isRobotJointPreset;

// Preset ordering belongs to the library, independently of a workspace's
// recorded joint poses. Normalize portable/legacy fields before comparing.
export function sharedRobotPresetEntries(poses = []) {
  return normalizeJointPoses(poses).filter(isSharedRobotPreset)
    .map((pose, index) => ({ ...pose, sequence: index + 1 }));
}

// Upgrade the previously workspace-local console records once. Identity wins
// over cached copies, while distinct records with the same name retain their
// joint values. Never merge discarded legacy robot-preset copies back in.
export function mergeLegacyJointConsolePresets(current, sources) {
  const merged = sharedRobotPresetEntries(current);
  const ids = new Set(merged.map((pose) => pose.id));
  for (const source of sources) {
    for (const pose of normalizeJointPoses(source)) {
      if (pose.joints.source !== 'joint-console' || ids.has(pose.id)) continue;
      ids.add(pose.id);
      merged.push(pose);
    }
  }
  return merged.map((pose, index) => ({ ...pose, sequence: index + 1 }));
}

export function withSharedRobotPresets(poses = [], presets = []) {
  return [...poses.filter(pose => !isSharedRobotPreset(pose)), ...structuredClone(presets)]
    .map((pose, index) => ({ ...pose, sequence: index + 1 }));
}

export function withSharedRobotPresetConfig(config, presets) {
  if (!config?.project) return config;
  const poses = config.project.virtualTeaching?.jointPoses || config.project.jointPoses || config.project.robot?.jointPoses || [];
  return { ...config, project: { ...config.project,
    virtualTeaching: { ...config.project.virtualTeaching,
      jointPoses: withSharedRobotPresets(poses, presets) } } };
}

// Loading a portable project can add presets; an older copy must not replace
// an edited preset or duplicate the same robot/name under a different UUID.
export function mergeImportedRobotPresets(current, incoming) {
  const merged = sharedRobotPresetEntries(current);
  for (const pose of sharedRobotPresetEntries(incoming)) {
    const robotKey = pose.robot.id || pose.robot.relativePath;
    if (!merged.some(item => item.id === pose.id
      || ((item.robot.id || item.robot.relativePath) === robotKey && item.name.trim() === pose.name.trim()))) merged.push(pose);
  }
  return merged.map((pose, index) => ({ ...pose, sequence: index + 1 }));
}
