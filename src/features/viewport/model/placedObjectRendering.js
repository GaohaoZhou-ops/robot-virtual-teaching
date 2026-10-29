import { Euler, Matrix4, MathUtils, Quaternion, Vector3 } from 'three';

// Vertex ranges describe appended objects, never spatial bounding boxes: a
// workpiece may overlap the original scan without changing the scan's colors.
export function validatePlacedObjectLayers(map, layers) {
  const count = map?.pointCount ?? map?.positions?.length / 3;
  if (layers?.version !== 1
    || layers.pointCount !== count || layers.sourceHash !== map?.sourceHash
    || !Array.isArray(layers.objectRanges)) return null;
  let end = 0;
  for (const range of layers.objectRanges) {
    if (!Number.isSafeInteger(range?.start) || !Number.isSafeInteger(range?.count)
      || range.start < end || range.count <= 0 || range.start + range.count > count) return null;
    end = range.start + range.count;
  }
  return layers;
}

export function placedObjectLayers(map, transfer) {
  // Display groups also travel with portable geometry. They do not require a
  // binding to another device's independent workspace or original source files.
  return validatePlacedObjectLayers(map, transfer?.kind === 'placement' ? transfer.geometryLayers : null)
    || validatePlacedObjectLayers(map, map?.geometryLayers)
    || validatePlacedObjectLayers(map, map?.geometry?.userData?.geometryLayers);
}

export function appendPlacedObjectLayers(map, background, transfer, objectPointCount) {
  const previous = placedObjectLayers(background, transfer);
  return {
    version: 1, pointCount: map.pointCount, sourceHash: map.sourceHash,
    complete: previous ? previous.complete === true : transfer?.kind !== 'placement',
    objectRanges: [...(previous?.objectRanges || []), { start: background.pointCount, count: objectPointCount }],
  };
}

export function placedObjectMask(pointCount, ranges) {
  const mask = new Uint8Array(pointCount);
  for (const { start, count } of ranges) mask.fill(1, start, start + count);
  return mask;
}

export function matchesPlacedSource(expected, actual) {
  if (!expected || !actual) return false;
  if (expected.teachingGroupId && actual.teachingGroupId !== expected.teachingGroupId) return false;
  return expected.sourceHash && actual.sourceHash
    ? expected.sourceHash === actual.sourceHash : expected.mapId === actual.mapId;
}

const positionsOf = (map) => map?.positions || (map?.positionBuffer instanceof ArrayBuffer
  ? new Float32Array(map.positionBuffer) : null);

// Old project files did not record vertex ranges. Recover only verified appended
// blocks from their source objects, one object at a time to limit peak memory.
export async function recoverPlacedObjectLayers(map, transfer, loadSource, isCurrent = () => true) {
  const previous = placedObjectLayers(map, transfer);
  if (previous?.complete || transfer?.kind !== 'placement') return previous;
  const positions = positionsOf(map);
  if (!positions?.length) return previous;
  const placements = [transfer, ...(transfer.previousPlacements || [])];
  const recovered = [];
  let cursor = positions.length / 3;
  for (const placement of placements) {
    if (!isCurrent()) return previous;
    const source = await loadSource(placement.sourceMap);
    if (!isCurrent()) return previous;
    const local = positionsOf(source);
    if (!local?.length || !matchesPlacedSource(placement.sourceMap, source)) break;
    const count = local.length / 3, start = cursor - count;
    if (!Number.isSafeInteger(count) || start < 0) break;
    const pose = placement.localToMap;
    const matrix = new Matrix4().compose(new Vector3(pose.position.x, pose.position.y, pose.position.z),
      new Quaternion().setFromEuler(new Euler(...['roll', 'pitch', 'yaw'].map(
        (axis) => MathUtils.degToRad(pose.rpy[axis])), 'ZYX')), new Vector3(1, 1, 1));
    const point = new Vector3();
    let matches = true;
    for (let offset = 0; offset < local.length; offset += 3) {
      point.fromArray(local, offset).applyMatrix4(matrix);
      // Placement writes Float32 coordinates. Compare the serialized result,
      // rather than accepting nearby but unrelated map surfaces.
      const target = start * 3 + offset;
      matches = Math.fround(point.x) === positions[target]
        && Math.fround(point.y) === positions[target + 1]
        && Math.fround(point.z) === positions[target + 2];
      if (!matches) break;
      if (offset && offset % 750000 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!isCurrent()) return previous;
      }
    }
    if (!matches) break;
    recovered.unshift({ start, count });
    cursor = start;
  }
  const ranges = [...(previous?.objectRanges || []), ...recovered]
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.start + last.count) {
      last.count = Math.max(last.start + last.count, range.start + range.count) - last.start;
    } else merged.push({ ...range });
  }
  return { version: 1, pointCount: map.pointCount, sourceHash: map.sourceHash,
    complete: recovered.length === placements.length
      && (!transfer.mapFrameSources || transfer.mapFrameSources.length <= placements.length),
    objectRanges: merged };
}
