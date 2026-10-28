import { Group, MathUtils, Vector3 } from 'three';
import { createOpticalCoordinateFrame } from './visionCoverage.js';

const AXIS_LENGTH = .169;
export const ROBOT_COORDINATE_GROUPS = [
  { id: 'chassis', label: '底盘' }, { id: 'torso', label: '躯干' },
  { id: 'left', label: '左臂' }, { id: 'right', label: '右臂' },
  { id: 'head', label: '头部' }, { id: 'camera', label: '相机' },
  { id: 'other', label: '其他' },
];

const coordinateGroup = (frame, robot) => {
  for (let current = frame; current && current !== robot; current = current.parent) {
    if (current.userData?.urdfType !== 'link') continue;
    const name = current.name.toLowerCase();
    if (/(camera|zivid|optical)/.test(name)) return 'camera';
    if (/(wheel|chassis|lidar|mid360)/.test(name)) return 'chassis';
    const side = name.match(/^(?:(?:arm|tool)[_-])?(left|right)(?:[_-]|$)/)?.[1];
    if (side) return side;
    if (/(head|neck)/.test(name)) return 'head';
    if (/(ankle|knee|waist|torso|chest|body)/.test(name)) return 'torso';
    if (current === frame && current.parent === robot) return 'chassis';
  }
  return 'other';
};

export function getRobotCoordinateFrames(robot) {
  if (!robot) return [];
  const frames = [];
  // A joint and its child link share the same moving frame in our URDF tree.
  // Use each link once, including fixed attachments and optical frames.
  robot.traverse(frame => {
    if (frame.userData?.urdfType !== 'link') return;
    frames.push({ name: frame.name, frame, group: coordinateGroup(frame, robot),
      jointName: frame.parent?.userData?.urdfType === 'joint' ? frame.parent.name : null,
      opticalSide: frame.name.match(/^zivid_(left|right)_optical_frame$/)?.[1] || null });
  });
  // A plain mesh has a model origin, but no articulated frames to invent.
  return frames.length ? frames : [{ name: robot.name || 'robot-root', label: '模型原点', frame: robot, group: 'other' }];
}

// Keep guides outside the robot tree so bounds, picking, collision geometry,
// planner snapshots and camera extrinsics remain unchanged.
export function createRobotCoordinateAxes() {
  const root = new Group(); root.name = 'robot-live-coordinate-frames'; root.visible = false;
  return { root, robot: null, frames: [], markers: new Map(), cameraPosition: new Vector3(), forward: new Vector3() };
}

export function clearRobotCoordinateAxes(display) {
  const resources = new Set();
  display.root.traverse(object => {
    if (object.geometry) resources.add(object.geometry);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.filter(Boolean).forEach(material => {
      if (material.map) resources.add(material.map);
      resources.add(material);
    });
  });
  resources.forEach(resource => resource.dispose());
  display.root.clear(); display.root.visible = false;
  display.markers.clear(); display.frames = []; display.robot = null;
}

export function updateRobotCoordinateAxes(display, robot, camera, canvas, selectedNames) {
  if (display.robot !== robot) {
    clearRobotCoordinateAxes(display);
    display.robot = robot;
    display.frames = getRobotCoordinateFrames(robot);
  }
  const visibleNames = [], visibleOpticalSides = new Set();
  // No screen-size/layout read is needed while coordinate guides are hidden.
  const focalPixels = selectedNames.size ? canvas.clientHeight / (2 * Math.tan(MathUtils.degToRad(camera.fov / 2))) : 0;
  const setData = (key, value) => { if (canvas.dataset[key] !== value) canvas.dataset[key] = value; };
  display.markers.forEach(marker => { marker.visible = false; });
  for (const { name, frame, opticalSide } of display.frames) {
    if (!selectedNames.has(name) || focalPixels <= 0) continue;
    let marker = display.markers.get(name);
    if (!marker) {
      marker = createOpticalCoordinateFrame(1.3, { label: opticalSide ? opticalSide === 'left' ? '左' : '右' : undefined });
      marker.name = `robot-coordinate-frame:${name}`;
      marker.userData.axisConvention = opticalSide ? 'optical-local:+x-right,+y-down,+z-forward' : 'urdf-link-local:xyz';
      marker.traverse(object => { object.raycast = () => {}; });
      display.root.add(marker); display.markers.set(name, marker);
    }
    frame.getWorldPosition(marker.position);
    frame.getWorldQuaternion(marker.quaternion);
    const depth = -display.cameraPosition.copy(marker.position).applyMatrix4(camera.matrixWorldInverse).z;
    marker.visible = depth > 1e-9;
    if (!marker.visible) continue;
    // Whole-body guides are slightly smaller to limit overlap. Optical axes
    // retain their existing size and camera-direction labels.
    marker.scale.setScalar((opticalSide ? 64 : 42) * depth / Math.max(AXIS_LENGTH * camera.zoom * focalPixels, 1e-30));
    visibleNames.push(name);
    if (opticalSide) {
      visibleOpticalSides.add(opticalSide);
      const prefix = opticalSide === 'left' ? 'zividLeftAxes' : 'zividRightAxes';
      display.forward.set(0, 0, 1).applyQuaternion(marker.quaternion);
      setData(`${prefix}Position`, marker.position.toArray().map(value => value.toFixed(6)).join(','));
      setData(`${prefix}Forward`, display.forward.toArray().map(value => value.toFixed(8)).join(','));
      setData(`${prefix}Quaternion`, marker.quaternion.toArray().map(value => value.toFixed(8)).join(','));
    }
  }
  for (const side of ['left', 'right']) {
    const prefix = side === 'left' ? 'zividLeftAxes' : 'zividRightAxes';
    setData(`${prefix}Visible`, String(visibleOpticalSides.has(side)));
    if (!visibleOpticalSides.has(side)) for (const field of ['Position', 'Forward', 'Quaternion']) delete canvas.dataset[`${prefix}${field}`];
  }
  display.root.visible = visibleNames.length > 0;
  setData('robotCoordinateAxesVisible', String(display.root.visible));
  setData('robotCoordinateAxesCount', String(visibleNames.length));
  setData('robotCoordinateAxesNames', JSON.stringify(visibleNames));
  setData('zividOpticalAxesVisible', String(visibleOpticalSides.size > 0));
  setData('zividOpticalAxesCount', String(visibleOpticalSides.size));
}
