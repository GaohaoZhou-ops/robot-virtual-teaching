import { validatePlacedObjectLayers } from "../../viewport/model/placedObjectRendering.js";
import { normalizeTeachingSpaceMode, teachingCoordinateFrame } from "./io.js";
import * as THREE from 'three';

export const normalizeTimestamp = (value) => {
  if (!value) return null;
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

export const GEOMETRY_CACHE_VERSION = 1;

export function serializeBounds(box) {
  return {
    min: { x: box.min.x, y: box.min.y, z: box.min.z },
    max: { x: box.max.x, y: box.max.y, z: box.max.z },
  };
}

export function serializeSphere(sphere) {
  return {
    center: { x: sphere.center.x, y: sphere.center.y, z: sphere.center.z },
    radius: sphere.radius,
  };
}

export function exactArrayBuffer(array) {
  if (array.byteOffset === 0 && array.byteLength === array.buffer.byteLength) return array.buffer;
  return array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength);
}

export function packColorAttribute(attribute) {
  if (!attribute?.array?.length || attribute.itemSize < 3) return null;
  if (
    attribute.array instanceof Uint8Array
    && attribute.itemSize === 3
    && attribute.normalized
  ) {
    return attribute.array;
  }
  const source = attribute.array;
  const packed = new Uint8Array(attribute.count * 3);
  let scale = source.BYTES_PER_ELEMENT === 1 ? 1 : 255;
  if (source.BYTES_PER_ELEMENT !== 1) {
    const sampleLength = Math.min(source.length, 4096);
    for (let index = 0; index < sampleLength; index += 1) {
      if (Math.abs(source[index]) > 1.5) {
        scale = 1;
        break;
      }
    }
  }
  for (let point = 0; point < attribute.count; point += 1) {
    const sourceOffset = point * attribute.itemSize;
    const targetOffset = point * 3;
    packed[targetOffset] = Math.round(Math.max(0, Math.min(255, source[sourceOffset] * scale)));
    packed[targetOffset + 1] = Math.round(
      Math.max(0, Math.min(255, source[sourceOffset + 1] * scale)),
    );
    packed[targetOffset + 2] = Math.round(
      Math.max(0, Math.min(255, source[sourceOffset + 2] * scale)),
    );
  }
  return packed;
}

export function createGeometryCache(
  geometry,
  bounds,
  sourceByteLength,
  sourceHash = null,
  sourceHashKind = 'file',
  sourceDetails = {},
) {
  const positionAttribute = geometry.getAttribute('position');
  const sourcePositions = positionAttribute?.array;
  if (!sourcePositions?.length) throw new Error('无法缓存空点云');
  const positions = sourcePositions instanceof Float32Array
    ? sourcePositions
    : Float32Array.from(sourcePositions);
  const colors = packColorAttribute(geometry.getAttribute('color'));
  const sourceIndex = geometry.getIndex()?.array || null;
  const meshIndices = sourceIndex instanceof Uint16Array || sourceIndex instanceof Uint32Array
    ? sourceIndex
    : sourceIndex?.length ? Uint32Array.from(sourceIndex) : null;
  const sphere = geometry.boundingSphere;
  const geometryLayers = validatePlacedObjectLayers({ pointCount: positionAttribute.count, sourceHash },
    sourceDetails.geometryLayers || geometry.userData.geometryLayers);
  return {
    geometryCacheVersion: GEOMETRY_CACHE_VERSION,
    byteLength: Number(sourceByteLength) || positions.byteLength + (colors?.byteLength || 0),
    pointCount: positionAttribute.count,
    ...(geometryLayers ? { geometryLayers } : {}),
    positionBuffer: exactArrayBuffer(positions),
    colorBuffer: colors ? exactArrayBuffer(colors) : null,
    indexBuffer: meshIndices ? exactArrayBuffer(meshIndices) : null,
    indexComponentType: meshIndices instanceof Uint16Array ? 'uint16' : 'uint32',
    faceCount: meshIndices ? Math.floor(meshIndices.length / 3) : 0,
    bounds,
    sphere: sphere ? serializeSphere(sphere) : null,
    sourceHash,
    sourceHashKind,
    sourceBlob: sourceDetails.sourceBlob instanceof Blob ? sourceDetails.sourceBlob : null,
    fileModifiedAt: normalizeTimestamp(sourceDetails.fileModifiedAt),
    mimeType: String(sourceDetails.mimeType || 'application/octet-stream'),
    loadedAt: normalizeTimestamp(sourceDetails.loadedAt),
    sourceKind: String(sourceDetails.sourceKind || 'unknown'),
    ...(sourceDetails.teachingGroupId ? { teachingGroupId: sourceDetails.teachingGroupId } : {}),
    teachingSpaceMode: normalizeTeachingSpaceMode(sourceDetails.teachingSpaceMode),
    coordinateFrame: teachingCoordinateFrame(sourceDetails.teachingSpaceMode),
  };
}

export function restoreGeometryFromCache(record) {
  if (
    record?.geometryCacheVersion !== GEOMETRY_CACHE_VERSION
    || !(record.positionBuffer instanceof ArrayBuffer)
  ) {
    throw new Error('点云几何缓存版本无效');
  }

  const positions = new Float32Array(record.positionBuffer);
  if (!positions.length || positions.length % 3 !== 0) {
    throw new Error('点云几何缓存坐标无效');
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (record.colorBuffer instanceof ArrayBuffer) {
    const colors = new Uint8Array(record.colorBuffer);
    if (colors.length === positions.length) {
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
    }
  }
  if (record.indexBuffer instanceof ArrayBuffer) {
    const indices = record.indexComponentType === 'uint16'
      ? new Uint16Array(record.indexBuffer)
      : new Uint32Array(record.indexBuffer);
    if (indices.length >= 3) {
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    }
  }

  const cachedBounds = record.bounds;
  if (cachedBounds?.min && cachedBounds?.max) {
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(cachedBounds.min.x, cachedBounds.min.y, cachedBounds.min.z),
      new THREE.Vector3(cachedBounds.max.x, cachedBounds.max.y, cachedBounds.max.z),
    );
  } else {
    geometry.computeBoundingBox();
  }

  if (record.sphere?.center && Number.isFinite(record.sphere.radius)) {
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(
        record.sphere.center.x,
        record.sphere.center.y,
        record.sphere.center.z,
      ),
      record.sphere.radius,
    );
  } else {
    geometry.computeBoundingSphere();
  }
  geometry.userData.geometrySource = 'session-cache';
  const geometryLayers = validatePlacedObjectLayers(record, record.geometryLayers);
  if (geometryLayers) geometry.userData.geometryLayers = geometryLayers;
  return geometry;
}

export function suggestedSlice(positions, bounds) {
  const values = [];
  const count = positions.length / 3;
  const stride = Math.max(1, Math.floor(count / 60000));
  for (let index = 2; index < positions.length; index += stride * 3) {
    const value = positions[index];
    if (Number.isFinite(value)) values.push(value);
  }
  values.sort((a, b) => a - b);
  if (!values.length) return [bounds.min.z, bounds.max.z];
  const at = (ratio) => values[Math.min(values.length - 1, Math.floor(values.length * ratio))];
  const low = at(0.12);
  const high = at(0.72);
  return high > low ? [low, high] : [bounds.min.z, bounds.max.z];
}
