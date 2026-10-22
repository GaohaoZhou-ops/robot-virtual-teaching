import { markTeachingSurfaceCoverageRange } from './visionCoverage.js';

// Match the iPad's fixed, area-stratified sampling budget. Always sample source
// geometry, never the display LOD or just the vertices of a triangle mesh.
export const TEACHING_COVERAGE_SAMPLE_LIMIT = 131_072;

const random = (seed) => {
  let x = seed >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 8) / 16_777_216;
};

export function prepareTeachingCoverageSamples(position, index, sampleLimit = TEACHING_COVERAGE_SAMPLE_LIMIT) {
  const source = position?.array;
  const stride = position?.itemSize || 3;
  const vertexCount = Math.min(position?.count || 0, Math.floor((source?.length || 0) / stride));
  const indices = index?.array;
  const indexCount = Math.min(index?.count ?? indices?.length ?? 0, indices?.length || 0);
  const kind = indexCount ? 'surface' : 'points';
  const limit = Math.max(1, Math.min(TEACHING_COVERAGE_SAMPLE_LIMIT, Math.floor(sampleLimit) || 1));
  const vertexOffset = (vertex) => {
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= vertexCount) {
      throw new Error('覆盖率计算遇到无效的模型索引');
    }
    const offset = vertex * stride;
    if (!Number.isFinite(source[offset]) || !Number.isFinite(source[offset + 1]) || !Number.isFinite(source[offset + 2])) {
      throw new Error('覆盖率计算遇到无效的模型坐标');
    }
    return offset;
  };
  let totalArea = kind === 'surface' ? 0 : null;
  let count = 0;
  let points;
  if (kind === 'surface') {
    const faceCount = Math.floor(indexCount / 3);
    const areas = new Float64Array(faceCount);
    for (let face = 0; face < faceCount; face += 1) {
      const a = vertexOffset(indices[face * 3]);
      const b = vertexOffset(indices[face * 3 + 1]);
      const c = vertexOffset(indices[face * 3 + 2]);
      const ux = source[b] - source[a], uy = source[b + 1] - source[a + 1], uz = source[b + 2] - source[a + 2];
      const vx = source[c] - source[a], vy = source[c + 1] - source[a + 1], vz = source[c + 2] - source[a + 2];
      areas[face] = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) * 0.5;
      totalArea += areas[face];
    }
    if (!Number.isFinite(totalArea)) throw new Error('模型表面积无法计算');
    points = new Float32Array(totalArea > 0 ? limit * 3 : 0);
    const step = totalArea / limit;
    let accumulated = 0;
    for (let face = 0; face < faceCount; face += 1) {
      accumulated += areas[face];
      const a = indices[face * 3] * stride;
      const b = indices[face * 3 + 1] * stride;
      const c = indices[face * 3 + 2] * stride;
      while (areas[face] > 0 && count < limit && (count + 0.5) * step < accumulated) {
        const u = Math.sqrt(random(count + 0x9e3779b9));
        const v = random(count + 0x85ebca6b);
        for (let axis = 0; axis < 3; axis += 1) {
          points[count * 3 + axis] = source[a + axis] * (1 - u)
            + source[b + axis] * u * (1 - v) + source[c + axis] * u * v;
        }
        count += 1;
      }
    }
  } else {
    // A point-only file has no defined surface area; label this separately in UI.
    count = Math.min(vertexCount, limit);
    points = new Float32Array(count * 3);
    for (let sample = 0; sample < count; sample += 1) {
      const offset = vertexOffset(Math.floor(sample * vertexCount / count));
      points.set(source.subarray(offset, offset + 3), sample * 3);
    }
  }
  return { kind, totalArea, position: { array: points, itemSize: 3, count } };
}

export async function measureTeachingCoverage(samples, preparedFrames, { isCancelled = () => false } = {}) {
  const sampleCount = samples.position.count;
  const mask = new Uint8Array(sampleCount);
  const chunkSize = Math.max(128, Math.floor(16_384 / Math.max(1, preparedFrames.length)));
  let coveredSampleCount = 0;
  let lastYield = performance.now();
  for (let start = 0; start < sampleCount && preparedFrames.length; start += chunkSize) {
    if (isCancelled()) return null;
    // The same depth/FOV/range predicate as the visible surface tint. A sample is
    // marked once, even when both arms or several recorded Poses cover it.
    coveredSampleCount += markTeachingSurfaceCoverageRange(
      samples.position, preparedFrames, mask, start, Math.min(sampleCount, start + chunkSize),
    );
    if (performance.now() - lastYield >= 12) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
  if (isCancelled()) return null;
  const fraction = sampleCount ? coveredSampleCount / sampleCount : null;
  return {
    kind: samples.kind,
    status: sampleCount ? 'ready' : 'unavailable',
    sampleCount,
    coveredSampleCount,
    totalArea: samples.totalArea,
    coveredArea: samples.totalArea !== null && fraction !== null ? samples.totalArea * fraction : null,
    fraction,
  };
}
