import { isSuspectedRobotDetection } from './robotTwinInspection.js';

export const ROBOT_CAPTURE_POINT_BUDGET = 300_000;

// ABX's organized XYZ cache: 8-byte magic, uint32 width/height, then XYZ float32
// millimetres (little-endian). Sampling is for display, never an exported cloud.
export function parseRobotTwinPointCloud(buffer, budget = ROBOT_CAPTURE_POINT_BUDGET) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 16) throw new Error('点云文件不完整');
  const view = new DataView(buffer);
  if (new TextDecoder().decode(new Uint8Array(buffer, 0, 8)) !== 'ABXXYZ1\0') throw new Error('不支持的点云文件格式');
  const width = view.getUint32(8, true), height = view.getUint32(12, true), total = width * height;
  if (!width || !height || total > 10_000_000 || buffer.byteLength !== 16 + total * 12) throw new Error('点云尺寸或长度无效');
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > ROBOT_CAPTURE_POINT_BUDGET) throw new Error('点云显示预算无效');
  const stride = Math.max(1, Math.ceil(total / budget)), positions = new Float32Array(Math.min(total, budget) * 3);
  const pixels = new Uint32Array(Math.min(total, budget));
  let valid = 0, count = 0, minZ = Infinity, maxZ = -Infinity;
  for (let index = 0; index < total; index++) {
    const offset = 16 + index * 12;
    const x = view.getFloat32(offset, true) * 0.001, y = view.getFloat32(offset + 4, true) * 0.001, z = view.getFloat32(offset + 8, true) * 0.001;
    if (![x, y, z].every(Number.isFinite)) continue;
    if (valid++ % stride) continue;
    // Optical Y-down/Z-forward to the Three.js viewer's Y-up/-Z-forward frame.
    positions.set([x, -y, -z], count * 3);
    // Keep the sensor-grid index before filtering or sampling. A compacted
    // vertex index no longer identifies the corresponding image pixel.
    pixels[count] = index; count++;
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  if (!count) throw new Error('本次点云没有有效的三维点');
  const colors = new Uint8Array(count * 3), span = Math.max(maxZ - minZ, 0.0001);
  for (let i = 0; i < count; i++) {
    const depth = (-positions[i * 3 + 2] - minZ) / span;
    colors.set([70 + depth * 80, 220 - depth * 65, 190 + depth * 50], i * 3);
  }
  return { positions: positions.slice(0, count * 3), pixels: pixels.slice(0, count), colors, count, valid, width, height };
}

export function colorRobotTwinPointCloud(cloud, inspection) {
  const unchanged = { colors: cloud.colors, highlighted: 0, confirmedPoints: 0, suspectedPoints: 0, warning: '' };
  if (inspection?.state !== 'complete' || !inspection.abnormal) return unchanged;
  const mapping = inspection.pixelMapping, boxes = inspection.boxes;
  if (!mapping?.available) return { ...unchanged, warning: '缺少图像与点云映射，暂不能标注异常区域' };
  // Match ABX's certified organized-pixels mapping; size ratios alone do not
  // establish RGB/XYZ registration. Native captures use step 1, mocks step 2.
  if (mapping.kind !== 'organized-pixels' || mapping.cloud_width !== cloud.width || mapping.cloud_height !== cloud.height
    || mapping.image_width !== inspection.imageWidth || mapping.image_height !== inspection.imageHeight
    || ![1, 2].includes(mapping.step_x) || mapping.step_y !== mapping.step_x || mapping.offset_x !== 0 || mapping.offset_y !== 0
    || cloud.width * mapping.step_x !== mapping.image_width || cloud.height * mapping.step_y !== mapping.image_height
    || !(cloud.pixels instanceof Uint32Array) || cloud.pixels.length !== cloud.count
    || !Array.isArray(boxes) || !boxes.length || boxes.length > 32 || boxes.some((box) => !box
      || ![box.x, box.y, box.width, box.height].every(Number.isInteger) || box.x < 0 || box.y < 0 || box.width < 1 || box.height < 1
      || box.x + box.width > mapping.image_width || box.y + box.height > mapping.image_height)) {
    return { ...unchanged, warning: '异常区域与点云映射不匹配，暂不能着色' };
  }
  const colors = new Uint8Array(cloud.colors);
  const regions = boxes.map((box) => ({ ...box, level: isSuspectedRobotDetection(box) ? 1 : 2 }));
  let confirmedPoints = 0, suspectedPoints = 0;
  for (let i = 0; i < cloud.count; i++) {
    const index = cloud.pixels[i], u = (index % cloud.width) * mapping.step_x, v = Math.floor(index / cloud.width) * mapping.step_y;
    let level = 0;
    for (const box of regions) {
      if (u >= box.x && u < box.x + box.width && v >= box.y && v < box.y + box.height) {
        level = Math.max(level, box.level);
        if (level === 2) break; // Confirmed regions win regardless of box order.
      }
    }
    if (level === 2) { colors.set([255, 32, 32], i * 3); confirmedPoints++; }
    else if (level === 1) { colors.set([250, 204, 21], i * 3); suspectedPoints++; }
  }
  return { colors, highlighted: confirmedPoints + suspectedPoints, confirmedPoints, suspectedPoints, warning: '' };
}
