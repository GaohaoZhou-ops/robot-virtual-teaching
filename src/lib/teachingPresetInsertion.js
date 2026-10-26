import { ABX_JOINT_NAMES, abxEqual, abxText } from './abxFormat.js';
import { isRobotJointPreset, presetMatchesRobot } from './robotJointPresets.js';

export const teachingActionPresets = (presets, robot) => (presets || []).filter(
  (preset) => isRobotJointPreset(preset) && presetMatchesRobot(preset, robot),
);

// Native tasks retain camera/navigation/trajectory records outside the pose
// tree. Insert beside the exact native point, then update its sequence mapping.
function insertNativePose(task, parking, anchor, point, position) {
  const native = task.abx;
  if (!abxEqual(task.parkingPoints.map((item) => item.id), native.parkingIds)
    || !abxEqual(task.parkingPoints.map((item) => item.poses.map((pose) => pose.id)), native.poseIds)) {
    throw new Error('原生任务的步骤对应关系已变化，请重新导入后插入动作');
  }
  const records = native.lines.map((raw) => ({ raw, value: JSON.parse(raw) }));
  const anchorIndex = records.findIndex(({ value }) => value.type === 'point' && value.seq === anchor.abx?.pointSeq);
  const anchorRecord = records[anchorIndex]?.value;
  if (!anchorRecord?.record.joints_rad) throw new Error('找不到选中姿态对应的原生步骤');
  if (Number(native.header.point_count) >= 2000) throw new Error('插入后将超过单任务 2000 步骤上限');
  const angularUnit = point.fullBodyJoints.angularUnit || 'degree';
  if (!['degree', 'degrees', 'deg', 'rad', 'radian', 'radians'].includes(angularUnit)) {
    throw new Error('预设姿态的关节角度单位无效');
  }
  const factor = ['degree', 'degrees', 'deg'].includes(angularUnit) ? Math.PI / 180 : 1;
  const joints = Object.fromEntries(Object.entries(ABX_JOINT_NAMES).map(([group, names]) => [
    group, names.map((name) => {
      const value = point.fullBodyJoints.values[name];
      if (!Number.isFinite(value)) throw new Error(`预设姿态缺少关节 ${name}`);
      return value * factor;
    }),
  ]));
  const bodyNames = new Set(Object.values(ABX_JOINT_NAMES).flat());
  if (Object.keys(point.fullBodyJoints.values).some((name) => !bodyNames.has(name) && !/^wheel_(LF|LR|RF|RR)_J$/.test(name))) {
    throw new Error('预设包含机器人原生任务无法表达的关节');
  }
  const inserted = {
    type: 'point', label: point.name,
    record: {
      captured_ns: String(BigInt(Date.parse(point.capturedAt)) * 1000000n),
      robot_model: anchorRecord.record.robot_model,
      robot_sequence: '1', robot_received_ns: '1', joints_rad: joints,
    },
    ...(native.header.version >= 2 ? { parking_id: parking.abx.parkingId } : {}),
  };
  records.splice(anchorIndex + (position === 'after' ? 1 : 0), 0, { value: inserted });
  const pointSequences = new Map();
  const parkingCounts = new Map();
  let count = 0;
  for (const { value } of records) {
    if (value.type !== 'point') continue;
    const seq = String(++count);
    if (value !== inserted) pointSequences.set(value.seq, seq);
    value.seq = seq;
    if (native.header.version >= 2) {
      const parkingCount = (parkingCounts.get(value.parking_id) || 0) + 1;
      parkingCounts.set(value.parking_id, parkingCount);
      value.parking_seq = String(parkingCount);
    }
  }
  inserted.record.robot_sequence = inserted.seq;
  for (const { value } of records) {
    if (value.type === 'parking') value.point_count = String(parkingCounts.get(value.id) || 0);
  }
  point.abx = {
    pointSeq: inserted.seq, located: anchor.abx.located,
    mapPose: structuredClone(point.mapPose), displayName: point.name,
  };
  return {
    pointSequences,
    abx: {
      ...native,
      header: { ...native.header, point_count: String(count) },
      lines: records.map(({ raw, value }) => raw && abxEqual(JSON.parse(raw), value) ? raw : JSON.stringify(value)),
    },
  };
}

export function insertTeachingPreset(task, { parkingPointId, poseId, preset, position, id, capturedAt = new Date().toISOString() }) {
  if (!task) throw new Error('示教任务已不存在，请重新选择姿态');
  const parking = task.parkingPoints.find((item) => item.id === parkingPointId);
  const anchorIndex = parking?.poses.findIndex((pose) => pose.id === poseId) ?? -1;
  const anchor = parking?.poses[anchorIndex];
  if (!anchor) throw new Error('目标姿态已不存在，请重新选择');
  if (!['before', 'after'].includes(position)) throw new Error('请选择在姿态之前或之后插入');
  if (!id || task.parkingPoints.some((item) => item.poses.some((pose) => pose.id === id))) {
    throw new Error('新姿态编号无效，请重试');
  }
  if (!teachingActionPresets([preset], task.robot).length) throw new Error('请选择与该任务机器人匹配的预设姿态');
  abxText(preset.name, '预设姿态名称');
  if (!Number.isFinite(Date.parse(capturedAt))) throw new Error('新姿态记录时间无效');
  const values = preset.joints?.values;
  if (!values || !Object.keys(values).length || !Object.values(values).every(Number.isFinite)) {
    throw new Error('预设姿态缺少有效的关节值');
  }
  const point = {
    id, name: preset.name, capturedAt,
    mapPose: structuredClone(anchor.mapPose),
    fullBodyJoints: structuredClone({ ...preset.joints, count: Object.keys(values).length }),
    cameraCapture: null,
  };
  const nativeUpdate = task.abx ? insertNativePose(task, parking, anchor, point, position) : null;
  const parkingPoints = task.parkingPoints.map((item) => {
    let poses = item.poses;
    if (item.id === parkingPointId) {
      poses = [...poses];
      poses.splice(anchorIndex + (position === 'after' ? 1 : 0), 0, point);
    }
    if (nativeUpdate) poses = poses.map((pose) => pose === point ? pose : {
      ...pose, abx: { ...pose.abx, pointSeq: nativeUpdate.pointSequences.get(pose.abx.pointSeq) },
    });
    return item.id === parkingPointId || nativeUpdate ? {
      ...item,
      ...(item.id === parkingPointId ? { updatedAt: capturedAt } : {}),
      poses: poses.map((pose, index) => ({ ...pose, sequence: index + 1 })),
    } : item;
  });
  return {
    ...task, updatedAt: capturedAt, parkingPoints,
    ...(nativeUpdate ? {
      abx: { ...nativeUpdate.abx, poseIds: parkingPoints.map((item) => item.poses.map((pose) => pose.id)) },
    } : {}),
  };
}
