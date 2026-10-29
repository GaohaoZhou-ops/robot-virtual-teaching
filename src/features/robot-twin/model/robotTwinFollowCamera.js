import { Vector3 } from 'three';

// The workbench uses meters, Z-up and a robot heading along local +X.
// Keep the framing independent of moving arms and map bounds.
export function createRobotTwinFollowCamera(pose, robotHeight = 1.8) {
  const height = Number.isFinite(robotHeight) && robotHeight > 0.2 ? robotHeight : 1.8;
  const distance = Math.max(3.5, height * 2.2);
  const elevation = Math.max(3, height + 1.4);
  const ahead = Math.max(0.8, height * 0.6);
  const base = new Vector3(pose.position.x, pose.position.y, pose.position.z);
  let yaw = pose.rpy.yaw * Math.PI / 180;
  const position = new Vector3(), target = new Vector3();
  const frame = () => {
    const x = Math.cos(yaw), y = Math.sin(yaw);
    position.set(base.x - x * distance, base.y - y * distance, base.z + elevation);
    target.set(base.x + x * ahead, base.y + y * ahead, base.z + height * 0.45);
    return { position, target };
  };
  frame();
  return {
    position, target,
    update(next) {
      if (![next?.position?.x, next?.position?.y, next?.position?.z, next?.rpy?.yaw].every(Number.isFinite)) return frame();
      // The model and camera consume the same interpolated frame. A second
      // camera-only low-pass filter adds lag and makes the robot slide in view.
      base.set(next.position.x, next.position.y, next.position.z);
      yaw = next.rpy.yaw * Math.PI / 180;
      return frame();
    },
  };
}
