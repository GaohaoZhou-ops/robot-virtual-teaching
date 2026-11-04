// Optional ABX camera-job metadata. Keep measured radians and the capture
// timestamp; chassis odometry in robot_pose.localization is not SLAM.
export function robotTwinCapturePose(value) {
  const groups = [['torso', 4], ['head', 2], ['left_arm', 7], ['right_arm', 7]];
  if (value?.source !== 'capture_request' || typeof value.captured_ns !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.captured_ns)
    || typeof value.robot_model !== 'string' || !value.robot_model || value.robot_model.length > 128
    || groups.some(([name, count]) => !Array.isArray(value.joints_rad?.[name])
      || value.joints_rad[name].length !== count || !value.joints_rad[name].every(Number.isFinite))) return null;
  return { capturedAt: Number(BigInt(value.captured_ns) / 1_000_000n), modelName: value.robot_model,
    jointsRad: groups.flatMap(([name]) => value.joints_rad[name]) };
}
