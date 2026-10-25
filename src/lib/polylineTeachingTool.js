import { Quaternion, Vector3 } from 'three';

// The two BOTX tool frames have opposite Z conventions. Infer the mounted
// camera's direction from its optical frame, never from the arm's name or
// current world posture. An angled, articulated or unknown mount stays manual.
export function polylineCameraDirection(robot, side) {
  const tool = robot?.getObjectByName(`tool_${side}`);
  const optical = robot?.getObjectByName(`zivid_${side}_optical_frame`);
  if (!tool || !optical) return null;
  let node = optical;
  while (node && node !== tool) {
    if (['revolute', 'continuous', 'prismatic'].includes(node.userData?.jointType)) return null;
    node = node.parent;
  }
  if (node !== tool) return null;
  const inverseTool = tool.getWorldQuaternion(new Quaternion()).invert();
  const axis = new Vector3(0, 0, 1).applyQuaternion(optical.getWorldQuaternion(new Quaternion())).applyQuaternion(inverseTool);
  return Number.isFinite(axis.z) && Math.abs(axis.z) > 1 - 1e-6 ? Math.sign(axis.z) : null;
}

// Following the camera is an authoring preference for NEW paths or explicit
// adoption. Legacy/saved manual offsets stay exact, including X/Y and zero Z.
// Never recompute offsets during checking, loading or playback.
export function polylineWithSide(path, robot, side) {
  const direction = path.toolAxisMode === 'camera' ? polylineCameraDirection(robot, side) : null;
  return { ...path, side, quaternion: null,
    ...(direction === null ? {} : { toolAxisDirection: direction,
      tcpOffset: [path.tcpOffset[0], path.tcpOffset[1], direction * Math.abs(path.tcpOffset[2])] }) };
}
