import { KEYBOARD_CONTROL_CODES, KEYBOARD_KEY_CODES, AUTO_POINT_BUDGET, DEFAULT_RESOLUTION_INDEX, RESOLUTION_LEVELS } from './viewportConfig.js';
import * as THREE from 'three';
import { MAX_OPTICAL_ZOOM } from "../model/viewportNavigation.js";

export const movementCodeForEvent = (event) =>
  KEYBOARD_CONTROL_CODES.has(event.code)
    ? event.code
    : KEYBOARD_KEY_CODES[String(event.key || '').toLowerCase()] || null;

export const readViewVector = (value) => {
  if (!value) return null;
  const x = Number(Array.isArray(value) ? value[0] : value.x);
  const y = Number(Array.isArray(value) ? value[1] : value.y);
  const z = Number(Array.isArray(value) ? value[2] : value.z);
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
};

export const normalizeCameraView = (value) => {
  if (!value || typeof value !== 'object') return null;
  const position = readViewVector(value.position);
  const target = readViewVector(value.target);
  const up = readViewVector(value.up);
  const zoom = Number(value.zoom);
  const projectionX = Number(value.projectionOffset?.x ?? value.precisionPan?.x ?? 0);
  const projectionY = Number(value.projectionOffset?.y ?? value.precisionPan?.y ?? 0);
  if (
    !position
    || !target
    || !up
    || !Number.isFinite(zoom)
    || zoom <= 0
    || !Number.isFinite(projectionX)
    || !Number.isFinite(projectionY)
  ) {
    return null;
  }
  const viewDistance = Math.hypot(
    position.x - target.x,
    position.y - target.y,
    position.z - target.z,
  );
  if (viewDistance < 1e-12 || Math.hypot(up.x, up.y, up.z) < 1e-12) return null;
  return {
    position,
    target,
    up,
    zoom: THREE.MathUtils.clamp(zoom, 1, MAX_OPTICAL_ZOOM),
    projectionOffset: { x: projectionX, y: projectionY },
  };
};

export const cameraViewSignature = (view) => {
  const normalized = normalizeCameraView(view);
  if (!normalized) return '';
  return [
    normalized.position.x,
    normalized.position.y,
    normalized.position.z,
    normalized.target.x,
    normalized.target.y,
    normalized.target.z,
    normalized.up.x,
    normalized.up.y,
    normalized.up.z,
    normalized.zoom,
    normalized.projectionOffset.x,
    normalized.projectionOffset.y,
  ].map((value) => value.toExponential(12)).join('|');
};

export const adaptiveResolutionIndex = (pointCount) => {
  if (!pointCount || pointCount <= AUTO_POINT_BUDGET) return DEFAULT_RESOLUTION_INDEX;
  for (let index = DEFAULT_RESOLUTION_INDEX - 1; index >= 0; index -= 1) {
    if (Math.round(pointCount * RESOLUTION_LEVELS[index].ratio) <= AUTO_POINT_BUDGET) {
      return index;
    }
  }
  return 0;
};

export const formatPointCount = (count) => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1)}K`;
  return String(count);
};

export const qualityCountFormatter = new Intl.NumberFormat('zh-CN', {
  notation: 'compact', maximumFractionDigits: 2,
});

export const formatHeight = (value) => (Math.abs(value) < 0.005 ? '0.00' : value.toFixed(2));
