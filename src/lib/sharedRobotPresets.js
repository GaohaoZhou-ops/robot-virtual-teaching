import { normalizeJointPoses } from './io.js';

export const isSharedRobotPreset = (pose) => pose?.joints?.source === 'robot-preset';

// Preset ordering belongs to the library, independently of a workspace's
// recorded joint poses. Normalize portable/legacy fields before comparing.
export function sharedRobotPresetEntries(poses = []) {
  return normalizeJointPoses(poses).filter(isSharedRobotPreset)
    .map((pose, index) => ({ ...pose, sequence: index + 1 }));
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
