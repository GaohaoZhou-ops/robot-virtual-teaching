import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { createUniformMeshIndex } from "../../../shared/geometry/mapGeometry.js";
import { modelCropError } from "./modelCrop.js";

const AXES = ['x', 'y', 'z'];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const finite = (value) => value !== '' && value != null && Number.isFinite(Number(value));

// Editor buffers use linear RGB, matching PLYLoader and Three.js materials.
// All operations create new buffers; the imported source remains immutable.
export function parseEditablePly(buffer) {
  const header = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1024 * 1024)));
  assert(/^ply\s/.test(header) && /end_header\s/.test(header), '请选择有效的 PLY 点云或网格文件');
  const geometry = new PLYLoader().parse(buffer);
  try {
    const positions = geometry.getAttribute('position')?.array;
    assert(positions?.length > 0 && positions.length % 3 === 0, '模型中没有可用的顶点');
    assert(positions.every(Number.isFinite), '模型包含无效坐标，请先修复源文件');
    let indices = geometry.index ? new Uint32Array(geometry.index.array) : new Uint32Array();
    const faceHeader = header.split('end_header')[0].match(/element face (\d+)([\s\S]*?)(?=\nelement |$)/);
    if (!indices.length && Number(faceHeader?.[1]) > 0) {
      // PLYLoader expands faces with face colors / UVs to non-indexed triangles.
      assert(/property .* (?:red|diffuse_red|texcoord)\b/.test(faceHeader[2]) && positions.length % 9 === 0,
        '此 PLY 的面格式不受支持，请先转换为三角面或四边面网格');
      indices = Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
    }
    assert(indices.length % 3 === 0 && indices.every((i) => i < positions.length / 3), '模型的面索引无效');
    const colors = geometry.getAttribute('color')?.array || null;
    const normals = geometry.getAttribute('normal')?.array || null;
    for (const attribute of [colors, normals]) {
      assert(!attribute || (attribute.length === positions.length && attribute.every(Number.isFinite)), '模型的颜色或法线数据不完整');
    }
    return { positions, colors, normals, indices };
  } finally { geometry.dispose(); }
}

export function modelBounds(model) {
  if (!model.positions.length) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i < model.positions.length; i += 3) {
    for (let a = 0; a < 3; a += 1) {
      min[AXES[a]] = Math.min(min[AXES[a]], model.positions[i + a]);
      max[AXES[a]] = Math.max(max[AXES[a]], model.positions[i + a]);
    }
  }
  return { min, max };
}

export function modelStats(model) {
  return {
    pointCount: model.positions.length / 3,
    faceCount: model.indices.length / 3,
    hasColors: Boolean(model.colors),
    bounds: modelBounds(model),
    payloadBytes: model.positions.length / 3 * (12 + (model.colors ? 3 : 0) + (model.normals ? 12 : 0)) + model.indices.length / 3 * 13,
  };
}

export function defaultModelEditSettings(model) {
  const bounds = modelBounds(model);
  const span = Math.max(...AXES.map((a) => bounds.max[a] - bounds.min[a]), 0.01);
  return {
    origin: { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 },
    crop: { enabled: false, mode: 'inside', ...bounds },
    reduction: { mode: 'none', voxelSize: Number((span / 100).toPrecision(4)), percentage: 50 },
  };
}

export function validateModelEditSettings(settings, hasMesh = false) {
  assert(['x', 'y', 'z', 'roll', 'pitch', 'yaw'].every((a) => finite(settings.origin?.[a])), 'XYZ 和 RPY 必须填写有效数值');
  const cropError = modelCropError(settings.crop);
  assert(!cropError, cropError);
  const reduction = settings.reduction;
  assert(['none', 'voxel', 'uniform'].includes(reduction?.mode), '请选择有效的降采样方式');
  if (reduction.mode === 'voxel') assert(finite(reduction.voxelSize) && Number(reduction.voxelSize) > 0, '体素尺寸必须大于 0');
  if (reduction.mode === 'uniform') {
    assert(!hasMesh, '网格请使用体素简化，以保留面连接关系');
    assert(finite(reduction.percentage) && Number(reduction.percentage) > 0 && Number(reduction.percentage) <= 100, '保留比例应大于 0 且不超过 100%');
  }
}

export function rebaseModel(model, origin) {
  if (['x', 'y', 'z', 'roll', 'pitch', 'yaw'].every((axis) => Number(origin[axis]) === 0)) return model;
  const matrix = new Matrix4().compose(
    new Vector3(Number(origin.x), Number(origin.y), Number(origin.z)),
    new Quaternion().setFromEuler(new Euler(...['roll', 'pitch', 'yaw'].map((a) => Number(origin[a]) * Math.PI / 180), 'ZYX')),
    new Vector3(1, 1, 1),
  ).invert();
  const e = matrix.elements;
  const positions = new Float32Array(model.positions.length);
  const normals = model.normals ? new Float32Array(model.normals.length) : null;
  for (let i = 0; i < positions.length; i += 3) {
    const x = model.positions[i], y = model.positions[i + 1], z = model.positions[i + 2];
    positions[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    positions[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    positions[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    if (normals) {
      const nx = model.normals[i], ny = model.normals[i + 1], nz = model.normals[i + 2];
      normals[i] = e[0] * nx + e[4] * ny + e[8] * nz;
      normals[i + 1] = e[1] * nx + e[5] * ny + e[9] * nz;
      normals[i + 2] = e[2] * nx + e[6] * ny + e[10] * nz;
    }
  }
  assert(positions.every(Number.isFinite), '变换后的坐标超出可用范围，请减小原点数值');
  return { ...model, positions, normals };
}

class BufferBuilder {
  constructor(Type, capacity = 1024) { this.array = new Type(Math.max(capacity, 16)); this.length = 0; }
  push(...values) {
    if (this.length + values.length > this.array.length) {
      const next = new this.array.constructor(Math.max(this.array.length * 2, this.length + values.length));
      next.set(this.array); this.array = next;
    }
    this.array.set(values, this.length); this.length += values.length;
  }
  finish() { return this.array.slice(0, this.length); }
}

function pickVertices(model, selected, indices = new Uint32Array()) {
  const copy = (values) => {
    if (!values) return null;
    const output = new Float32Array(selected.length * 3);
    for (let i = 0; i < selected.length; i += 1) output.set(values.subarray(selected[i] * 3, selected[i] * 3 + 3), i * 3);
    return output;
  };
  return { positions: copy(model.positions), colors: copy(model.colors), normals: copy(model.normals), indices };
}

// Clip against six box planes. Optional coordinates locate each source vertex
// in an oriented box's frame; output geometry stays in the model's frame.
// New boundary vertices interpolate RGB/normals; cuts remain open (no caps).
export function cropModel(model, bounds, boxCoordinates = model.positions) {
  const lower = AXES.map((a) => Number(bounds.min[a])), upper = AXES.map((a) => Number(bounds.max[a]));
  const outside = bounds.mode === 'outside';
  const inModelFrame = boxCoordinates === model.positions;
  const inside = (id) => {
    const x = boxCoordinates[id * 3], y = boxCoordinates[id * 3 + 1], z = boxCoordinates[id * 3 + 2];
    return x >= lower[0] && x <= upper[0] && y >= lower[1] && y <= upper[1] && z >= lower[2] && z <= upper[2];
  };
  const count = model.positions.length / 3;
  if (!model.indices.length) {
    const selected = new Uint32Array(count);
    let kept = 0;
    for (let i = 0; i < count; i += 1) {
      if (inside(i) !== outside) selected[kept++] = i;
    }
    return pickVertices(model, selected.subarray(0, kept));
  }
  const remap = new Int32Array(count).fill(-1);
  const positions = new BufferBuilder(Float32Array), colors = model.colors ? new BufferBuilder(Float32Array) : null;
  const normals = model.normals ? new BufferBuilder(Float32Array) : null, indices = new BufferBuilder(Uint32Array);
  const readVertex = (i) => {
    const p = Array.from(model.positions.subarray(i * 3, i * 3 + 3));
    return { id: i, p, q: inModelFrame ? p : Array.from(boxCoordinates.subarray(i * 3, i * 3 + 3)),
      c: model.colors ? Array.from(model.colors.subarray(i * 3, i * 3 + 3)) : null,
      n: model.normals ? Array.from(model.normals.subarray(i * 3, i * 3 + 3)) : null };
  };
  const append = (v) => {
    if (v.id >= 0 && remap[v.id] >= 0) return remap[v.id];
    const index = positions.length / 3;
    positions.push(...v.p); if (colors) colors.push(...v.c);
    if (normals) { const length = Math.hypot(...v.n) || 1; normals.push(...v.n.map((n) => n / length)); }
    if (v.id >= 0) remap[v.id] = index;
    return index;
  };
  for (let i = 0; i < count; i += 1) {
    if (inside(i) !== outside) append(readVertex(i));
  }
  const emit = (polygon) => {
    const emitted = [];
    const indexFor = (index) => emitted[index] ?? (emitted[index] = append(polygon[index]));
    for (let i = 1; i < polygon.length - 1; i += 1) {
      const a = polygon[0].p, b = polygon[i].p, c = polygon[i + 1].p;
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) > 0) indices.push(indexFor(0), indexFor(i), indexFor(i + 1));
    }
  };
  for (let f = 0; f < model.indices.length; f += 3) {
    const ids = [model.indices[f], model.indices[f + 1], model.indices[f + 2]];
    if (ids.every(inside)) { if (!outside) indices.push(...ids.map((id) => remap[id])); continue; }
    if ([0, 1, 2].some((a) => ids.every((id) => boxCoordinates[id * 3 + a] < lower[a]) || ids.every((id) => boxCoordinates[id * 3 + a] > upper[a]))) {
      if (outside) indices.push(...ids.map((id) => remap[id]));
      continue;
    }
    let polygon = ids.map(readVertex);
    for (let a = 0; a < 3 && polygon.length; a += 1) {
      for (const [limit, direction] of [[lower[a], 1], [upper[a], -1]]) {
        const clipped = [], removed = [];
        for (let i = 0; i < polygon.length; i += 1) {
          const from = polygon[i], to = polygon[(i + 1) % polygon.length];
          const fromInside = (from.q[a] - limit) * direction >= 0, toInside = (to.q[a] - limit) * direction >= 0;
          if (fromInside) clipped.push(from); else if (outside) removed.push(from);
          if (fromInside !== toInside) {
            const t = (limit - from.q[a]) / (to.q[a] - from.q[a]);
            const interpolate = (left, right) => left?.map((v, j) => v + (right[j] - v) * t) || null;
            const p = interpolate(from.p, to.p);
            const vertex = { id: -1, p, q: inModelFrame ? p : interpolate(from.q, to.q), c: interpolate(from.c, to.c), n: interpolate(from.n, to.n) };
            vertex.q[a] = limit;
            clipped.push(vertex);
            if (outside) removed.push(vertex);
          }
        }
        // Each outside fragment belongs to the first plane it exits. This
        // partitions the complement without overlapping faces or filling holes.
        if (outside) emit(removed);
        polygon = clipped;
      }
    }
    if (!outside) emit(polygon);
  }
  return { positions: positions.finish(), colors: colors?.finish() || null, normals: normals?.finish() || null, indices: indices.finish() };
}

export function voxelReduceModel(model, size) {
  if (!model.positions.length) return model;
  assert(Number.isFinite(size) && size > 0, '体素尺寸必须大于 0');
  const bounds = modelBounds(model), count = model.positions.length / 3;
  assert(AXES.every((a) => (bounds.max[a] - bounds.min[a]) / size < Number.MAX_SAFE_INTEGER), '体素尺寸过小，请增大尺寸');
  const cells = new Map(), remap = new Uint32Array(count), totals = [];
  const positions = [], colors = model.colors ? [] : null, normals = model.normals ? [] : null;
  for (let i = 0; i < count; i += 1) {
    const key = AXES.map((a, j) => Math.floor((model.positions[i * 3 + j] - bounds.min[a]) / size)).join(',');
    let target = cells.get(key);
    if (target === undefined) {
      target = totals.length; cells.set(key, target); totals.push(0);
      positions.push(0, 0, 0); colors?.push(0, 0, 0); normals?.push(0, 0, 0);
    }
    remap[i] = target; totals[target] += 1;
    for (let a = 0; a < 3; a += 1) {
      positions[target * 3 + a] += model.positions[i * 3 + a];
      if (colors) colors[target * 3 + a] += model.colors[i * 3 + a];
      if (normals) normals[target * 3 + a] += model.normals[i * 3 + a];
    }
  }
  for (let i = 0; i < totals.length; i += 1) {
    const normalLength = normals ? Math.hypot(...normals.slice(i * 3, i * 3 + 3)) || 1 : 1;
    for (let a = 0; a < 3; a += 1) {
      positions[i * 3 + a] /= totals[i];
      if (colors) colors[i * 3 + a] /= totals[i];
      if (normals) normals[i * 3 + a] /= normalLength;
    }
  }
  const indices = new BufferBuilder(Uint32Array), uniqueFaces = new Set();
  const referenced = new Uint8Array(count), used = new Uint8Array(totals.length);
  for (let f = 0; f < model.indices.length; f += 3) {
    const a = remap[model.indices[f]], b = remap[model.indices[f + 1]], c = remap[model.indices[f + 2]];
    referenced[model.indices[f]] = referenced[model.indices[f + 1]] = referenced[model.indices[f + 2]] = 1;
    if (a === b || b === c || a === c) continue;
    const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) === 0) continue;
    const key = [a, b, c].sort((left, right) => left - right).join(',');
    if (uniqueFaces.has(key)) continue;
    uniqueFaces.add(key); indices.push(a, b, c); used[a] = used[b] = used[c] = 1;
  }
  assert(!model.indices.length || indices.length, '体素尺寸过大，全部三角面已退化；请减小体素尺寸');
  for (let i = 0; i < count; i += 1) if (!referenced[i]) used[remap[i]] = 1;
  const selected = [], compact = new Uint32Array(totals.length);
  for (let i = 0; i < totals.length; i += 1) if (used[i]) { compact[i] = selected.length; selected.push(i); }
  return pickVertices({ positions: new Float32Array(positions), colors: colors ? new Float32Array(colors) : null,
    normals: normals ? new Float32Array(normals) : null }, selected, indices.finish().map((i) => compact[i]));
}

export function editModel(source, settings) {
  validateModelEditSettings(settings, source.indices.length > 0);
  let result = rebaseModel(source, settings.origin);
  const transformedBounds = modelBounds(result);
  if (settings.crop.enabled) {
    const enclosesModel = AXES.every((a) => Number(settings.crop.min[a]) <= transformedBounds.min[a] && Number(settings.crop.max[a]) >= transformedBounds.max[a]);
    if (settings.crop.mode === 'outside' && enclosesModel) result = pickVertices(result, new Uint32Array());
    else if (!enclosesModel) result = cropModel(result, settings.crop);
  }
  if (settings.reduction.mode === 'voxel') result = voxelReduceModel(result, Number(settings.reduction.voxelSize));
  if (settings.reduction.mode === 'uniform' && result.positions.length) {
    const count = result.positions.length / 3;
    const target = Math.max(1, Math.floor(count * Number(settings.reduction.percentage) / 100));
    result = pickVertices(result, Uint32Array.from({ length: target }, (_, i) => Math.floor(i * count / target)));
  }
  return { model: result, transformedBounds };
}

// Only the display is capped. Editing statistics and PLY export use all data.
export function modelPreview(model, pointBudget = 160000, faceBudget = 180000) {
  const count = model.positions.length / 3, referenced = new Uint8Array(count);
  for (const i of model.indices) referenced[i] = 1;
  let looseCount = 0;
  for (const used of referenced) if (!used) looseCount += 1;
  const stride = Math.max(1, Math.ceil(looseCount / pointBudget));
  const selected = [], pointIndices = [], remap = new Int32Array(count).fill(-1);
  const add = (i) => { if (remap[i] < 0) { remap[i] = selected.length; selected.push(i); } return remap[i]; };
  let seen = 0;
  for (let i = 0; i < count; i += 1) if (!referenced[i] && seen++ % stride === 0) pointIndices.push(add(i));
  const sourceIndices = createUniformMeshIndex(model.indices, Math.min(model.indices.length / 3, faceBudget));
  const indices = Uint32Array.from(sourceIndices, add);
  return { ...pickVertices(model, selected, indices), pointIndices: new Uint32Array(pointIndices), bounds: modelBounds(model),
    limited: looseCount > pointIndices.length || sourceIndices.length < model.indices.length };
}

export function encodeModelPly(model) {
  const count = model.positions.length / 3, faceCount = model.indices.length / 3;
  assert(count > 0, '编辑结果为空，请调整裁剪范围');
  const header = new TextEncoder().encode([
    'ply', 'format binary_little_endian 1.0', 'comment Virtual Teaching Platform model editor',
    `element vertex ${count}`, 'property float x', 'property float y', 'property float z',
    ...(model.normals ? ['property float nx', 'property float ny', 'property float nz'] : []),
    ...(model.colors ? ['property uchar red', 'property uchar green', 'property uchar blue'] : []),
    ...(faceCount ? [`element face ${faceCount}`, 'property list uchar int vertex_indices'] : []), 'end_header', '',
  ].join('\n'));
  const buffer = new ArrayBuffer(header.length + count * (12 + (model.normals ? 12 : 0) + (model.colors ? 3 : 0)) + faceCount * 13);
  new Uint8Array(buffer).set(header);
  const view = new DataView(buffer);
  let offset = header.length;
  const srgb = (v) => Math.round(Math.max(0, Math.min(1, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)) * 255);
  for (let i = 0; i < count; i += 1) {
    for (const values of [model.positions, model.normals]) if (values) {
      for (let a = 0; a < 3; a += 1) { view.setFloat32(offset, values[i * 3 + a], true); offset += 4; }
    }
    if (model.colors) for (let a = 0; a < 3; a += 1) view.setUint8(offset++, srgb(model.colors[i * 3 + a]));
  }
  for (let i = 0; i < model.indices.length; i += 3) {
    view.setUint8(offset++, 3);
    for (let a = 0; a < 3; a += 1) { view.setInt32(offset, model.indices[i + a], true); offset += 4; }
  }
  return buffer;
}
