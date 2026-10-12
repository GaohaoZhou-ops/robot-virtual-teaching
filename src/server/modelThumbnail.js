import { PNG } from 'pngjs';
import { validateModelBytes } from '../lib/ipadProtocol.js';

// A bounded, orthographic preview of the frozen ATLS file. Large meshes use
// sampled source points so a preview never needs a GPU or a second full mesh.
export async function modelThumbnail(data) {
  const { vertices, indices } = validateModelBytes(data);
  const width = 384, height = 256;
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) png.data.set([10, 19, 22, 255], i * 4);
  const depth = new Float64Array(width * height).fill(-Infinity);
  const lower = [Infinity, Infinity, Infinity], upper = [-Infinity, -Infinity, -Infinity];
  const position = (i) => [0, 1, 2].map(axis => data.readFloatLE(32 + i * 12 + axis * 4));
  for (let i = 0; i < vertices; i++) {
    const p = position(i);
    for (let axis = 0; axis < 3; axis++) {
      lower[axis] = Math.min(lower[axis], p[axis]); upper[axis] = Math.max(upper[axis], p[axis]);
    }
    if (i % 100000 === 99999) await new Promise(resolve => setImmediate(resolve));
  }
  const center = lower.map((value, axis) => (value + upper[axis]) / 2);
  const normalize = v => { const length = Math.hypot(...v); return v.map(value => value / length); };
  const forward = normalize([1.2, -1.8, 1.1]), right = normalize([1.8, 1.2, 0]);
  const up = [forward[1] * right[2] - forward[2] * right[1],
    forward[2] * right[0] - forward[0] * right[2], forward[0] * right[1] - forward[1] * right[0]];
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  let halfWidth = 0.005, halfHeight = 0.005;
  for (const x of [lower[0], upper[0]]) for (const y of [lower[1], upper[1]]) for (const z of [lower[2], upper[2]]) {
    const p = [x, y, z].map((value, i) => value - center[i]);
    halfWidth = Math.max(halfWidth, Math.abs(dot(p, right))); halfHeight = Math.max(halfHeight, Math.abs(dot(p, up)));
  }
  const scale = Math.min(width / (2 * halfWidth), height / (2 * halfHeight)) * 0.84;
  const project = i => {
    const p = position(i).map((value, axis) => value - center[axis]);
    return [width / 2 + dot(p, right) * scale, height / 2 - dot(p, up) * scale, dot(p, forward)];
  };
  const color = i => [0, 1, 2].map(channel => 255 * (data[32 + vertices * 12 + i * 4 + channel] / 255) ** (1 / 2.2));
  const pixel = (x, y, z, rgb) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = y * width + x;
    if (z < depth[offset]) return;
    depth[offset] = z;
    for (let channel = 0; channel < 3; channel++) png.data[offset * 4 + channel] = Math.round(rgb[channel]);
  };
  // Keep raster work bounded even for meshes containing many overlapping faces.
  let budget = 8_000_000;
  if (indices > 0 && indices / 3 <= 20000) {
    const edge = (a, b, x, y) => (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0]);
    for (let face = 0; face < indices / 3 && budget > 0; face++) {
      const ids = [0, 1, 2].map(k => data.readUInt32LE(32 + vertices * 16 + (face * 3 + k) * 4));
      const [a, b, c] = ids.map(project), area = edge(a, b, c[0], c[1]);
      if (Math.abs(area) < 0.001) continue;
      const points = ids.map(position), ab = points[1].map((v, i) => v - points[0][i]), ac = points[2].map((v, i) => v - points[0][i]);
      const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const light = 0.45 + 0.55 * Math.abs(dot(normalize(normal), normalize([0.4, -0.5, 1])));
      const colors = ids.map(color), rgb = [0, 1, 2].map(k => colors.reduce((sum, v) => sum + v[k], 0) / 3 * light);
      const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
      const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      for (let y = minY; y <= maxY && budget > 0; y++) for (let x = minX; x <= maxX && budget-- > 0; x++) {
        const wa = edge(b, c, x + 0.5, y + 0.5) / area, wb = edge(c, a, x + 0.5, y + 0.5) / area, wc = 1 - wa - wb;
        if (wa >= 0 && wb >= 0 && wc >= 0) pixel(x, y, wa * a[2] + wb * b[2] + wc * c[2], rgb);
      }
      if (face % 500 === 499) await new Promise(resolve => setImmediate(resolve));
    }
  } else {
    const count = Math.min(vertices, 80000);
    for (let i = 0; i < count; i++) {
      const source = Math.floor(i * vertices / count), [x, y, z] = project(source), rgb = color(source);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) pixel(Math.round(x) + dx, Math.round(y) + dy, z, rgb);
    }
  }
  return PNG.sync.write(png);
}
