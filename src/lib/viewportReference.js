import * as THREE from 'three';

// Display helpers only: keep this floor out of the source geometry used for
// picking, collision checks, exports and coordinate conversions.
export function createIndependentGround(bounds) {
  const extent = Math.max(20, Math.ceil(Math.max(
    Math.abs(bounds.min.x),
    Math.abs(bounds.max.x),
    Math.abs(bounds.min.y),
    Math.abs(bounds.max.y),
  )) + 5);
  const size = extent * 2;
  const ground = new THREE.Group();
  ground.name = 'virtual-origin-reference-plane';
  ground.userData.gridSpacing = 1;
  ground.userData.size = size;

  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({
      color: 0x173039,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
  );
  surface.name = 'virtual-ground-surface';
  surface.renderOrder = -2;
  ground.add(surface);

  // Integer extents keep the origin on a grid intersection, with exactly 1 m
  // between lines, regardless of the loaded model's size.
  const grid = new THREE.GridHelper(size, size, 0x59858d, 0x365761);
  grid.name = 'virtual-ground-meter-grid';
  grid.rotation.x = Math.PI / 2;
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  grid.material.depthWrite = false;
  grid.renderOrder = -1;
  ground.add(grid);
  return ground;
}

function formatScaleDistance(meters) {
  const units = [
    [1000, 'km'],
    [1, 'm'],
    [0.01, 'cm'],
    [0.001, 'mm'],
    [0.000001, 'µm'],
  ];
  const unit = units.find(([size]) => meters >= size);
  return unit
    ? `${Number((meters / unit[0]).toPrecision(3))} ${unit[1]}`
    : `${meters.toExponential(0)} m`;
}

// A perspective view has no single scale for all depths. The caller supplies
// meters per CSS pixel at the orbit target's depth, including optical zoom.
export function viewportDistanceScale(metersPerPixel, maxWidth = 120) {
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0
    || !Number.isFinite(maxWidth) || maxWidth <= 0) return null;
  const maxDistance = metersPerPixel * maxWidth;
  if (!Number.isFinite(maxDistance) || maxDistance <= 0) return null;
  const magnitude = 10 ** Math.floor(Math.log10(maxDistance));
  if (!Number.isFinite(magnitude) || magnitude <= 0) return null;
  const normalized = maxDistance / magnitude;
  const step = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
  const meters = step * magnitude;
  return {
    meters,
    pixels: meters / metersPerPixel,
    label: formatScaleDistance(meters),
  };
}
