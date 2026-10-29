export const PARKING_DRIFT_DISTANCE_METERS = 0.05;
export const PARKING_DRIFT_YAW_DEGREES = 5;

const finiteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const angularDistanceDegrees = (left, right) => {
  const difference = (
    (finiteNumber(left) - finiteNumber(right) + 180) % 360 + 360
  ) % 360 - 180;
  return Math.abs(difference);
};

export const analyzeParkingPointDrift = (robotPose, poses) => {
  if (!Array.isArray(poses) || poses.length === 0) return null;

  const currentX = finiteNumber(robotPose?.position?.x);
  const currentY = finiteNumber(robotPose?.position?.y);
  const currentYaw = finiteNumber(robotPose?.rpy?.yaw);
  let maxPlanarDistance = 0;
  let maxYawDelta = 0;
  let translationDelta = { x: 0, y: 0 };

  poses.forEach((pose) => {
    const referenceX = finiteNumber(pose?.mapPose?.position?.x);
    const referenceY = finiteNumber(pose?.mapPose?.position?.y);
    const deltaX = currentX - referenceX;
    const deltaY = currentY - referenceY;
    const planarDistance = Math.hypot(deltaX, deltaY);
    const yawDelta = angularDistanceDegrees(currentYaw, pose?.mapPose?.rpy?.yaw);

    if (planarDistance >= maxPlanarDistance) {
      maxPlanarDistance = planarDistance;
      translationDelta = { x: deltaX, y: deltaY };
    }
    maxYawDelta = Math.max(maxYawDelta, yawDelta);
  });

  return {
    shouldWarn: maxPlanarDistance >= PARKING_DRIFT_DISTANCE_METERS
      || maxYawDelta >= PARKING_DRIFT_YAW_DEGREES,
    maxPlanarDistance,
    maxYawDelta,
    translationDelta,
  };
};
