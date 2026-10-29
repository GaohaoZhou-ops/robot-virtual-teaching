import { loadWorkspaceConfig } from '../../src/features/workspace/model/sessionStore.js';

// One read-only compatibility boundary for the document store. All writes go
// through the Vision build's document port and the existing persist API.
export async function readTeachingProject(mode) {
  const sessionId = await new Promise((resolve, reject) => {
    const request = indexedDB.open('atlas-route-studio');
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error('工程尚未载入')); };
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('workspace-session', 'readonly');
      const meta = transaction.objectStore('workspace-session').get('meta');
      transaction.oncomplete = () => { db.close(); resolve(meta.result?.sessionId); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  });
  const record = await loadWorkspaceConfig(sessionId, mode);
  if (!record?.config?.project) throw new Error('工程尚未保存，无法记录姿态');
  return structuredClone(record.config.project);
}

export function appendHandTeachingPose(project, { joints, basePose, opticalTargets, name, taskId, parkingId }) {
  const copy = structuredClone(project), now = new Date().toISOString();
  const frameId = copy.coordinateSystem?.frameId || (copy.workspace?.teachingSpaceMode === 'independent' ? 'virtual_origin' : 'map');
  const mapPose = { frameId, ...structuredClone(basePose) };
  if (!Object.keys(joints || {}).length || !Object.values(joints).every(Number.isFinite)) throw new Error('没有有效的机器人姿态');
  copy.virtualTeaching ??= {}; copy.virtualTeaching.tasks ??= [];
  const tasks = copy.virtualTeaching.tasks;
  let task = taskId ? tasks.find(t => t.id === taskId) : null;
  if (taskId && !task) throw new Error('目标任务已变化，请重新选择');
  if (!task) {
    task = { id: `vision-task-${crypto.randomUUID()}`, name: 'Vision 双臂示教', createdAt: now, updatedAt: now,
      coordinateFrame: frameId, robot: structuredClone(copy.robot), map: structuredClone(copy.map), parkingPoints: [] };
    tasks.push(task);
  }
  if (task.robot?.relativePath && task.robot.relativePath !== copy.robot?.relativePath) throw new Error('任务机器人与当前机器人不一致');
  let parking = parkingId ? task.parkingPoints.find(p => p.id === parkingId) : null;
  if (parkingId && !parking) throw new Error('目标停车点已变化，请重新选择');
  if (parking) {
    const a = parking.mapPose, b = mapPose;
    const angleDistance = (x, y) => Math.abs(((x - y + 540) % 360 + 360) % 360 - 180);
    if (['x', 'y', 'z'].some(k => Math.abs(a.position[k] - b.position[k]) > 0.001)
        || ['roll', 'pitch', 'yaw'].some(k => angleDistance(a.rpy[k], b.rpy[k]) > 0.1)) {
      throw new Error('当前基座不在所选停车点，请新建停车点或先回放该停车点');
    }
  } else {
    parking = { id: `vision-parking-${crypto.randomUUID()}`, name: `P${String(task.parkingPoints.length + 1).padStart(2, '0')}`,
      createdAt: now, updatedAt: now, mapPose, poses: [] };
    task.parkingPoints.push(parking);
  }
  const pose = { id: `vision-pose-${crypto.randomUUID()}`, name: name?.trim().slice(0, 100) || `A${String(parking.poses.length + 1).padStart(2, '0')}`,
    capturedAt: now, sequence: parking.poses.length + 1, mapPose,
    fullBodyJoints: { angularUnit: 'degree', linearUnit: 'meter', source: 'urdf-movable-joints', count: Object.keys(joints).length, values: { ...joints } },
    opticalTargets: structuredClone(opticalTargets) };
  parking.poses.push(pose); parking.updatedAt = now; task.updatedAt = now;
  // Reopening the document and refreshing space must show the accepted pose.
  copy.robot.origin = structuredClone(basePose); copy.robot.joints = { ...joints };
  copy.workspace ??= {};
  copy.workspace.activeTeachingTaskId = task.id; copy.workspace.activeTeachingParkingPointId = parking.id;
  return { project: copy, taskId: task.id, parkingId: parking.id, poseId: pose.id, name: pose.name };
}
