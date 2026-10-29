import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildVisionScenePackage } from "../src/features/devices/model/visionScenePackage.js";
import { heightPalette } from "../src/features/viewport/model/heightPalette.js";
import { visionSceneFixture } from './vision_scene_fixture.mjs';

const bytes = rgb => rgb.map(value => Math.round(value * 255));
const palette = [
  [0.0176, 0.0685, 0.2159], [0.0212, 0.3916, 0.6308], [0.0908, 0.6514, 0.3325],
  [0.9047, 0.5841, 0.1095], [1, 0.1620, 0.1560],
].map(bytes);
assert.deepEqual(bytes(heightPalette(-1, 0, 4)), palette[0]);
assert.deepEqual(bytes(heightPalette(5, 0, 4)), palette[4]);
assert.deepEqual(bytes(heightPalette(0.5, 0, 4)), bytes([0.0194, 0.23005, 0.42335]));
assert.deepEqual(bytes(heightPalette(10, 10, 10)), palette[0], 'flat maps have a stable color');

async function pack(options) {
  const buffers = new Map();
  const scene = await buildVisionScenePackage({ ...options, onAsset: (asset, buffer) => buffers.set(asset.id, buffer) });
  const vertices = new Map();
  for (const node of scene.nodes.filter(node => node.role === 'map')) {
    const asset = scene.assets.find(asset => asset.id === node.asset), buffer = buffers.get(asset.id);
    const positions = new Float32Array(buffer, 32, asset.vertices * 3);
    const rgba = new Uint8Array(buffer, 32 + asset.vertices * 12, asset.vertices * 4);
    for (let i = 0; i < asset.vertices; i++) vertices.set(positions[i * 3], Array.from(rgba.slice(i * 4, i * 4 + 3)));
  }
  return { scene, buffers, vertices };
}

// Five loose background points plus an appended mesh share the same space.
// Layer membership comes from source vertex ranges, never spatial overlap.
const geometry = new THREE.BufferGeometry();
const heights = [0, 1, 2, 3, 4, 1, 2, 3];
geometry.setAttribute('position', new THREE.Float32BufferAttribute(heights.flatMap((z, x) => [x, 0, z]), 3));
geometry.setAttribute('color', new THREE.Uint8BufferAttribute(heights.flatMap(() => [51, 102, 153]), 3, true));
geometry.setIndex([5, 6, 7]);
const mapData = { geometry, name: '颜色同步', pointCount: heights.length, sourceHash: 'color-fixture' };
const workspaceTransfer = { kind: 'placement', geometryLayers: { version: 1, complete: true,
  pointCount: heights.length, sourceHash: mapData.sourceHash, objectRanges: [{ start: 5, count: 3 }] } };
const original = geometry.attributes.color.array.slice(), originalPositions = geometry.attributes.position.array.slice();
const hashes = new Map();
for (const pointColorMode of ['height', 'source', 'white']) {
  for (const placedObjectColorMode of ['height', 'source', 'white']) {
    const result = await pack({ mapData, workspaceTransfer, pointColorMode, placedObjectColorMode,
      waypoints: [{ id: 'above-map', z: 100 }] });
    assert.equal(result.scene.bounds.max[2], 100, 'scene framing can extend beyond the map height scale');
    assert.equal(result.vertices.size, heights.length);
    for (let i = 0; i < heights.length; i++) {
      const mode = i >= 5 ? placedObjectColorMode : pointColorMode;
      assert.deepEqual(result.vertices.get(i), mode === 'height' ? palette[heights[i]]
        : mode === 'white' ? [255, 255, 255] : [51, 102, 153], `${pointColorMode}/${placedObjectColorMode} vertex ${i}`);
    }
    hashes.set(`${pointColorMode}/${placedObjectColorMode}`, result.scene.assets.map(asset => asset.id).sort().join(','));
  }
}
assert.equal(new Set(hashes.values()).size, 9, 'display changes invalidate content-addressed native color assets');
assert.deepEqual(geometry.attributes.color.array, original, 'display export never overwrites original RGB');
assert.deepEqual(geometry.attributes.position.array, originalPositions);
assert.deepEqual(Array.from(geometry.index.array), [5, 6, 7]);
for (const options of [{ mode: 'independent', workspaceTransfer },
  { workspaceTransfer: { ...workspaceTransfer, geometryLayers: { ...workspaceTransfer.geometryLayers, sourceHash: 'stale' } } }]) {
  const result = await pack({ mapData, pointColorMode: 'height', placedObjectColorMode: 'white', ...options });
  assert.deepEqual(result.vertices.get(5), palette[1], 'only valid map placement layers select the object display mode');
}
geometry.deleteAttribute('color');
assert.deepEqual((await pack({ mapData })).vertices.get(2), palette[2], 'uncolored maps also default to Web height colors');
assert.deepEqual((await pack({ mapData, pointColorMode: 'source' })).vertices.get(2),
  bytes(new THREE.Color(0x9fc7ca).toArray()), 'uncolored source mode matches the Web fallback');
geometry.dispose();

// Default tiling creates two tiles with different local height ranges. Their
// shared boundary must use the whole map's green midpoint, not blue/red ends.
const count = 60001, positions = new Float32Array(count * 3);
for (let i = 0; i < count; i++) { positions[i * 3] = i; positions[i * 3 + 2] = i / 15000; }
const tiled = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3));
const result = await pack({ mapData: { geometry: tiled, name: '分块高程色' } });
assert.ok(result.scene.assets.length > 1); assert.equal(result.vertices.size, count);
for (let i = 0; i < 5; i++) assert.deepEqual(result.vertices.get(i * 15000), palette[i]);
tiled.dispose();

const fixture = visionSceneFixture();
const source = await pack({ ...fixture, pointColorMode: 'source' });
const height = await pack({ ...fixture, pointColorMode: 'height' });
const robotAssets = scene => scene.nodes.filter(node => node.role === 'part' && node.asset).map(node => node.asset);
assert.deepEqual(robotAssets(source.scene), robotAssets(height.scene), 'map display modes never recolor robot materials');
fixture.mapData.geometry.dispose();
fixture.robotModel.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
console.log('Vision scene colors: Web palette, height/source/white, independent object colors, immutable RGB, full-map tile ranges, cache invalidation and robot materials passed.');
