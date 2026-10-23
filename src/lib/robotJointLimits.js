export const ARM_SOFT_LIMIT_RATIO = 0.95;

// The workbench's numbered left/right joints are the two arm chains.
// Keep the URDF limits untouched: clones and worker snapshots carry the hard
// limits, and every consumer derives the same operating range exactly once.
export function getRobotJointLimits(joint) {
  const data = joint?.userData || {};
  const hardLower = Number.isFinite(data.jointLimit?.lower) ? data.jointLimit.lower : -Infinity;
  const hardUpper = Number.isFinite(data.jointLimit?.upper) ? data.jointLimit.upper : Infinity;
  const softLimited = data.jointType === 'revolute'
    && /^(left|right)[_-]J\d+$/i.test(joint?.name || '')
    && Number.isFinite(hardLower) && Number.isFinite(hardUpper) && hardUpper > hardLower;
  const margin = softLimited ? (hardUpper - hardLower) * (1 - ARM_SOFT_LIMIT_RATIO) / 2 : 0;
  return { lower: hardLower + margin, upper: hardUpper - margin, hardLower, hardUpper, softLimited };
}
