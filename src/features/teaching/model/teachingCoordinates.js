import { Euler, Matrix4, Quaternion, Vector3, MathUtils } from 'three';
import { transformPolyline } from '../polyline/model/polylineTeaching.js';

const axes = ['x', 'y', 'z'];
const rotationAxes = ['roll', 'pitch', 'yaw'];
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

export const identityTransferPose = () => ({
  position: { x: 0, y: 0, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: 0 },
});

export function transferMatrix(pose) {
  requireValue(axes.every((axis) => Number.isFinite(pose?.position?.[axis]))
    && rotationAxes.every((axis) => Number.isFinite(pose?.rpy?.[axis])), '位置和角度必须是有效数值');
  return new Matrix4().compose(
    new Vector3(...axes.map((axis) => pose.position[axis])),
    new Quaternion().setFromEuler(new Euler(
      ...rotationAxes.map((axis) => MathUtils.degToRad(pose.rpy[axis])), 'ZYX',
    )),
    new Vector3(1, 1, 1),
  );
}

// TXT rows describe p_map = T * p_local, with translation in meters.
export function parseTransferMatrix(text) {
  return parseTransferMatrixFile(text).matrix;
}

export function parseTransferMatrixFile(text) {
  const rows = String(text).replace(/^\uFEFF/, '').trim().split(/\r\n?|\n/)
    .map((row) => row.trim()).filter(Boolean).map((row) => row.split(/\s+/));
  requireValue(rows.length === 4 && rows.every((row) => row.length === 4), '转换矩阵必须为 4 行，每行 4 个数值，以空格或制表符分隔');
  const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const values = rows.map((row, rowIndex) => row.map((value, columnIndex) => {
    requireValue(decimal.test(value) && Number.isFinite(Number(value)), `转换矩阵第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列必须是有效数值`);
    return Number(value);
  }));
  requireValue(values[3].every((value, index) => Math.abs(value - (index === 3 ? 1 : 0)) <= 1e-8),
    '转换矩阵最后一行必须是 0 0 0 1');
  const matrix = new Matrix4().set(...values.flat());
  // Allow rounding in six-decimal text exports, but reject scale, shear and reflections.
  const columns = [0, 1, 2].map((axis) => new Vector3().setFromMatrixColumn(matrix, axis));
  const tolerance = 1e-4;
  requireValue(columns.every((column, index) => columns.every((other, otherIndex) => (
    Math.abs(column.dot(other) - (index === otherIndex ? 1 : 0)) <= tolerance
  ))) && Math.abs(matrix.determinant() - 1) <= tolerance,
  '转换矩阵旋转部分必须为正交旋转矩阵，不支持缩放、剪切或镜像');
  return {
    values: values.flat(),
    matrix: new Matrix4().compose(
      new Vector3(values[0][3], values[1][3], values[2][3]),
      new Quaternion().setFromRotationMatrix(matrix).normalize(),
      new Vector3(1, 1, 1),
    ),
  };
}

export function mapTeachingCalibrationMatrix(record) {
  if (!record) return new Matrix4();
  if (!Array.isArray(record.values) || record.values.length !== 16) throw new Error('地图示教转换矩阵记录无效');
  return parseTransferMatrixFile([0, 4, 8, 12]
    .map((offset) => record.values.slice(offset, offset + 4).join(' ')).join('\n')).matrix;
}

export function transformTeachingPose(pose, matrix, frameId) {
  const composed = matrix.clone().multiply(transferMatrix(pose));
  const position = new Vector3().setFromMatrixPosition(composed);
  const angles = new Euler().setFromRotationMatrix(composed, 'ZYX');
  return {
    ...(frameId ? { frameId } : {}),
    position: { x: position.x, y: position.y, z: position.z },
    rpy: { roll: MathUtils.radToDeg(angles.x), pitch: MathUtils.radToDeg(angles.y), yaw: MathUtils.radToDeg(angles.z) },
  };
}

const transformOpticalPose = (pose, matrix) => {
  if (!pose) return pose;
  const position = new Vector3(pose.position.x, pose.position.y, pose.position.z).applyMatrix4(matrix);
  const quaternion = new Quaternion().setFromRotationMatrix(matrix).multiply(
    new Quaternion(pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w),
  ).normalize();
  return { ...pose, position: { x: position.x, y: position.y, z: position.z },
    quaternion: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w } };
};

export function transformTeachingTasks(tasks, matrix, mode, map) {
  const frame = mode === 'independent' ? 'virtual_origin' : 'map';
  const pose = (value) => transformTeachingPose(value, matrix, frame);
  return tasks.map((task) => ({
    ...task, coordinateFrame: frame,
    ...(task.polylines ? { polylines: task.polylines.map((path) => transformPolyline(path, matrix)) } : {}),
    ...(task.mobileSolveSource?.initialMapPose ? { mobileSolveSource: { ...task.mobileSolveSource,
      initialMapPose: pose(task.mobileSolveSource.initialMapPose) } } : {}),
    ...(task.mobileCapture ? { mobileTransform: matrix.clone().multiply((task.mobileTransform ? new Matrix4().fromArray(task.mobileTransform) : new Matrix4())).toArray(), mobileSolve: null } : {}),
    map: { id: map.mapId, fileName: map.name, sourceHash: map.sourceHash, teachingSpaceMode: mode, coordinateFrame: frame },
    parkingPoints: task.parkingPoints.map((parking) => ({
      ...parking, mapPose: pose(parking.mapPose),
      mergeHistory: (parking.mergeHistory || []).map((entry) => ({ ...entry,
        sourceParkingPoints: entry.sourceParkingPoints.map((source) => ({ ...source, mapPose: pose(source.mapPose) })),
      })),
      poses: parking.poses.map((point) => ({
        ...point, mapPose: pose(point.mapPose),
        opticalTargets: Object.fromEntries(Object.entries(point.opticalTargets || {})
          .map(([side, target]) => [side, transformOpticalPose(target, matrix)])),
        cameraCapture: point.cameraCapture ? { ...point.cameraCapture,
          // RGB and camera-local XYZ stay unchanged; only the camera's world pose moves.
          frames: Object.fromEntries(Object.entries(point.cameraCapture.frames).map(([side, camera]) => [side, {
            ...camera, opticalPose: transformOpticalPose(camera.opticalPose, matrix),
          }])),
        } : null,
        replanningHistory: (point.replanningHistory || []).map((entry) => ({ ...entry,
          sourceMapPose: pose(entry.sourceMapPose), commonMapPose: pose(entry.commonMapPose),
        })),
      })),
    })),
  }));
}
