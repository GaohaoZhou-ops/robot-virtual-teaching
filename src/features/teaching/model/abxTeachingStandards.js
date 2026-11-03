import { sha256Bytes } from '../../../shared/utils/hash.js';
import { abxAssert as check, abxBytes } from './abxFormat.js';

// ABXBrainSystem: teaching_export.py, teaching-import.js and
// teaching_references.py. Assets are optional, independently selectable and
// associated by immutable standard_images IDs, not by task/step array indices.
const MAX_IMAGE_BYTES = 32 * 1024 ** 2;
const MAX_CLOUD_POINTS = 10_000_000;
const PNG_HEADER = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
const sides = ['left', 'right'];
const jsonBytes = (value) => abxBytes(`${JSON.stringify(value, null, 2)}\n`);
const imagePresent = (frame) => Boolean(frame?.rgb?.dataUrl);
const cloudPresent = (frame) => Boolean(frame?.pointCloud?.positionData && frame.pointCloud.pointCount > 0);

export function teachingStandardAvailability(payload) {
  let poseCount = 0, imageCount = 0, cloudCount = 0;
  for (const task of payload.virtualTeaching?.tasks || []) {
    for (const parking of task.parkingPoints || []) {
      for (const pose of parking.poses || []) {
        poseCount += 1;
        for (const side of sides) {
          const frame = pose.cameraCapture?.frames?.[side];
          imageCount += Number(imagePresent(frame));
          cloudCount += Number(cloudPresent(frame));
        }
      }
    }
  }
  return { poseCount, imageCount, cloudCount,
    missingImages: poseCount * 2 - imageCount, missingClouds: poseCount * 2 - cloudCount };
}

function decodeBase64(value, maximum, label) {
  check(typeof value === 'string' && value.length <= Math.ceil(maximum / 3) * 4
    && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
  `${label}的 Base64 数据无效或过大`);
  const decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  check(decoded.length <= maximum, `${label}超过大小上限`);
  return decoded;
}

function pngSize(data) {
  check(data.length >= 33 && data.length <= MAX_IMAGE_BYTES
    && PNG_HEADER.every((value, index) => data[index] === value), '标准图 PNG 文件无效');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  check(width > 0 && width <= 8192 && height > 0 && height <= 8192, '标准图尺寸须在 1–8192 像素内');
  return { width, height };
}

// Captures may be WebP (the workbench default) or JPEG. Convert pixels to PNG;
// changing the extension alone would be rejected by the robot's PNG validator.
export async function teachingImagePng(image, { signal } = {}) {
  signal?.throwIfAborted();
  const match = /^data:(image\/(?:png|webp|jpeg));base64,([\s\S]+)$/.exec(image?.dataUrl || '');
  check(match, '标准图缺少可读取的 PNG / WebP / JPEG 图像');
  const data = decodeBase64(match[2], MAX_IMAGE_BYTES, '标准图');
  if (match[1] === 'image/png') { pngSize(data); return data; }
  check(typeof document !== 'undefined' || typeof OffscreenCanvas !== 'undefined', '请在浏览器中将采集图像转换为标准 PNG');
  const blob = new Blob([data], { type: match[1] });
  let bitmap, url, canvas;
  try {
    if (typeof createImageBitmap === 'function') bitmap = await createImageBitmap(blob);
    else {
      url = URL.createObjectURL(blob);
      bitmap = new Image();
      bitmap.src = url;
      await bitmap.decode();
    }
    signal?.throwIfAborted();
    const { width, height } = bitmap;
    check(width > 0 && width <= 8192 && height > 0 && height <= 8192, '标准图尺寸须在 1–8192 像素内');
    canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    check(context, '无法创建标准图转换画布');
    context.drawImage(bitmap, 0, 0);
    const png = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    check(png, '标准图 PNG 转换失败');
    const result = new Uint8Array(await png.arrayBuffer());
    signal?.throwIfAborted();
    pngSize(result);
    return result;
  } finally {
    bitmap?.close?.();
    if (url) URL.revokeObjectURL(url);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

export function teachingCloudXyzbin(cloud) {
  const count = cloud?.pointCount;
  check(Number.isSafeInteger(count) && count > 0 && count <= MAX_CLOUD_POINTS, '标准点云点数无效或超过 1000 万点');
  check(cloud.positionEncoding === 'uint16-le/base64'
    && cloud.convention === 'x-right/y-down/z-forward'
    && JSON.stringify(cloud.positionComponents) === '["x","y","z"]', '标准点云编码或相机光学坐标约定不受支持');
  const offset = cloud.positionOffset, scale = cloud.positionScale;
  check(Array.isArray(offset) && offset.length === 3 && offset.every(Number.isFinite)
    && Array.isArray(scale) && scale.length === 3 && scale.every((value) => Number.isFinite(value) && value >= 0),
  '标准点云量化偏移或比例无效');
  const source = decodeBase64(cloud.positionData, count * 6, '标准点云');
  check(source.length === count * 6, '标准点云数据长度与点数不一致');
  const packed = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const result = new Uint8Array(16 + count * 12), view = new DataView(result.buffer);
  result.set(abxBytes('ABXXYZ1\0'));
  // The virtual capture is an unorganized sample, not an image-sized depth map.
  view.setUint32(8, count, true); view.setUint32(12, 1, true);
  for (let index = 0; index < count * 3; index += 1) {
    const axis = index % 3;
    const millimeters = (offset[axis] + packed.getUint16(index * 2, true) * scale[axis]) * 1000;
    check(Number.isFinite(Math.fround(millimeters)), '标准点云坐标超出 float32 范围');
    view.setFloat32(16 + index * 4, millimeters, true);
  }
  return result;
}

export async function appendAbxTeachingStandards(archive, payload, {
  includeStandards = false, includeClouds = false, signal, onProgress,
} = {}) {
  if (!includeStandards && !includeClouds) return archive;
  signal?.throwIfAborted();
  const availability = teachingStandardAvailability(payload);
  check((includeStandards ? availability.imageCount : 0) + (includeClouds ? availability.cloudCount : 0) <= 20000,
    '标准资源超过 20000 个文件，请分批导出');
  const files = { ...archive.files };
  const read = (name) => JSON.parse(new TextDecoder().decode(files[name]));
  const manifest = read('manifest.json'), mapping = read('source-mapping.json');
  const tasks = new Map((payload.virtualTeaching?.tasks || []).map((task) => [task.id, task]));
  const standards = [], clouds = [], references = [];
  let completed = 0;
  for (const mapped of mapping.tasks) {
    signal?.throwIfAborted();
    const task = tasks.get(mapped.sourceId);
    check(task, '标准资源对应的源任务缺失');
    const lines = new TextDecoder().decode(files[mapped.file]).trimEnd().split('\n');
    const points = new Map(lines.slice(1, -1).map((raw, index) => [JSON.parse(raw), index + 1])
      .filter(([row]) => row.type === 'point').map(([row, index]) => [row.seq, { row, index }]));
    const poseSequences = new Map((mapped.parkings || []).flatMap((parking) =>
      parking.poses.map((pose) => [JSON.stringify([parking.sourceId, pose.sourceId]), pose.seq])));
    let changed = false;
    for (const parking of task.parkingPoints || []) {
      for (const pose of parking.poses || []) {
        signal?.throwIfAborted();
        onProgress?.({ completed, total: availability.poseCount, label: `${task.name} / ${parking.name} / ${pose.name}` });
        const assets = [];
        for (const side of sides) {
          const frame = pose.cameraCapture?.frames?.[side];
          const camera = `zivid:${side}`;
          try {
            if (includeStandards && imagePresent(frame)) {
              const data = await teachingImagePng(frame.rgb, { signal });
              assets.push({ camera, kind: 'png', data, sha256: await sha256Bytes(data) });
            }
            if (includeClouds && cloudPresent(frame)) {
              const data = teachingCloudXyzbin(frame.pointCloud);
              assets.push({ camera, kind: 'xyzbin', data, sha256: await sha256Bytes(data) });
            }
          } catch (error) {
            signal?.throwIfAborted();
            throw new Error(`${task.name} / ${parking.name} / ${pose.name} · ${side === 'left' ? '左' : '右'}相机：${error.message}`);
          }
        }
        completed += 1;
        if (!assets.length) continue;
        const point = points.get(poseSequences.get(JSON.stringify([parking.id, pose.id])) || pose.abx?.pointSeq);
        check(point?.row.record?.joints_rad, `姿态「${pose.name}」的机器人步骤关联缺失`);
        const captured = point.row.record.captured_ns;
        // Include content hashes: re-capturing the same Pose must never clash
        // with previously imported immutable references on the robot.
        const id = (await sha256Bytes(abxBytes(JSON.stringify(['atlas-teaching-standard-v1',
          task.id, parking.id, pose.id, captured, assets.map(({ camera, kind, sha256 }) => [camera, kind, sha256])])))).slice(0, 32);
        const cameras = [...new Set(assets.map((asset) => asset.camera))].sort();
        const cloudCameras = assets.filter((asset) => asset.kind === 'xyzbin').map((asset) => asset.camera).sort();
        point.row.record.standard_images = { id, cameras, ...(cloudCameras.length ? { cloud_cameras: cloudCameras } : {}) };
        lines[point.index] = JSON.stringify(point.row);
        check(abxBytes(lines[point.index]).length <= 12000, '标准资源关联使示教记录超过单行 12000 字节上限');
        changed = true;
        for (const asset of assets) {
          const path = `standards/${id}/${asset.camera.replace(':', '-')}.${asset.kind}`;
          files[path] = asset.data;
          const entry = { path, id, camera: asset.camera, bytes: asset.data.length, sha256: asset.sha256,
            captured_ns: captured, metadata: { simulated: true, timestamp_source: 'virtual_teaching', source_timestamp_ns: captured } };
          if (asset.kind === 'xyzbin') { entry.kind = 'xyzbin'; clouds.push(entry); }
          else standards.push(entry);
        }
        references.push({ taskId: mapped.id, sourcePoseId: pose.id, seq: point.row.seq, id, cameras,
          ...(cloudCameras.length ? { cloudCameras } : {}) });
        // Let progress/cancellation paint between captures instead of monopolizing the UI.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    if (changed) {
      const body = `${lines.slice(1, -1).join('\n')}\n`;
      lines[lines.length - 1] = JSON.stringify({ ...JSON.parse(lines.at(-1)), sha256: await sha256Bytes(abxBytes(body)) });
      files[mapped.file] = abxBytes(`${lines.join('\n')}\n`);
    }
  }
  signal?.throwIfAborted();
  Object.assign(manifest, { include_standards: includeStandards, include_clouds: includeClouds, standards, clouds });
  files['manifest.json'] = jsonBytes(manifest);
  files['source-mapping.json'] = jsonBytes({ ...mapping, standardReferences: references });
  const standardWarnings = [];
  if (includeStandards && availability.missingImages) standardWarnings.push(`${availability.missingImages} 路相机未保存标准图，已跳过；可在工作台重新记录对应 Pose 以补充采集。`);
  if (includeClouds && availability.missingClouds) standardWarnings.push(`${availability.missingClouds} 路相机没有有效点云（未采集或视野内无点），已跳过。`);
  files['README.txt'] = abxBytes(`${new TextDecoder().decode(files['README.txt'])}\n标准资源：${standards.length} 张 PNG，${clouds.length} 份 xyzbin。\n`
    + '在机器人 Web「示教任务 → 导入」中直接选择本 ZIP，标准图与标准点云随任务恢复并关联对应 Pose。\n'
    + '标准资源来自虚拟示教保存的相机采集，标记为 simulated；不触发真机拍照。点云为采样点，光学坐标 X 右 / Y 下 / Z 前，单位毫米。\n'
    + `${standardWarnings.join('\n')}\n`);
  onProgress?.({ completed, total: availability.poseCount, label: '标准资源打包完成' });
  return { ...archive, files, summary: { ...archive.summary, standardImageCount: standards.length,
    standardCloudCount: clouds.length, standardPoseCount: references.length, standardWarnings } };
}
