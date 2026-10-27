import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { applyRobotJointValues } from '../src/lib/robotLoader.js';

export function visionSceneFixture() {
  const box = (size, position, color) => {
    const geometry = new THREE.BoxGeometry(...size).translate(...position);
    const rgb = new THREE.Color(color), colors = [];
    for (let i = 0; i < geometry.attributes.position.count; i++) colors.push(rgb.r, rgb.g, rgb.b);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return geometry;
  };
  const pieces = [box([6, 4, .1], [0, 0, -.05], '#3c626e'), box([.6, 1.4, .8], [-1.5, .6, .4], '#8c9ba1'), box([1, .25, 1.8], [1.5, 1.5, .9], '#99b6bf')];
  const geometry = mergeGeometries(pieces); pieces.forEach(p => p.dispose());
  const robot = new THREE.Group(); robot.name = 'fixture-robot';
  const visual = (parent, size, position, color, name) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshStandardMaterial({ color, roughness: 0.58, metalness: 0.16 }));
    mesh.name = name; mesh.position.set(...position); parent.add(mesh); return mesh;
  };
  const joint = (parent, name, type, position, axis) => {
    const value = new THREE.Group(); value.name = name; value.position.set(...position);
    value.userData = { jointType: type, jointAxis: axis, restPosition: position, restQuaternion: [0, 0, 0, 1], jointValue: 0 };
    parent.add(value); return value;
  };
  visual(robot, [.65, .5, .25], [0, 0, .125], '#dce1e3', '移动底盘');
  const lift = joint(robot, 'lift', 'prismatic', [0, 0, .25], [0, 0, 1]);
  const shoulder = joint(lift, 'shoulder', 'revolute', [0, 0, 0], [0, 1, 0]);
  visual(shoulder, [.18, .18, .7], [0, 0, .35], '#f4b13e', '上臂');
  const elbow = joint(shoulder, 'elbow', 'continuous', [0, 0, .7], [0, 1, 0]);
  visual(elbow, [.14, .14, .6], [0, 0, .3], '#e7e9ea', '前臂');
  const tip = visual(elbow, [.23, .25, .18], [0, 0, .65], '#28bdce', '检查相机');
  const cameras = Object.fromEntries(['left', 'right'].map((side, i) => {
    const optical = new THREE.Group(); optical.name = `zivid_${side}_optical_frame`;
    optical.position.set(i ? .11 : -.11, .04, .65);
    optical.rotation.set(.15, i ? -.2 : .2, .1, 'ZYX');
    elbow.add(optical); return [side, optical];
  }));
  const collision = visual(robot, [1, 1, 1], [0, 0, 0], '#f00', 'collision-only');
  collision.userData.robotCollisionGeometry = true;
  robot.userData.robot = { movableJoints: [{ name: 'lift', type: 'prismatic' }, { name: 'shoulder', type: 'revolute' }, { name: 'elbow', type: 'continuous' }] };
  const robotPose = { position: { x: .4, y: -.3, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: 25 } };
  const robotJointValues = { lift: .1, shoulder: -20, elbow: 40 }; applyRobotJointValues(robot, robotJointValues);
  const pose = (id, values, mapPose = robotPose) => ({ id, sequence: Number(id), mapPose, fullBodyJoints: { values } });
  const task = { id: 'motion', name: '检查动作', robot: { id: 'fixture' }, parkingPoints: [
    { id: 'stop1', name: '检查位', sequence: 1, mapPose: robotPose, poses: [pose('1', robotJointValues), pose('2', { lift: .35, shoulder: 45, elbow: 90 })] },
    { id: 'stop2', sequence: 2, mapPose: { position: { x: 1.2, y: -.6, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: -179 } },
      poses: [pose('3', { lift: .2, shoulder: -30, elbow: 350 }, { position: { x: 1.2, y: -.6, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: -179 } })] },
  ], polylines: [{ id: 'line', name: '检查路径', points: [{ position: [-1.7, 0, .85] }, { position: [-1.2, .5, .85] }] }] };
  const mobile = { id: 'mobile', name: '移动视点', mobileTransform: new THREE.Matrix4().makeTranslation(-1, -1, .1).toArray(),
    mobileCapture: { samples: [{ id: 'key', kind: 'keyframe', segmentId: 'a', cameraPose: { position: { x: .1, y: .2, z: .8 } } }] } };
  return { mapData: { geometry, name: '空间检查演练', mapId: 'scene-fixture' }, robotModel: robot, robotDescriptor: { id: 'fixture', name: '完整机械臂' },
    robotPose, robotJointValues, tasks: [task, mobile], waypoints: [{ id: 'a', x: -2, y: -1, z: 0 }, { id: 'b', x: 2, y: -1, z: 0 }], edges: [{ id: 'edge', from: 'a', to: 'b' }], tip, cameras };
}
