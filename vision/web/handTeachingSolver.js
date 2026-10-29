import * as THREE from 'three';
import { applyRobotJointValues, getRobotEndEffector, readRobotJointValues } from '../../src/features/robot/model/robotLoader.js';
import { getRobotJointLimits } from '../../src/features/robot/model/robotJointLimits.js';
import { solveEndEffectorIk } from '../../src/features/robot/model/robotEndEffectorIk.js';
import { getRobotJointCouplingPairs, robotJointCouplingViolations } from '../../src/features/robot/model/robotJointCoupling.js';

export const handSides = ['left', 'right'];
const bodyJoint = /(?:ankle|knee|waist|torso|trunk|body|pelvis|chest|head|neck|spine)/i;
const finiteArray = (value, size) => Array.isArray(value) && value.length === size && value.every(Number.isFinite);

/** A disposable kinematic model, never the document's or renderer's robot. */
export class HandTeachingSolver {
  constructor(robot, baseMatrix) {
    if (!finiteArray(baseMatrix, 16)) throw new Error('机器人基座坐标无效');
    this.robot = robot;
    this.base = new THREE.Group(); this.base.matrixAutoUpdate = false;
    this.base.matrix.fromArray(baseMatrix); this.base.add(robot);
    this.controllers = Object.fromEntries(handSides.map(side => [side, getRobotEndEffector(robot, side)]));
    if (handSides.some(side => !this.controllers[side])) throw new Error('工程需要 tool_left、tool_right 双臂末端坐标系');
    const shared = new Set(this.controllers.left.joints.filter(j => this.controllers.right.joints.includes(j)));
    this.allowed = Object.fromEntries(handSides.map(side => [side,
      this.controllers[side].joints.filter(j => !shared.has(j) && !bodyJoint.test(j.name)),
    ]));
    if (handSides.some(side => !this.allowed[side].length)) throw new Error('无法分离双臂与共享关节，已禁用手部示教');
    this.jointNames = Object.fromEntries(handSides.map(side => [side, this.allowed[side].map(j => j.name)]));
    this.base.updateMatrixWorld(true);
  }

  restore(values) {
    const expected = Object.keys(readRobotJointValues(this.robot));
    if (expected.some(name => !Number.isFinite(values?.[name]))) throw new Error('当前机器人关节快照不完整');
    // Frozen body joints must not be moved by soft-limit clamping on restore.
    applyRobotJointValues(this.robot, values, { measured: true });
    this.base.updateMatrixWorld(true);
  }

  pose(frameName) {
    const frame = this.robot.getObjectByName(frameName);
    if (!frame) return null;
    return { position: frame.getWorldPosition(new THREE.Vector3()).toArray(),
      quaternion: frame.getWorldQuaternion(new THREE.Quaternion()).toArray() };
  }

  solve({ joints, targets, deltaTime = 1 / 30 }) {
    // Every request starts from what native actually displayed. A discarded
    // reply (release, tracking loss, scene change) never advances this baseline.
    this.restore(joints);
    const result = {};
    for (const side of handSides) {
      const target = targets?.[side];
      if (!target) continue;
      const before = readRobotJointValues(this.robot);
      const allowed = new Set(this.allowed[side]);
      const names = new Set(this.jointNames[side]);
      let status = 'unreachable', candidate = null;
      if (finiteArray(target.position, 3) && finiteArray(target.quaternion, 4)
          && Math.abs(Math.hypot(...target.quaternion) - 1) < 0.01) {
        const controller = this.controllers[side];
        const excluded = new Set(controller.joints.filter(j => !allowed.has(j)));
        const solved = solveEndEffectorIk(controller, new THREE.Vector3().fromArray(target.position),
          new THREE.Quaternion().fromArray(target.quaternion), excluded, { referenceJointValues: joints });
        candidate = readRobotJointValues(this.robot);
        const frozen = Object.keys(before).every(name => names.has(name) || Math.abs(before[name] - candidate[name]) < 1e-8);
        const withinLimits = this.allowed[side].every(joint => {
          const { lower, upper } = getRobotJointLimits(joint), value = joint.userData.jointValue;
          return Number.isFinite(value) && value >= lower - 1e-7 && value <= upper + 1e-7;
        });
        const slowEnough = this.allowed[side].every(joint => Math.abs(candidate[joint.name] - before[joint.name])
          <= (joint.userData.jointType === 'prismatic' ? 0.25 : 180) * Math.min(0.1, Math.max(1 / 90, deltaTime)) + 1e-6);
        if (solved.status === 'tracking' && solved.positionError <= 0.004 && solved.rotationError <= 1.5
            && frozen && withinLimits && !robotJointCouplingViolations(getRobotJointCouplingPairs(this.robot)).length) {
          status = slowEnough ? 'tracking' : 'speedLimited';
        }
      }
      if (status !== 'tracking') this.restore(before);
      result[side] = { epoch: target.epoch, status,
        joints: status === 'tracking' ? Object.fromEntries(this.jointNames[side].map(name => [name, candidate[name]])) : {},
        actual: this.pose(`tool_${side}`) };
    }
    return result;
  }
}
