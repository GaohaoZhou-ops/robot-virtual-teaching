import { abxEqual } from './abxFormat.js';
import { abxNestedRecords } from './abxTeachingImport.js';

function moveContext(task, parkingPointId, poseId, direction) {
  if (!task) throw new Error('示教任务已不存在，请重新选择姿态');
  if (!['up', 'down'].includes(direction)) throw new Error('请选择上移或下移');
  const parking = task.parkingPoints.find((item) => item.id === parkingPointId);
  const index = parking?.poses.findIndex((pose) => pose.id === poseId) ?? -1;
  if (index < 0) throw new Error('目标姿态已不存在，请重新选择');
  const targetIndex = index + (direction === 'up' ? -1 : 1);
  const boundary = targetIndex < 0 || targetIndex >= parking.poses.length;
  return { parking, index, targetIndex, boundary };
}

function nativeMoveContext(task, { parking, index, targetIndex }) {
  const native = task.abx;
  if (!abxEqual(task.parkingPoints.map((item) => item.id), native.parkingIds)
    || !abxEqual(task.parkingPoints.map((item) => item.poses.map((pose) => pose.id)), native.poseIds)) {
    throw new Error('原生任务的步骤对应关系已变化，请重新导入后调整顺序');
  }
  const records = native.lines.map((raw) => ({ raw, value: JSON.parse(raw) }));
  const indices = [index, targetIndex].map((poseIndex) => records.findIndex(({ value }) => (
    value.type === 'point' && value.seq === parking.poses[poseIndex].abx?.pointSeq && value.record.joints_rad
  )));
  if (indices.some((recordIndex) => recordIndex < 0)) throw new Error('找不到姿态对应的原生步骤');
  const [first, last] = [...indices].sort((a, b) => a - b);
  // A native pose inherits its navigation target from preceding actions.
  // Swapping it across a navigation action would execute it at a different stop.
  if (records.slice(first + 1, last).some(({ value }) => value.type === 'point'
    && abxNestedRecords(value.record).some((record) => record.type === 'route_navigation'))) {
    throw new Error('两个姿态之间包含原生导航步骤，不能跨导航调整姿态顺序');
  }
  return { records, indices };
}

export function teachingPoseMoveReason(task, parkingPointId, poseId, direction) {
  try {
    const context = moveContext(task, parkingPointId, poseId, direction);
    if (context.boundary) return direction === 'up' ? '已是当前停车点的第一个姿态' : '已是当前停车点的最后一个姿态';
    if (task.abx) nativeMoveContext(task, context);
    return '';
  } catch (error) {
    return error.message;
  }
}

export function moveTeachingPose(task, { parkingPointId, poseId, direction, updatedAt = new Date().toISOString() }) {
  const context = moveContext(task, parkingPointId, poseId, direction);
  if (context.boundary) return task;
  const { parking, index, targetIndex } = context;
  const native = task.abx ? nativeMoveContext(task, context) : null;
  const poses = [...parking.poses];
  [poses[index], poses[targetIndex]] = [poses[targetIndex], poses[index]];
  let parkingPoints = task.parkingPoints.map((item) => item.id === parkingPointId ? {
    ...item, updatedAt, poses: poses.map((pose, poseIndex) => ({ ...pose, sequence: poseIndex + 1 })),
  } : item);
  if (!native) return { ...task, updatedAt, parkingPoints };

  const { records, indices: [from, to] } = native;
  [records[from], records[to]] = [records[to], records[from]];
  const pointSequences = new Map(), parkingCounts = new Map();
  let count = 0;
  for (const { value } of records) {
    if (value.type !== 'point') continue;
    const seq = String(++count);
    pointSequences.set(value.seq, seq);
    value.seq = seq;
    if (task.abx.header.version >= 2) {
      const parkingCount = (parkingCounts.get(value.parking_id) || 0) + 1;
      parkingCounts.set(value.parking_id, parkingCount);
      value.parking_seq = String(parkingCount);
    }
  }
  parkingPoints = parkingPoints.map((item) => ({
    ...item,
    poses: item.poses.map((pose) => ({
      ...pose, abx: { ...pose.abx, pointSeq: pointSequences.get(pose.abx.pointSeq) },
    })),
  }));
  return {
    ...task, updatedAt, parkingPoints,
    abx: {
      ...task.abx,
      lines: records.map(({ raw, value }) => abxEqual(JSON.parse(raw), value) ? raw : JSON.stringify(value)),
      poseIds: parkingPoints.map((item) => item.poses.map((pose) => pose.id)),
    },
  };
}
