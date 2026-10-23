import * as THREE from 'three';

// Touch distances are fractions of the visible source viewport's height, so
// dragging has the same scale in either iPad orientation and with letterboxing.
export function applyScreenViewportGesture(camera, controls, navigation, command) {
  const { kind, dx, dy, zoom } = command;
  if (![dx, dy, zoom].every((value) => Number.isFinite(value) && Math.abs(value) <= 4)) return false;
  if (kind === 'zoom') return navigation.applyZoomFactor(Math.exp(-zoom));
  if (kind === 'pan') return Boolean(navigation.panByPixels(
    dx * Math.max(controls.domElement.clientHeight, 1), dy * Math.max(controls.domElement.clientHeight, 1),
  ));
  if (kind !== 'rotate' || (!dx && !dy)) return false;
  const offset = camera.position.clone().sub(controls.target);
  if (!offset.lengthSq()) return false;
  camera.updateMatrixWorld(true);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const motion = right.multiplyScalar(dx).addScaledVector(up, -dy);
  const axis = motion.cross(offset).normalize();
  const rotation = new THREE.Quaternion().setFromAxisAngle(axis, Math.hypot(dx, dy) * Math.PI);
  camera.position.copy(controls.target).add(offset.applyQuaternion(rotation));
  camera.up.applyQuaternion(rotation).normalize();
  controls.update();
  return true;
}
