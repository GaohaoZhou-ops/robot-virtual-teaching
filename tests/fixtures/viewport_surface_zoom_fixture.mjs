import { Box3, Float32BufferAttribute, PlaneGeometry } from 'three';
import { buildExport } from '../../src/features/workspace/model/io.js';
import { identityTransferPose, placeTeachingWorkspace } from '../../src/features/teaching/model/teachingTransfer.js';

function workspace(mode, parts) {
  const positions = [], colors = [], indices = [];
  for (const [geometry, color] of parts) {
    const start = positions.length / 3;
    positions.push(...geometry.attributes.position.array);
    for (let i = 0; i < geometry.attributes.position.count; i += 1) colors.push(...color);
    indices.push(...Array.from(geometry.index.array, (index) => index + start));
    geometry.dispose();
  }
  const position = new Float32BufferAttribute(positions, 3);
  const bounds = new Box3().setFromBufferAttribute(position);
  const map = { geometryCacheVersion: 1, mapId: `surface-zoom-${mode}`, name: `surface-zoom-${mode}.ply`,
    sourceHash: `surface-zoom-${mode}`, sourceHashKind: 'file', teachingSpaceMode: mode,
    pointCount: position.count, faceCount: indices.length / 3, byteLength: position.array.byteLength,
    positionBuffer: position.array.buffer, colorBuffer: new Uint8Array(colors).buffer,
    indexBuffer: new Uint32Array(indices).buffer, indexComponentType: 'uint32',
    bounds: { min: { ...bounds.min }, max: { ...bounds.max } } };
  const project = buildExport({ mapData: map, teachingSpaceMode: mode, heightRange: [-100, 100],
    waypoints: [], edges: [], pointColorMode: 'source', placedObjectColorMode: 'source',
    showHeightLegend3D: false, inspectorCollapsed: true });
  return { mode, map, config: { mapId: map.mapId, config: { schemaVersion: 1, project, ui: project.workspace } } };
}

// Two separated surfaces reproduce depth flicker when the old camera target
// sits in empty space in front of an independently placed workpiece.
export async function viewportSurfaceZoomFixture() {
  const plane = (size, depth, segments = 1) => new PlaneGeometry(size, size, segments, segments)
    .rotateX(Math.PI / 2).translate(0, depth, 0);
  const background = workspace('map', [
    [plane(200, 80), [70, 70, 70]],
    [plane(8.1, 5.0005, 40), [240, 40, 30]],
  ]);
  const foreground = plane(8, 0, 80);
  const positions = foreground.attributes.position;
  for (let i = 0; i < positions.count; i += 1) {
    positions.setY(i, Math.sin(positions.getX(i) * 5) * Math.cos(positions.getZ(i) * 4) * 0.00005);
  }
  const independent = workspace('independent', [[foreground, [30, 100, 240]]]);
  const localToMap = identityTransferPose();
  localToMap.position.y = 5;
  const result = await placeTeachingWorkspace(independent, background, { localToMap });
  result.config.project.view3d = { version: 1,
    position: { x: 0, y: -20, z: 0 }, target: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 }, zoom: 1, projectionOffset: { x: 0, y: 0 } };
  return result;
}
