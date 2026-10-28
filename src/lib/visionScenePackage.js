import * as THREE from 'three';
import { packIPadModel } from './ipadTeaching.js';
import { buildTeachingTaskTrajectory } from './teachingPlayback.js';
import { normalizeRobotPose, readRobotJointValues, setRobotVisualBounds } from './robotLoader.js';
import { mobileSamplePosition } from './ipadCaptureDisplay.js';
import { polylineGeometryVertices } from './polylineTeaching.js';
import { VISION_SCENE_FORMAT, validateVisionScene } from './visionSceneProtocol.js';
import { heightPalette } from './heightPalette.js';
import { placedObjectLayers, placedObjectMask } from './placedObjectRendering.js';

const identity = () => new THREE.Matrix4().toArray();
const point = (p) => [Number(p?.x) || 0, Number(p?.y) || 0, Number(p?.z) || 0];
// normalizeProject stores navigation coordinates in pose; retain the legacy
// position/plain-point inputs used by older scene callers as well.
const waypointPoint = (waypoint) => point(waypoint.pose || waypoint.position || waypoint);
const poseMatrix = (value) => {
  const p = normalizeRobotPose(value);
  return new THREE.Matrix4().compose(new THREE.Vector3(...point(p.position)),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...['roll', 'pitch', 'yaw'].map((k) => THREE.MathUtils.degToRad(p.rpy[k])), 'ZYX')),
    new THREE.Vector3(1, 1, 1)).toArray();
};

// Spatially tiled, lossless geometry. Every source primitive is assigned once;
// display detail is chosen on the headset, independently of the source package.
export function partitionVisionGeometry(geometry, { tiled = true, primitiveLimit = 60000, start = 0, count, material, vertexColor } = {}) {
  const positions = geometry.getAttribute('position'), colors = geometry.getAttribute('color');
  const index = geometry.getIndex()?.count ? geometry.getIndex() : null;
  const mesh = !!index || !tiled;
  const length = count ?? (mesh ? index?.count || positions.count : positions.count);
  const primitives = mesh ? Math.floor(length / 3) : length;
  // A placed mesh adds an index buffer to a point-cloud map. Vertices outside
  // that index are still the background map, not unused mesh vertices.
  // Robot material groups stay mesh-only and keep their requested range.
  const referenced = tiled && index ? new Uint8Array(positions.count) : null;
  let loosePointCount = 0;
  if (referenced) {
    for (let i = 0; i < index.count; i++) referenced[index.getX(i)] = 1;
    for (const used of referenced) if (!used) loosePointCount++;
  }
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  const grid = tiled ? Math.min(8, Math.max(1, Math.ceil(Math.sqrt((primitives + loosePointCount) / primitiveLimit)))) : 1;
  const buckets = new Map();
  const vertex = (offset) => index ? index.getX(offset) : offset;
  function assign(first, asMesh) {
    let x = 0, y = 0;
    for (let j = 0; j < (asMesh ? 3 : 1); j++) {
      const v = asMesh ? vertex(first + j) : first; x += positions.getX(v); y += positions.getY(v);
    }
    const n = asMesh ? 3 : 1; x /= n; y /= n;
    const gx = Math.min(grid - 1, Math.max(0, Math.floor((x - bounds.min.x) / Math.max(1e-6, bounds.max.x - bounds.min.x) * grid)));
    const gy = Math.min(grid - 1, Math.max(0, Math.floor((y - bounds.min.y) / Math.max(1e-6, bounds.max.y - bounds.min.y) * grid)));
    const key = `${asMesh ? 'mesh' : 'points'}:${gx}:${gy}`;
    if (!buckets.has(key)) buckets.set(key, { mesh: asMesh, items: [] });
    buckets.get(key).items.push(first);
  }
  for (let i = 0; i < primitives; i++) assign(start + i * (mesh ? 3 : 1), mesh);
  if (referenced) for (let i = 0; i < positions.count; i++) if (!referenced[i]) assign(i, false);
  return (function* chunks() {
    for (const { mesh, items } of buckets.values()) for (let offset = 0; offset < items.length; offset += primitiveLimit) {
      const ids = new Map(), xyz = [], rgb = [], indices = [];
      for (const first of items.slice(offset, offset + primitiveLimit)) for (let j = 0; j < (mesh ? 3 : 1); j++) {
        const source = mesh ? vertex(first + j) : first;
        if (!ids.has(source)) {
          ids.set(source, ids.size);
          xyz.push(positions.getX(source), positions.getY(source), positions.getZ(source));
          const displayColor = vertexColor?.(source);
          for (const [axis, channel] of ['r', 'g', 'b'].entries()) {
            rgb.push(displayColor ? displayColor[axis] : (colors ? colors.getComponent(source, axis) : 1) * (material?.color?.[channel] ?? (colors ? 1 : [0.36, 0.82, 0.87][axis])));
          }
        }
        if (mesh) indices.push(ids.get(source));
      }
      const chunk = new THREE.BufferGeometry();
      chunk.setAttribute('position', new THREE.Float32BufferAttribute(xyz, 3));
      chunk.setAttribute('color', new THREE.Float32BufferAttribute(rgb, 3));
      if (mesh) chunk.setIndex(indices);
      yield chunk;
    }
  })();
}

export async function buildVisionScenePackage({ mapData, robotModel, robotDescriptor, robotPose, robotJointValues = {},
  tasks = [], waypoints = [], edges = [], mode = 'map', pointColorMode = 'height', placedObjectColorMode = pointColorMode,
  workspaceTransfer, onAsset = async () => {}, onProgress = () => {}, signal } = {}) {
  if (!mapData?.geometry?.getAttribute('position')?.count) throw new Error('请先打开地图或示教工件');
  const scene = { format: VISION_SCENE_FORMAT, name: mapData.name || '空间工程', coordinateFrame: mode === 'map' ? 'map' : 'virtual_origin',
    sourceHash: mapData.sourceHash || '', createdAt: new Date().toISOString(), assets: [], nodes: [], paths: [], markers: [], clips: [], robotRoot: null,
    appearance: 'vertex-and-material-colors' };
  const assets = new Set(); let nextID = 0;
  const actualJoints = robotModel ? readRobotJointValues(robotModel) : robotJointValues;
  async function meshNode(geometry, options, parent, name, role) {
    for (const chunk of partitionVisionGeometry(geometry, options)) {
      signal?.throwIfAborted();
      try {
        chunk.computeBoundingBox();
        const packed = await packIPadModel({ geometry: chunk, bounds: chunk.boundingBox, name, mapId: mapData.mapId, sourceHash: scene.sourceHash });
        const asset = { ...packed.manifest, id: packed.manifest.modelHash };
        if (!assets.has(asset.id)) { await onAsset(asset, packed.buffer); scene.assets.push(asset); assets.add(asset.id); }
        const material = role === 'part' ? {
          roughness: options.material?.roughness ?? 0.58,
          metallic: options.material?.metalness ?? 0.16,
        } : undefined;
        scene.nodes.push({ id: `node-${nextID++}`, name, role, parent, transform: identity(), asset: asset.id, material });
        onProgress(`已准备 ${scene.assets.length} 块空间资源`);
      } finally { chunk.dispose(); }
    }
  }
  // Web display colors live in its shader, not the source RGB buffer. Bake
  // them into exported map vertices using the full map's height range, before
  // tiling. Keep the original geometry and robot materials untouched.
  const geometry = mapData.geometry, positions = geometry.getAttribute('position'), colors = geometry.getAttribute('color');
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox;
  const layers = mode === 'map' ? placedObjectLayers(mapData, workspaceTransfer) : null;
  const objectMask = layers ? placedObjectMask(positions.count, layers.objectRanges) : null;
  const fallback = new THREE.Color(0x9fc7ca).toArray(), rgb = [0, 0, 0];
  const vertexColor = (vertex) => {
    const colorMode = objectMask?.[vertex] ? placedObjectColorMode : pointColorMode;
    if (colorMode === 'height') return heightPalette(positions.getZ(vertex), min.z, max.z, rgb);
    for (let channel = 0; channel < 3; channel++) {
      rgb[channel] = colorMode === 'white' ? 1 : colors ? colors.getComponent(vertex, channel) : fallback[channel];
    }
    return rgb;
  };
  await meshNode(geometry, { tiled: true, vertexColor }, null, mapData.name || '地图', 'map');
  if (robotModel) {
    scene.robotRoot = 'robot-placement';
    scene.nodes.push({ id: scene.robotRoot, parent: null, role: 'robot', name: robotDescriptor?.name || '机器人', transform: poseMatrix(robotPose) });
    async function visit(object, parent, inheritedName) {
      if (object.userData?.robotCollisionGeometry || object.userData?.urdfType === 'collision') return;
      object.updateMatrix();
      const id = `node-${nextID++}`, data = object.userData;
      const joint = ['revolute', 'continuous', 'prismatic'].includes(data?.jointType) ? {
        name: object.name, type: data.jointType, axis: data.jointAxis, restPosition: data.restPosition,
        restQuaternion: data.restQuaternion, value: actualJoints[object.name] ?? 0,
      } : undefined;
      scene.nodes.push({ id, name: object.name || '机器人部件', role: joint ? 'joint' : 'part', parent, transform: object.matrix.toArray(), joint });
      if (object.isMesh && object.geometry?.getAttribute('position')) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        const groups = object.geometry.groups.length ? object.geometry.groups : [{ start: 0, count: object.geometry.index?.count || object.geometry.getAttribute('position').count, materialIndex: 0 }];
        for (const group of groups) await meshNode(object.geometry, { tiled: false, ...group, material: Array.isArray(object.material) ? materials[group.materialIndex] : object.material }, id, object.name || inheritedName || '机器人外观', 'part');
      }
      for (const child of object.children) await visit(child, id, object.name || inheritedName);
    }
    await visit(robotModel, scene.robotRoot);
    const matching = tasks.filter((task) => !task.robot?.id || task.robot.id === robotDescriptor?.id);
    scene.clips = matching.map((task) => buildTeachingTaskTrajectory({ task, jointDefinitions: robotModel.userData.robot?.movableJoints || [] }))
      .filter((clip) => clip.poseCount > 0 && clip.totalDurationMs > 0);
  }
  const waypointsByID = new Map(waypoints.map((w) => [w.id, w]));
  for (const waypoint of waypoints) scene.markers.push({ id: `waypoint-${waypoint.id}`, name: waypoint.name || '停车点', kind: 'parking', position: waypointPoint(waypoint) });
  for (const edge of edges) {
    const from = waypointsByID.get(edge.from), to = waypointsByID.get(edge.to);
    if (from && to) scene.paths.push({ id: `route-${edge.id || scene.paths.length}`, name: '地图路网', points: [waypointPoint(from), waypointPoint(to)] });
  }
  for (const task of tasks) {
    const positions = [];
    for (const parking of task.parkingPoints || []) {
      const p = point(parking.mapPose?.position); positions.push(p);
      scene.markers.push({ id: `parking-${task.id}-${parking.id}`, name: parking.name || '任务停车点', kind: 'parking', position: p, taskId: task.id });
    }
    if (positions.length > 1) scene.paths.push({ id: `task-${task.id}`, name: task.name || '示教顺序', points: positions });
    let capturePath;
    for (const sample of task.mobileCapture?.samples || []) {
      const position = mobileSamplePosition(sample, task).toArray();
      if (!capturePath || capturePath.segmentId !== sample.segmentId) {
        capturePath = { id: `capture-${task.id}-${scene.paths.length}`, name: task.name || '相机轨迹', segmentId: sample.segmentId, points: [] };
        scene.paths.push(capturePath);
      }
      capturePath.points.push(position);
      if (sample.kind === 'keyframe') scene.markers.push({ id: `pose-${task.id}-${sample.id}`, name: sample.name || '相机视点', kind: 'camera', position, taskId: task.id });
    }
    for (const line of task.polylines || []) if (line.points?.length > 1) scene.paths.push({ id: `line-${task.id}-${line.id}`, name: line.name || '示教路径', points: polylineGeometryVertices(line).map((p) => p.toArray()) });
  }
  mapData.geometry.computeBoundingBox();
  const bounds = mapData.geometry.boundingBox.clone();
  if (robotModel) bounds.union(setRobotVisualBounds(new THREE.Box3(), robotModel).applyMatrix4(new THREE.Matrix4().fromArray(poseMatrix(robotPose))));
  for (const marker of scene.markers) bounds.expandByPoint(new THREE.Vector3(...marker.position));
  for (const path of scene.paths) for (const position of path.points) bounds.expandByPoint(new THREE.Vector3(...position));
  scene.bounds = { min: bounds.min.toArray(), max: bounds.max.toArray() };
  return validateVisionScene(scene);
}
