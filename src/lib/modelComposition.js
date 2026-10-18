import { Quaternion, Vector3 } from 'three';
import { cropModel, modelBounds } from './modelEditing.js';
import { modelMatrixFromOrigin, originFromModelPose, readModelOrigin, ZERO_MODEL_ORIGIN } from './modelOriginTransform.js';

export const DEFAULT_MODEL_COMPOSITION = Object.freeze({ pose: ZERO_MODEL_ORIGIN, mode: 'replace' });

// A pose locates B in A's coordinates. The single-model gizmo edits the inverse
// frame; this adapter preserves its existing drag, rotation and cancellation logic.
export function inverseModelPose(pose, previous = ZERO_MODEL_ORIGIN) {
  const inverse = modelMatrixFromOrigin(pose);
  if (!inverse) return null;
  const forward = inverse.invert();
  return originFromModelPose(new Vector3().setFromMatrixPosition(forward), new Quaternion().setFromRotationMatrix(forward), new Vector3(), previous, 'rotate');
}

export function compositionError(settings) {
  if (!readModelOrigin(settings?.pose)) return '模型 B 的 XYZ 和 RPY 必须填写有效数值';
  if (!['replace', 'merge'].includes(settings.mode)) return '请选择替换或合并';
  return '';
}

function transformCoordinates(values, matrix, Type = Float32Array, direction = false) {
  const output = new Type(values.length), e = matrix.elements;
  for (let i = 0; i < values.length; i += 3) {
    const x = values[i], y = values[i + 1], z = values[i + 2];
    output[i] = e[0] * x + e[4] * y + e[8] * z + (direction ? 0 : e[12]);
    output[i + 1] = e[1] * x + e[5] * y + e[9] * z + (direction ? 0 : e[13]);
    output[i + 2] = e[2] * x + e[6] * y + e[10] * z + (direction ? 0 : e[14]);
  }
  if (!output.every(Number.isFinite)) throw new Error('变换后的坐标超出可用范围，请减小模型 B 的姿态数值');
  return output;
}

function normalsFor(model) {
  if (model.normals) return model.normals;
  const normals = new Float32Array(model.positions.length);
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  for (let i = 0; i < model.indices.length; i += 3) {
    const ids = model.indices.subarray(i, i + 3);
    a.fromArray(model.positions, ids[0] * 3); b.fromArray(model.positions, ids[1] * 3); c.fromArray(model.positions, ids[2] * 3);
    b.sub(a).cross(c.sub(a));
    for (const id of ids) { normals[id * 3] += b.x; normals[id * 3 + 1] += b.y; normals[id * 3 + 2] += b.z; }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= length; normals[i + 1] /= length; normals[i + 2] /= length;
  }
  return normals;
}

export function joinEditableModels(a, b) {
  const combine = (left, right, fill = 0) => {
    const result = new Float32Array(a.positions.length + b.positions.length);
    if (fill) result.fill(fill);
    if (left) result.set(left);
    if (right) result.set(right, a.positions.length);
    return result;
  };
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices);
  const offset = a.positions.length / 3;
  for (let i = 0; i < b.indices.length; i += 1) indices[a.indices.length + i] = b.indices[i] + offset;
  return {
    positions: combine(a.positions, b.positions), indices,
    colors: a.colors || b.colors ? combine(a.colors, b.colors, 1) : null,
    normals: a.normals || b.normals ? combine(normalsFor(a), normalsFor(b)) : null,
  };
}

export function composeModels(a, b, settings) {
  const error = compositionError(settings);
  if (error) throw new Error(error);
  const localBounds = modelBounds(b), toLocal = modelMatrixFromOrigin(settings.pose), toWorld = toLocal.clone().invert();
  const placedB = { ...b, positions: transformCoordinates(b.positions, toWorld),
    normals: b.normals ? transformCoordinates(b.normals, toWorld, Float32Array, true) : null };
  // Clip in B's local box while emitting vertices in A's original coordinates.
  // This keeps every retained A vertex exact and avoids a lossy round trip.
  const retainedA = settings.mode === 'replace'
    ? cropModel(a, { ...localBounds, mode: 'outside' }, transformCoordinates(a.positions, toLocal, Float64Array)) : a;
  return { model: joinEditableModels(retainedA, placedB), retainedA, localBounds };
}
