import { Group, MathUtils, Vector3 } from 'three';
import { createOpticalCoordinateFrame } from './visionCoverage.js';

const AXIS_LENGTH = .169;
const SCREEN_LENGTH = 64;

// Keep guides outside the robot tree: they must not change visual bounds,
// collision proxies, worker snapshots, joint picking or camera extrinsics.
export function createRobotOpticalAxes() {
  const root = new Group(); root.name = 'zivid-live-optical-coordinate-frames'; root.visible = false;
  const markers = Object.fromEntries(['left', 'right'].map(side => {
    const marker = createOpticalCoordinateFrame(1.3, { label: side === 'left' ? '左' : '右' });
    marker.name = `zivid-${side}-optical-coordinate-frame`;
    marker.visible = false;
    marker.traverse(object => { object.raycast = () => {}; });
    root.add(marker);
    return [side, marker];
  }));
  return { root, markers, cameraPosition: new Vector3(), forward: new Vector3() };
}

export function updateRobotOpticalAxes(display, frames, camera, canvas, enabled) {
  let count = 0;
  const focalPixels = canvas.clientHeight / (2 * Math.tan(MathUtils.degToRad(camera.fov / 2)));
  const setData = (key, value) => {
    if (canvas.dataset[key] !== value) canvas.dataset[key] = value;
  };
  for (const [side, marker] of Object.entries(display.markers)) {
    const frame = frames[side], prefix = side === 'left' ? 'zividLeftAxes' : 'zividRightAxes';
    marker.visible = Boolean(enabled && frame && focalPixels > 0);
    if (marker.visible) {
      frame.getWorldPosition(marker.position);
      frame.getWorldQuaternion(marker.quaternion);
      const depth = -display.cameraPosition.copy(marker.position).applyMatrix4(camera.matrixWorldInverse).z;
      marker.visible = depth > 1e-9;
      if (marker.visible) {
        // Match the viewport's existing axes: remain legible while zooming,
        // without scaling or modifying the camera/robot that they describe.
        marker.scale.setScalar(SCREEN_LENGTH * depth / Math.max(AXIS_LENGTH * camera.zoom * focalPixels, 1e-30));
        display.forward.set(0, 0, 1).applyQuaternion(marker.quaternion);
        setData(`${prefix}Position`, marker.position.toArray().map(value => value.toFixed(6)).join(','));
        setData(`${prefix}Forward`, display.forward.toArray().map(value => value.toFixed(8)).join(','));
        setData(`${prefix}Quaternion`, marker.quaternion.toArray().map(value => value.toFixed(8)).join(','));
        count += 1;
      }
    }
    setData(`${prefix}Visible`, String(marker.visible));
    if (!marker.visible) for (const field of ['Position', 'Forward', 'Quaternion']) delete canvas.dataset[`${prefix}${field}`];
  }
  display.root.visible = count > 0;
  setData('zividOpticalAxesVisible', String(count > 0));
  setData('zividOpticalAxesCount', String(count));
}
