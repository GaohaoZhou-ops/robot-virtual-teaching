export const ARM_SOFT_LIMIT_RATIO = 0.95;
export const MIN_ARM_SOFT_LIMIT_RATIO = 0.01;

export function normalizeArmSoftLimitRatio(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ARM_SOFT_LIMIT_RATIO;
  return Math.max(MIN_ARM_SOFT_LIMIT_RATIO, Math.min(1, value));
}

export const armSoftLimitPercent = (ratio) => Number((normalizeArmSoftLimitRatio(ratio) * 100).toFixed(2));

// The workbench's numbered left/right joints are the two arm chains.
// Keep the URDF limits untouched: clones and worker snapshots carry the hard
// limits and the configured ratio, so every consumer derives the operating
// range exactly once, including isolated background workers.
export function getRobotJointLimits(joint) {
  const data = joint?.userData || {};
  const hardLower = Number.isFinite(data.jointLimit?.lower) ? data.jointLimit.lower : -Infinity;
  const hardUpper = Number.isFinite(data.jointLimit?.upper) ? data.jointLimit.upper : Infinity;
  const softLimited = data.jointType === 'revolute'
    && /^(left|right)[_-]J\d+$/i.test(joint?.name || '')
    && Number.isFinite(hardLower) && Number.isFinite(hardUpper) && hardUpper > hardLower;
  const softLimitRatio = softLimited ? normalizeArmSoftLimitRatio(data.armSoftLimitRatio) : null;
  const margin = softLimited ? (hardUpper - hardLower) * (1 - softLimitRatio) / 2 : 0;
  return { lower: hardLower + margin, upper: hardUpper - margin, hardLower, hardUpper, softLimited, softLimitRatio };
}
