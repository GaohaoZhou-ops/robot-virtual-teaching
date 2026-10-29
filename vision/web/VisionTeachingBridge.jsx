import { useEffect, useRef } from 'react';
import DocumentBridge from '../../src/features/devices/ui/VisionWorkbenchBridge.jsx';
import { isVisionWorkbench } from '../../src/features/devices/model/visionWorkbench.js';
import { loadRobotModel, disposeRobotModel, configureRobotArmSoftLimits } from '../../src/features/robot/model/robotLoader.js';
import { configureRobotJointCoupling } from '../../src/features/robot/model/robotJointCoupling.js';
import { serializeMobileTeachingRobot, restoreMobileTeachingRobot } from '../../src/features/teaching/mobile/model/mobileTeachingKinematics.js';
import { HandTeachingSolver, handSides } from './handTeachingSolver.js';
import { readTeachingProject, appendHandTeachingPose } from './handTeachingRecord.js';

const sceneKeys = ['robot', 'robotPose', 'robotJointValues', 'tasks', 'mode', 'softLimitRatio', 'softLimitOverrides', 'jointCoupling'];
const sameScene = (a, b) => a.mapData?.geometry === b.mapData?.geometry && sceneKeys.every(key => a[key] === b[key]);

export default function VisionTeachingBridge(props) {
  const latest = useRef(props); latest.current = props;
  useEffect(() => {
    if (!isVisionWorkbench()) return undefined;
    let session = null, generation = 0, disposed = false, recording = false, loading = null;
    const close = () => {
      generation++; loading?.abort(); loading = null;
      if (session) disposeRobotModel(session.solver.robot); session = null;
    };
    const current = token => {
      if (!session || session.token !== token || !latest.current.sceneReady || !sameScene(session.scene, latest.current.scene)) {
        throw new Error('工程已变化，请更新空间后重新开启手部示教');
      }
      return session;
    };
    const api = {
      async start(request) {
        if (recording) throw new Error('正在保存示教姿态');
        close(); const epoch = generation, scene = latest.current.scene;
        if (!latest.current.sceneReady || !scene.robot) throw new Error('请先载入带双臂机器人的工程');
        const controller = new AbortController(); loading = controller;
        let loaded, robot;
        try {
          loaded = await loadRobotModel(scene.robot, { signal: controller.signal });
          robot = restoreMobileTeachingRobot(serializeMobileTeachingRobot(loaded));
        } finally {
          if (loaded) disposeRobotModel(loaded);
          if (loading === controller) loading = null;
        }
        try {
          if (disposed || epoch !== generation || !sameScene(scene, latest.current.scene)) throw new Error('工程已切换');
          configureRobotJointCoupling(robot, scene.jointCoupling);
          configureRobotArmSoftLimits(robot, scene.softLimitRatio, scene.softLimitOverrides);
          const solver = new HandTeachingSolver(robot, request.baseMatrix);
          solver.restore(request.joints);
          session = { token: request.token, solver, scene, basePose: request.basePose };
          return { jointNames: solver.jointNames,
            tasks: (scene.tasks || []).filter(t => !t.robot?.relativePath || t.robot.relativePath === scene.robot.relativePath)
              .map(t => ({ id: t.id, name: t.name, parkingPoints: (t.parkingPoints || []).map(p => ({ id: p.id, name: p.name })) })) };
        } catch (error) { disposeRobotModel(robot); throw error; }
      },
      solve(request) { return current(request.token).solver.solve(request); },
      async record(request) {
        if (recording) throw new Error('正在保存示教姿态');
        const active = current(request.token), epoch = generation;
        recording = true;
        try {
          active.solver.restore(request.joints);
          const opticalTargets = Object.fromEntries(handSides.flatMap(side => {
            const frameName = `zivid_${side}_optical_frame`, pose = active.solver.pose(frameName);
            return pose ? [[side, { frameName, position: Object.fromEntries(['x', 'y', 'z'].map((key, i) => [key, pose.position[i]])),
              quaternion: Object.fromEntries(['x', 'y', 'z', 'w'].map((key, i) => [key, pose.quaternion[i]])) }]] : [];
          }));
          await latest.current.persist();
          const project = await readTeachingProject(active.scene.mode);
          current(request.token);
          if (disposed || epoch !== generation) throw new Error('示教已停止，本次未记录');
          const recorded = appendHandTeachingPose(project, { ...request, basePose: active.basePose, opticalTargets });
          if (!latest.current.commitHandTeaching) throw new Error('Vision 专用文档接口不可用，请重新构建');
          const tasks = recorded.project.virtualTeaching.tasks;
          latest.current.commitHandTeaching({ tasks, joints: request.joints, basePose: active.basePose,
            taskId: recorded.taskId, parkingId: recorded.parkingId });
          // Wait for the document render/ref update, not a guessed fixed delay.
          const deadline = performance.now() + 5000;
          while (latest.current.scene.tasks !== tasks || latest.current.scene.robotJointValues !== request.joints) {
            if (disposed || epoch !== generation || performance.now() > deadline) throw new Error('工程状态更新未完成，请检查工程后重试');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          await new Promise(resolve => setTimeout(resolve, 0));
          await latest.current.persist();
          const saved = await readTeachingProject(active.scene.mode);
          if (!saved.virtualTeaching?.tasks?.some(t => t.parkingPoints?.some(p => p.poses?.some(v => v.id === recorded.poseId)))) {
            throw new Error('示教姿态尚未写入工程，请重试保存');
          }
          return { taskId: recorded.taskId, parkingId: recorded.parkingId, name: recorded.name };
        } finally { recording = false; close(); }
      },
      stop() { close(); return true; },
    };
    window.AtlasVisionHands = api;
    return () => { disposed = true; close(); if (window.AtlasVisionHands === api) delete window.AtlasVisionHands; };
  }, []);
  return <DocumentBridge {...props} />;
}
