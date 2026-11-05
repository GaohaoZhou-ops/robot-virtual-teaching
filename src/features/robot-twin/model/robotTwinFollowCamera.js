import { Box3, Euler, Matrix4, Quaternion, Vector3 } from 'three';

export const ZERO_ROBOT_TWIN_BEV_ANGLES = Object.freeze({ roll: 0, pitch: 0, yaw: 0 });
export const ROBOT_TWIN_BEV_ANGLE_LIMITS = Object.freeze({ roll: 180, pitch: 90, yaw: 180 });
export const normalizeRobotTwinBevAngles = (value) => Object.fromEntries(
  Object.entries(ROBOT_TWIN_BEV_ANGLE_LIMITS).map(([axis, limit]) => [axis,
    Number.isFinite(value?.[axis]) ? Math.max(-limit, Math.min(limit, value[axis])) : 0]),
);

const visualsOf = (link) => link?.children.filter(child => child.userData.urdfType === 'visual') || [];

function visualCenter(mount) {
  const bounds = new Box3(), part = new Box3(), relative = new Matrix4();
  mount.updateWorldMatrix(true, true);
  const inverse = mount.matrixWorld.clone().invert();
  for (const visual of visualsOf(mount)) visual.traverse(object => {
    if (!object.isMesh || !object.geometry) return;
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    relative.multiplyMatrices(inverse, object.matrixWorld);
    bounds.union(part.copy(object.geometry.boundingBox).applyMatrix4(relative));
  });
  return bounds.getCenter(new Vector3());
}

function createBodyCamera(pose, height, robot, mode) {
  const head = mode === 'head';
  const mount = robot?.getObjectByName(head ? 'camera_head_L' : 'camera_waist_L');
  // The head's stereo cameras share one URDF visual. Compute its center in
  // that link's local frame once, so turning never changes the observation point.
  const eye = head && mount ? visualCenter(mount) : new Vector3(0.05, 0, 0);
  const hiddenVisuals = head && mount
    ? [...visualsOf(mount), ...visualsOf(robot.getObjectByName('head_pitch_L'))] : [];
  const position = new Vector3(), target = new Vector3(), up = new Vector3();
  const forward = new Vector3(), rotation = new Quaternion(), euler = new Euler();
  const frame = { position, target, up };
  const update = (next) => {
    if (mount) {
      // These URDF cameras look along local +X, with +Z up. The chest eye is
      // just beyond its housing's front face at 38 mm; the head eye stays centered.
      // Read the same articulated model that was updated for this render frame.
      mount.updateWorldMatrix(true, false);
      position.copy(eye).applyMatrix4(mount.matrixWorld);
      forward.set(1, 0, 0).transformDirection(mount.matrixWorld);
      up.set(0, 0, 1).transformDirection(mount.matrixWorld);
    } else {
      if (![next?.position?.x, next?.position?.y, next?.position?.z, next?.rpy?.yaw].every(Number.isFinite)) return frame;
      // Models without camera nodes use their size for an approximate viewpoint.
      const { position: base, rpy } = next;
      rotation.setFromEuler(euler.set(
        (Number.isFinite(rpy.roll) ? rpy.roll : 0) * Math.PI / 180,
        (Number.isFinite(rpy.pitch) ? rpy.pitch : 0) * Math.PI / 180,
        rpy.yaw * Math.PI / 180, 'XYZ',
      ));
      position.set(height * (head ? 0.12 : 0.2), 0, height * (head ? 0.94 : 0.72)).applyQuaternion(rotation);
      position.x += base.x; position.y += base.y; position.z += base.z;
      forward.set(1, 0, 0).applyQuaternion(rotation);
      up.set(0, 0, 1).applyQuaternion(rotation);
    }
    target.copy(position).addScaledVector(forward, 3);
    return frame;
  };
  update(pose);
  return { ...frame, update, hiddenVisuals };
}

// A centered head viewpoint is inside its own housing. Hide only that robot's
// head visuals during this render, then restore them before fleet cloning,
// other camera renders, picking or switching back to a different follow mode.
export function renderRobotTwinFollowView(tracker, render) {
  if (!tracker?.hiddenVisuals?.length) return render();
  const hidden = tracker.hiddenVisuals;
  const visibility = hidden.map(object => object.visible);
  hidden.forEach(object => { object.visible = false; });
  try { return render(); }
  finally { hidden.forEach((object, index) => { object.visible = visibility[index]; }); }
}

// The workbench uses meters, Z-up and a robot heading along local +X.
// Keep the framing independent of moving arms and map bounds.
export function createRobotTwinFollowCamera(pose, robotHeight = 1.8, { mode = 'bev', robot = null, bevAngles } = {}) {
  const height = Number.isFinite(robotHeight) && robotHeight > 0.2 ? robotHeight : 1.8;
  if (mode === 'chest' || mode === 'head') return createBodyCamera(pose, height, robot, mode);
  const distance = Math.max(3.5, height * 2.2);
  const elevation = Math.max(3, height + 1.4);
  const ahead = Math.max(0.8, height * 0.6);
  const base = new Vector3(pose.position.x, pose.position.y, pose.position.z);
  let yaw = pose.rpy.yaw * Math.PI / 180;
  let angles = normalizeRobotTwinBevAngles(bevAngles);
  const position = new Vector3(), target = new Vector3(), up = new Vector3(0, 0, 1);
  const offset = new Vector3(), forward = new Vector3();
  const pitchAxis = new Vector3(0, 1, 0), yawAxis = new Vector3(0, 0, 1);
  const frame = () => {
    const x = Math.cos(yaw), y = Math.sin(yaw);
    position.set(base.x - x * distance, base.y - y * distance, base.z + elevation);
    target.set(base.x + x * ahead, base.y + y * ahead, base.z + height * 0.45);
    up.set(0, 0, 1);
    if (angles.roll || angles.pitch || angles.yaw) {
      const pitch = angles.pitch * Math.PI / 180, heading = yaw + angles.yaw * Math.PI / 180;
      // Orbit the existing observation target while keeping its distance.
      // Rotate up with the orbit to stay stable even through a vertical view.
      offset.set(-distance - ahead, 0, elevation - height * 0.45)
        .applyAxisAngle(pitchAxis, pitch).applyAxisAngle(yawAxis, heading);
      position.copy(target).add(offset);
      up.applyAxisAngle(pitchAxis, pitch).applyAxisAngle(yawAxis, heading);
      forward.copy(offset).negate().normalize();
      up.applyAxisAngle(forward, angles.roll * Math.PI / 180);
    }
    // Bring BEV 15% closer without changing its target or viewing angle.
    position.sub(target).multiplyScalar(.85).add(target);
    return { position, target, up };
  };
  frame();
  return {
    position, target, up,
    setAngles(next) {
      angles = normalizeRobotTwinBevAngles(next);
      return frame();
    },
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
