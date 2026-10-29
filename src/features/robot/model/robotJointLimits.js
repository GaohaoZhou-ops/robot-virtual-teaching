export const ARM_SOFT_LIMIT_RATIO = 0.95;
export const MIN_ARM_SOFT_LIMIT_RATIO = 0.01;

export function normalizeArmSoftLimitRatio(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ARM_SOFT_LIMIT_RATIO;
  return Math.max(MIN_ARM_SOFT_LIMIT_RATIO, Math.min(1, value));
}

export const armSoftLimitPercent = (ratio) => Number((normalizeArmSoftLimitRatio(ratio) * 100).toFixed(2));

export function robotSoftLimitJointGroup(name) {
  const arm = /^(left|right)[_-]J\d+$/i.exec(name || '');
  if (arm) return arm[1].toLowerCase();
  return /^(ankle_pitch|knee_pitch|waist_pitch|waist_yaw)[_-]J$/i.test(name || '') ? 'waist' : null;
}

// Endpoints are fractions of the original hard range, not multipliers of the
// signed angles. This also describes asymmetric joints such as [-176°, 8°].
export function normalizeArmSoftLimitRange(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isFinite(value.lower) || !Number.isFinite(value.upper)
    || value.lower >= value.upper) return null;
  const lower = Math.max(0, Math.min(1 - MIN_ARM_SOFT_LIMIT_RATIO, value.lower));
  const upper = Math.max(lower + MIN_ARM_SOFT_LIMIT_RATIO, Math.min(1, value.upper));
  return { lower, upper };
}

export function normalizeArmSoftLimitOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, range]) => {
    const normalized = robotSoftLimitJointGroup(name) ? normalizeArmSoftLimitRange(range) : null;
    return normalized ? [[name, normalized]] : [];
  }));
}

export function getArmSoftLimitRange(ratio, override) {
  const margin = (1 - normalizeArmSoftLimitRatio(ratio)) / 2;
  return normalizeArmSoftLimitRange(override) || { lower: margin, upper: 1 - margin };
}

// Keep the original waist travel until explicitly configured. Shrinking its
// one-sided hard limits by the arm default would change legacy upright poses.
export function getRobotSoftLimitRange(name, ratio, override) {
  return getArmSoftLimitRange(robotSoftLimitJointGroup(name) === 'waist' ? 1 : ratio, override);
}

// The numbered left/right joints and the four-joint waist chain are configurable.
// Keep the URDF limits untouched: clones and worker snapshots carry the hard
// limits and the configured ratio, so every consumer derives the operating
// range exactly once, including isolated background workers.
// Retain armSoftLimit* field names for existing project/worker compatibility.
export function getRobotJointLimits(joint) {
  const data = joint?.userData || {};
  const hardLower = Number.isFinite(data.jointLimit?.lower) ? data.jointLimit.lower : -Infinity;
  const hardUpper = Number.isFinite(data.jointLimit?.upper) ? data.jointLimit.upper : Infinity;
  const group = robotSoftLimitJointGroup(joint?.name);
  const softLimited = data.jointType === 'revolute'
    && Boolean(group)
    && Number.isFinite(hardLower) && Number.isFinite(hardUpper) && hardUpper > hardLower;
  const override = softLimited ? normalizeArmSoftLimitRange(data.armSoftLimitRange) : null;
  const defaultRatio = group === 'waist' ? 1 : normalizeArmSoftLimitRatio(data.armSoftLimitRatio);
  const softLimitRatio = softLimited ? (override ? override.upper - override.lower : defaultRatio) : null;
  const softLimitRange = softLimited ? getArmSoftLimitRange(defaultRatio, override) : null;
  return {
    lower: softLimited ? hardLower + (hardUpper - hardLower) * softLimitRange.lower : hardLower,
    upper: softLimited ? hardLower + (hardUpper - hardLower) * softLimitRange.upper : hardUpper,
    hardLower, hardUpper, softLimited, softLimitRatio, softLimitRange, softLimitCustom: Boolean(override),
  };
}
