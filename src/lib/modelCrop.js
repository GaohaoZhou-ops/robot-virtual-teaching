const AXES = ['x', 'y', 'z'];
const finite = (value) => value !== '' && value != null && Number.isFinite(Number(value));

export function modelCropError(crop) {
  if (!crop?.enabled) return '';
  if (!AXES.every((axis) => finite(crop.min?.[axis]) && finite(crop.max?.[axis]))) return '请填写完整的裁剪范围';
  if (!AXES.every((axis) => Number(crop.min[axis]) <= Number(crop.max[axis]))) return '裁剪下限不能大于上限';
  if (!['inside', 'outside'].includes(crop.mode || 'inside')) return '请选择取内或取外';
  return '';
}

export function readModelCrop(crop) {
  if (!crop || modelCropError({ ...crop, enabled: true })) return null;
  return { enabled: Boolean(crop.enabled), mode: crop.mode || 'inside',
    ...Object.fromEntries(['min', 'max'].map((edge) => [edge, Object.fromEntries(AXES.map((axis) => [axis, Number(crop[edge][axis])]))])) };
}

export function sameModelCrop(left, right) {
  if (!left?.enabled && !right?.enabled) return true;
  const a = readModelCrop(left), b = readModelCrop(right);
  return Boolean(a && b && JSON.stringify(a) === JSON.stringify(b));
}

// Give planar and linear models a usable six-face enclosure as well.
export function enclosingModelCrop(bounds, previous) {
  const crop = { ...previous, min: { ...bounds.min }, max: { ...bounds.max } };
  const padding = Math.max(...AXES.map((axis) => bounds.max[axis] - bounds.min[axis]), 0.2) * 0.025;
  for (const axis of AXES) if (crop.max[axis] === crop.min[axis]) { crop.min[axis] -= padding; crop.max[axis] += padding; }
  return crop;
}
