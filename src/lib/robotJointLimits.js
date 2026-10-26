export const ARM_SOFT_LIMIT_RATIO = 0.95;
export const MIN_ARM_SOFT_LIMIT_RATIO = 0.01;

export function normalizeArmSoftLimitRatio(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ARM_SOFT_LIMIT_RATIO;
  return Math.max(MIN_ARM_SOFT_LIMIT_RATIO, Math.min(1, value));
}

export const armSoftLimitPercent = (ratio) => Number((normalizeArmSoftLimitRatio(ratio) * 100).toFixed(2));

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
    const normalized = /^(left|right)[_-]J\d+$/i.test(name) ? normalizeArmSoftLimitRange(range) : null;
    return normalized ? [[name, normalized]] : [];
  }));
}

export function getArmSoftLimitRange(ratio, override) {
  const margin = (1 - normalizeArmSoftLimitRatio(ratio)) / 2;
  return normalizeArmSoftLimitRange(override) || { lower: margin, upper: 1 - margin };
}

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
  const override = softLimited ? normalizeArmSoftLimitRange(data.armSoftLimitRange) : null;
  const softLimitRatio = softLimited ? override ? override.upper - override.lower : normalizeArmSoftLimitRatio(data.armSoftLimitRatio) : null;
  const softLimitRange = softLimited ? getArmSoftLimitRange(data.armSoftLimitRatio, override) : null;
  return {
    lower: softLimited ? hardLower + (hardUpper - hardLower) * softLimitRange.lower : hardLower,
    upper: softLimited ? hardLower + (hardUpper - hardLower) * softLimitRange.upper : hardUpper,
    hardLower, hardUpper, softLimited, softLimitRatio, softLimitRange, softLimitCustom: Boolean(override),
  };
}
