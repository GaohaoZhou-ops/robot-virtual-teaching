import { strFromU8, strToU8, unzipSync, zip } from 'fflate';
import { sha256Bytes } from "../../../shared/utils/hash.js";
import { buildAbxTeachingExport } from "../../teaching/model/abxTeachingExport.js";
import { TEACHING_DATA_FORMAT } from "../../teaching/model/teachingData.js";
import { LINKED_WORKSPACE_MODES, validateLinkedWorkspaces } from "./linkedProject.js";
import { validateWorkspaceCollection } from "./projectWorkspaceCollection.js";
import { validatePlacedObjectLayers } from "../../viewport/model/placedObjectRendering.js";
import { normalizeRobotTwinProfiles } from "../../robot-twin/model/robotTwinProfiles.js";
import { projectGeometryRecipes } from "./projectGeometryStorage.js";
import { RESOURCE_PROJECT_FORMAT, compactProjectResources, expandProjectResources,
  logicalStorageManifest, physicalStorageManifest, updateStorageReferences } from "./projectResourceStorage.js";

export const PROJECT_ARCHIVE_FORMAT = 'atlas-route-studio-project';
export const LINKED_PROJECT_ARCHIVE_FORMAT = 'atlas-route-studio-linked-project';
export const LINKED_PROJECT_ARCHIVE_VERSION = 1;
export const WORKSPACE_PROJECT_ARCHIVE_FORMAT = 'atlas-route-studio-workspace-project';
export const WORKSPACE_PROJECT_ARCHIVE_VERSION = 1;
export const PROJECT_ARCHIVE_VERSION = 2;
export const PROJECT_ARCHIVE_MANIFEST = 'manifest.json';
export const PROJECT_ARCHIVE_CONFIG = 'config/project.json';
export const PROJECT_DIRECTORY_DESCRIPTOR = 'atlas.project.json';
export const PROJECT_ARCHIVE_MAP_META = 'environment/map.json';
export const PROJECT_ARCHIVE_MAP_ORIGINAL = 'environment/original.ply';
export const PROJECT_ARCHIVE_MAP_POSITIONS = 'environment/positions.f32le';
export const PROJECT_ARCHIVE_MAP_COLORS = 'environment/colors.rgb8';
export const PROJECT_ARCHIVE_MAP_INDICES_U16 = 'environment/triangles.u16le';
export const PROJECT_ARCHIVE_MAP_INDICES_U32 = 'environment/triangles.u32le';
export const PROJECT_ARCHIVE_ROBOT_META = 'robot/robot.json';

const ROBOT_FILE_PREFIX = '/__atlas/robot-files/';
const ROBOT_RESOURCE_CONCURRENCY = 3;
const BUILTIN_ROBOT_MESH_OVERRIDES = {
  'package://botx_abx_zivid_m70/meshes/ZividTwo.stl': 'meshes/zivid_2_m70_official.glb',
};

const textBytes = (value) => strToU8(String(value));

const jsonBytes = (value) => textBytes(JSON.stringify(value, null, 2));

const asBytes = (value) => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error('归档资源不是有效的二进制数据');
};

const exactArrayBuffer = (value) => {
  const bytes = asBytes(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
};

const sha256Json = (value) => sha256Bytes(textBytes(JSON.stringify(stableValue(value))));

const normalizeArchivePath = (value, label = '归档路径') => {
  const source = String(value || '').replaceAll('\\', '/');
  if (source.startsWith('/') || /^[a-z]:\//i.test(source)) {
    throw new Error(`${label}不能是绝对路径：${value}`);
  }
  const parts = source.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error(`${label}无效：${value || '(empty)'}`);
  }
  return parts.join('/');
};

const resolveRelativePath = (basePath, reference) => {
  const source = String(reference || '').trim().replaceAll('\\', '/');
  const packageMatch = /^package:\/\/([^/]+)\/(.+)$/i.exec(source);
  const parts = packageMatch
    ? [packageMatch[1], ...packageMatch[2].split('/')]
    : [...String(basePath || '').split('/').filter(Boolean), ...source.split('/')];
  const normalized = [];
  parts.forEach((part) => {
    if (!part || part === '.') return;
    if (part === '..') {
      if (!normalized.length) throw new Error(`机器人资源路径越界：${reference}`);
      normalized.pop();
    } else {
      normalized.push(part);
    }
  });
  return normalizeArchivePath(normalized.join('/'), '机器人资源路径');
};

const encodePath = (value) => normalizeArchivePath(value, '机器人资源路径')
  .split('/')
  .map((segment) => encodeURIComponent(segment))
  .join('/');

const extensionForPath = (value) => {
  const pathname = String(value || '').split(/[?#]/)[0];
  const dot = pathname.lastIndexOf('.');
  return dot < 0 ? '' : pathname.slice(dot + 1).toLowerCase();
};

const mimeTypeForPath = (value) => ({
  dae: 'model/vnd.collada+xml',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  mtl: 'text/plain',
  obj: 'text/plain',
  png: 'image/png',
  stl: 'model/stl',
  urdf: 'application/xml',
  xml: 'application/xml',
}[extensionForPath(value)] || 'application/octet-stream');

const base64ToBytes = (value) => {
  const normalized = String(value || '').replace(/\s+/g, '');
  if (!normalized) return new Uint8Array();
  const binary = globalThis.atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const bytesToBase64 = (bytes) => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(binary);
};

const dataUrlToAsset = (value, fallbackMimeType = 'application/octet-stream') => {
  const source = String(value || '');
  const separator = source.indexOf(',');
  if (!source.startsWith('data:') || separator < 5) {
    throw new Error('视觉快照不是有效的 Data URL');
  }
  const header = source.slice(5, separator);
  const body = source.slice(separator + 1);
  const parts = header.split(';');
  const mimeType = parts[0] || fallbackMimeType;
  const bytes = parts.includes('base64')
    ? base64ToBytes(body)
    : textBytes(decodeURIComponent(body));
  return { bytes, mimeType };
};

const imageExtension = (mimeType) => {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('gif')) return 'gif';
  return 'bin';
};

export const sanitizeArchiveSegment = (value, fallback = 'unnamed') => {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[. _]+|[. _]+$/g, '')
    .slice(0, 56);
  return normalized || fallback;
};

const indexedFolder = (index, name, fallback) => (
  `${String(index + 1).padStart(2, '0')}_${sanitizeArchiveSegment(name, fallback)}`
);

const addEntry = (entries, path, bytes, compressionLevel = 6) => {
  entries[path] = [bytes, { level: compressionLevel }];
};

const externalizeImage = (image, pathStem, entries, statistics, kind) => {
  if (!image || typeof image !== 'object' || !image.dataUrl) return image || null;
  const asset = dataUrlToAsset(image.dataUrl, image.mimeType || 'image/png');
  const path = `${pathStem}.${imageExtension(asset.mimeType)}`;
  addEntry(entries, path, asset.bytes, 0);
  statistics.assetByteLength += asset.bytes.byteLength;
  if (kind === 'rgb') statistics.rgbFileCount += 1;
  else statistics.previewFileCount += 1;
  const { dataUrl, ...metadata } = image;
  return {
    ...metadata,
    encoding: 'archive-file',
    mimeType: asset.mimeType,
    byteLength: asset.bytes.byteLength,
    file: path,
  };
};

const externalizePointCloud = (pointCloud, cloudRoot, entries, statistics) => {
  if (!pointCloud || typeof pointCloud !== 'object') return null;
  const {
    positionData,
    colorData,
    preview,
    ...metadata
  } = pointCloud;
  const external = {
    ...metadata,
    positionEncoding: String(pointCloud.positionEncoding || 'uint16-le/base64')
      .replace(/\/base64$/i, ''),
    colorEncoding: String(pointCloud.colorEncoding || 'rgb8/base64')
      .replace(/\/base64$/i, ''),
  };

  if (positionData) {
    const positionBytes = base64ToBytes(positionData);
    external.positionFile = `${cloudRoot}/positions.u16le`;
    addEntry(entries, external.positionFile, positionBytes, 6);
    statistics.assetByteLength += positionBytes.byteLength;
  }
  if (colorData) {
    const colorBytes = base64ToBytes(colorData);
    external.colorFile = `${cloudRoot}/colors.rgb8`;
    addEntry(entries, external.colorFile, colorBytes, 6);
    statistics.assetByteLength += colorBytes.byteLength;
  }
  external.preview = externalizeImage(
    preview,
    `${cloudRoot}/preview`,
    entries,
    statistics,
    'preview',
  );
  external.metadataFile = `${cloudRoot}/point-cloud.json`;
  addEntry(entries, external.metadataFile, jsonBytes({
    schemaVersion: 1,
    coordinateFrame: external.coordinateFrame,
    convention: external.convention,
    pointCount: external.pointCount,
    visiblePointCount: external.visiblePointCount,
    sourcePointCount: external.sourcePointCount,
    sampleMethod: external.sampleMethod,
    positionEncoding: external.positionEncoding,
    positionComponents: external.positionComponents,
    positionOffset: external.positionOffset,
    positionScale: external.positionScale,
    colorEncoding: external.colorEncoding,
    hasSourceRgb: external.hasSourceRgb,
    files: {
      positions: external.positionFile || null,
      colors: external.colorFile || null,
      preview: external.preview?.file || null,
    },
  }));
  statistics.pointCloudCount += 1;
  return external;
};

const externalizeCameraCapture = (
  capture,
  poseRoot,
  entries,
  statistics,
) => {
  if (!capture || typeof capture !== 'object') return null;
  const frames = Object.fromEntries(
    Object.entries(capture.frames || {}).flatMap(([side, frame]) => {
      if (!frame || typeof frame !== 'object') return [];
      const normalizedSide = sanitizeArchiveSegment(side, 'camera');
      const externalFrame = {
        ...frame,
        rgb: externalizeImage(
          frame.rgb,
          `${poseRoot}/rgb/${normalizedSide}`,
          entries,
          statistics,
          'rgb',
        ),
        pointCloud: externalizePointCloud(
          frame.pointCloud,
          `${poseRoot}/pointcloud/${normalizedSide}`,
          entries,
          statistics,
        ),
      };
      statistics.cameraFrameCount += 1;
      return [[side, externalFrame]];
    }),
  );
  return { ...capture, frames };
};

const externalizeTeachingTasks = (tasks, entries, statistics) => (
  (Array.isArray(tasks) ? tasks : []).map((task, taskIndex) => {
    const taskRoot = `teaching-data/${indexedFolder(
      taskIndex,
      task.name,
      'task',
    )}`;
    const parkingPoints = (task.parkingPoints || []).map((parkingPoint, parkingIndex) => {
      const parkingRoot = `${taskRoot}/${indexedFolder(
        parkingIndex,
        parkingPoint.name,
        'parking-point',
      )}`;
      const poses = (parkingPoint.poses || []).map((pose, poseIndex) => {
        const poseRoot = `${parkingRoot}/${indexedFolder(
          poseIndex,
          pose.name,
          'pose',
        )}`;
        const externalPose = {
          ...pose,
          cameraCapture: externalizeCameraCapture(
            pose.cameraCapture,
            poseRoot,
            entries,
            statistics,
          ),
        };
        addEntry(entries, `${poseRoot}/pose.json`, jsonBytes({
          schemaVersion: 1,
          recordType: 'teaching-pose',
          task: { id: task.id, name: task.name, sequence: task.sequence },
          parkingPoint: {
            id: parkingPoint.id,
            name: parkingPoint.name,
            sequence: parkingPoint.sequence,
          },
          pose: externalPose,
        }));
        statistics.poseCount += 1;
        return externalPose;
      });
      statistics.parkingPointCount += 1;
      return { ...parkingPoint, poses };
    });
    statistics.taskCount += 1;
    return { ...task, parkingPoints };
  })
);

const mapLimit = async (items, limit, mapper) => {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};

const fetchRobotResource = async (relativePath, url, optional = false) => {
  const response = await fetch(url || `${ROBOT_FILE_PREFIX}${encodePath(relativePath)}`, {
    cache: 'no-cache',
  });
  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error(`机器人资源读取失败（${response.status}）：${relativePath}`);
  return {
    path: relativePath,
    mimeType: response.headers.get('content-type')?.split(';')[0] || mimeTypeForPath(relativePath),
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
};

const robotReferencePath = (reference, descriptor) => {
  const descriptorPath = normalizeArchivePath(
    descriptor.relativePath || descriptor.id || descriptor.fileName,
    '机器人主文件路径',
  );
  const descriptorDirectory = descriptorPath.split('/').slice(0, -1).join('/');
  return resolveRelativePath(descriptorDirectory, reference);
};

const parseUrdfResourceReferences = (bytes, descriptor) => {
  const source = strFromU8(asBytes(bytes));
  const documentNode = new DOMParser().parseFromString(source, 'application/xml');
  const parserError = documentNode.querySelector('parsererror');
  if (parserError) throw new Error(`URDF 解析失败：${parserError.textContent.trim()}`);
  const references = [...documentNode.querySelectorAll('mesh[filename], texture[filename]')]
    .map((node) => node.getAttribute('filename'))
    .filter(Boolean);
  return {
    source,
    paths: [...new Set(references.map((reference) => {
      const override = BUILTIN_ROBOT_MESH_OVERRIDES[reference];
      return override
        ? resolveRelativePath(descriptor.packagePath || '', override)
        : robotReferencePath(reference, descriptor);
    }))],
  };
};

const parseGltfDependencies = (file) => {
  if (extensionForPath(file.path) !== 'gltf') return [];
  try {
    const payload = JSON.parse(strFromU8(asBytes(file.bytes)).replace(/^\uFEFF/, ''));
    const directory = file.path.split('/').slice(0, -1).join('/');
    return [...new Set([
      ...(payload.buffers || []).map((item) => item?.uri),
      ...(payload.images || []).map((item) => item?.uri),
    ].filter((uri) => uri && !/^(?:data:|https?:|blob:)/i.test(uri))
      .map((uri) => resolveRelativePath(directory, uri)))];
  } catch (error) {
    throw new Error(`机器人 glTF 依赖解析失败（${file.path}）：${error.message}`);
  }
};

const normalizePortableRobotPackage = (robotPackage, descriptor) => {
  if (!robotPackage || !Array.isArray(robotPackage.files)) return null;
  const relativePath = normalizeArchivePath(
    robotPackage.relativePath || descriptor?.relativePath || descriptor?.id,
    '机器人主文件路径',
  );
  const filePaths = new Set();
  const files = robotPackage.files.map((file) => {
    const path = normalizeArchivePath(file.path, '机器人资源路径');
    if (filePaths.has(path)) throw new Error(`便携机器人资源路径重复：${path}`);
    filePaths.add(path);
    return {
      path,
      mimeType: String(file.mimeType || mimeTypeForPath(file.path)),
      bytes: asBytes(file.bytes),
    };
  });
  if (!files.some((file) => file.path === relativePath)) {
    throw new Error(`便携机器人资源缺少主文件：${relativePath}`);
  }
  return {
    schemaVersion: 1,
    packageName: String(robotPackage.packageName || descriptor?.packageName || ''),
    packagePath: String(robotPackage.packagePath || descriptor?.packagePath || ''),
    relativePath,
    format: String(robotPackage.format || descriptor?.format || extensionForPath(relativePath)),
    files,
    resourceDigest: robotPackage.resourceDigest || null,
  };
};

export async function collectProjectRobotResources(robot, onProgress, existingPackage = null) {
  if (!robot) return null;
  const existing = normalizePortableRobotPackage(existingPackage, robot);
  if (existing) {
    onProgress?.({ phase: '复用便携机器人资源', detail: `${existing.files.length} 个文件` });
    return existing;
  }

  const relativePath = normalizeArchivePath(
    robot.relativePath || robot.id || robot.fileName,
    '机器人主文件路径',
  );
  const format = String(robot.format || extensionForPath(relativePath)).toLowerCase();
  onProgress?.({ phase: '读取机器人描述', detail: relativePath });
  const primary = await fetchRobotResource(relativePath, robot.url, false);
  const requiredPaths = new Set();
  if (format === 'urdf') {
    parseUrdfResourceReferences(primary.bytes, robot).paths.forEach((path) => requiredPaths.add(path));
  } else if (format === 'gltf') {
    parseGltfDependencies(primary).forEach((path) => requiredPaths.add(path));
  }

  const packagePath = String(robot.packagePath || '').replace(/^\/+|\/+$/g, '');
  const optionalNames = ['package.xml', 'RESOURCE_MANIFEST.sha256'];
  if (robot.manifestUrl) optionalNames.splice(1, 0, 'web-model.json');
  const optionalPaths = packagePath
    ? optionalNames.map((name) => resolveRelativePath(packagePath, name))
    : [];
  let loaded = 0;
  const initialPaths = [...requiredPaths].filter((path) => path !== relativePath);
  const resources = await mapLimit(
    initialPaths,
    ROBOT_RESOURCE_CONCURRENCY,
    async (path) => {
      const resource = await fetchRobotResource(path);
      loaded += 1;
      onProgress?.({
        phase: '收集机器人模型',
        detail: `${loaded} / ${initialPaths.length + optionalPaths.length} · ${path}`,
      });
      return resource;
    },
  );
  const optionalResources = await mapLimit(
    optionalPaths.filter((path) => path !== relativePath && !requiredPaths.has(path)),
    ROBOT_RESOURCE_CONCURRENCY,
    async (path) => {
      const resource = await fetchRobotResource(path, null, true);
      loaded += 1;
      onProgress?.({
        phase: '收集机器人附属清单',
        detail: `${loaded} / ${initialPaths.length + optionalPaths.length} · ${path}`,
      });
      return resource;
    },
  );

  const allFiles = [primary, ...resources, ...optionalResources.filter(Boolean)];
  const manifestFile = allFiles.find((file) => file.path.endsWith('/web-model.json'));
  if (manifestFile) {
    try {
      const manifest = JSON.parse(strFromU8(manifestFile.bytes).replace(/^\uFEFF/, ''));
      [manifest.meshOverrides, manifest.collisionMeshOverrides]
        .flatMap((overrides) => Object.values(overrides || {}))
        .forEach((override) => {
          if (override?.file) requiredPaths.add(resolveRelativePath(packagePath, override.file));
        });
    } catch (error) {
      throw new Error(`机器人 Web 模型清单解析失败：${error.message}`);
    }
  }

  // URDF may reference a textual .gltf whose buffers or textures live in
  // separate files. Seed those dependencies before entering the recursive
  // fetch loop as well; otherwise only a top-level GLTF would be portable.
  allFiles.flatMap(parseGltfDependencies).forEach((path) => requiredPaths.add(path));

  let pending = [...requiredPaths].filter((path) => !allFiles.some((file) => file.path === path));
  while (pending.length) {
    const fetched = await mapLimit(pending, ROBOT_RESOURCE_CONCURRENCY, async (path) => {
      const resource = await fetchRobotResource(path);
      onProgress?.({ phase: '补齐机器人依赖', detail: path });
      return resource;
    });
    allFiles.push(...fetched);
    fetched.flatMap(parseGltfDependencies).forEach((path) => requiredPaths.add(path));
    pending = [...requiredPaths].filter((path) => !allFiles.some((file) => file.path === path));
  }

  return {
    schemaVersion: 1,
    packageName: String(robot.packageName || ''),
    packagePath,
    relativePath,
    format,
    files: allFiles.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

const zipEntries = (entries) => new Promise((resolve, reject) => {
  zip(entries, { level: 6 }, (error, data) => {
    if (error) reject(error);
    else resolve(data);
  });
});

const unzipEntries = async (input, { onProgress } = {}) => {
  onProgress?.({ phase: '解压工程包', detail: '正在读取压缩包', progress: 0 });
  // fflate's async unzip creates a worker for each large member. Every member
  // is a subarray of the same ZIP, so posting it clones the entire archive.
  // Use one worker and transfer the results back; a File is read in that worker.
  if (typeof Worker === 'undefined') {
    const bytes = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : asBytes(input);
    return unzipSync(bytes);
  }
  const worker = new Worker(new URL("../workers/projectArchive.worker.js", import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, files) => {
      if (finished) return;
      finished = true;
      worker.terminate();
      if (error) reject(error); else resolve(files);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(new Error(event.message || '工程包解压进程启动失败'));
    };
    worker.onmessageerror = () => finish(new Error('无法读取工程包解压结果'));
    worker.onmessage = ({ data }) => {
      if (finished) return;
      try {
        if (data.type === 'progress') onProgress?.(data.value);
        else if (data.type === 'complete') finish(null, data.files);
        else if (data.type === 'error') finish(new Error(data.message));
      } catch (error) { finish(error); }
    };
    try {
      // Preserve caller-owned byte arrays. Files/Blobs share immutable storage;
      // byte arrays incur one copy, regardless of the number of ZIP members.
      worker.postMessage(input instanceof Blob ? input : asBytes(input));
    } catch (error) { finish(error); }
  });
};

const addEnvironmentResource = async (entries, mapResource, projectMap) => {
  if (!mapResource?.positionBuffer) {
    throw new Error('当前地图没有可打包的几何缓存，请重新加载地图后再导出');
  }
  const positionBytes = asBytes(mapResource.positionBuffer);
  if (!positionBytes.byteLength || positionBytes.byteLength % 12 !== 0) {
    throw new Error('地图坐标缓存无效，无法生成便携工程包');
  }
  const pointCount = positionBytes.byteLength / 12;
  const colorBytes = mapResource.colorBuffer ? asBytes(mapResource.colorBuffer) : null;
  if (colorBytes && colorBytes.byteLength !== pointCount * 3) {
    throw new Error('地图颜色缓存与坐标数量不一致');
  }
  const indexBytes = mapResource.indexBuffer ? asBytes(mapResource.indexBuffer) : null;
  const indexComponentType = mapResource.indexComponentType === 'uint16' ? 'uint16' : 'uint32';
  const indexStride = indexComponentType === 'uint16' ? 2 : 4;
  if (indexBytes && (indexBytes.byteLength % (indexStride * 3) !== 0)) {
    throw new Error('地图三角面索引缓存无效');
  }
  const indexFile = indexBytes
    ? indexComponentType === 'uint16'
      ? PROJECT_ARCHIVE_MAP_INDICES_U16
      : PROJECT_ARCHIVE_MAP_INDICES_U32
    : null;

  addEntry(entries, PROJECT_ARCHIVE_MAP_POSITIONS, positionBytes, 1);
  if (colorBytes) addEntry(entries, PROJECT_ARCHIVE_MAP_COLORS, colorBytes, 1);
  if (indexBytes) addEntry(entries, indexFile, indexBytes, 1);
  const sourceBytes = mapResource.sourceBlob instanceof Blob && mapResource.sourceBlob.size > 0
    ? new Uint8Array(await mapResource.sourceBlob.arrayBuffer())
    : null;
  if (sourceBytes) addEntry(entries, PROJECT_ARCHIVE_MAP_ORIGINAL, sourceBytes, 1);
  const metadata = {
    schemaVersion: 1,
    storage: 'atlas-geometry-cache',
    coordinateFrame: String(projectMap?.coordinateFrame || mapResource.coordinateFrame || 'map'),
    teachingSpaceMode: String(
      projectMap?.teachingSpaceMode || mapResource.teachingSpaceMode || 'map',
    ),
    coordinateSystem: 'right-handed-z-up',
    name: String(projectMap?.fileName || mapResource.name || 'map.ply'),
    original: {
      file: sourceBytes ? PROJECT_ARCHIVE_MAP_ORIGINAL : null,
      format: String(projectMap?.format || 'ply'),
      byteLength: Math.max(0, Number(projectMap?.byteLength ?? mapResource.byteLength) || 0),
      fileModifiedAt: projectMap?.fileModifiedAt || mapResource.fileModifiedAt || null,
      mimeType: projectMap?.mimeType || mapResource.mimeType || 'application/octet-stream',
      sourceHash: projectMap?.sourceHash || mapResource.sourceHash || null,
      sourceHashKind: projectMap?.sourceHashKind || mapResource.sourceHashKind || null,
    },
    geometry: {
      geometryCacheVersion: Number(mapResource.geometryCacheVersion) || 1,
      pointCount,
      ...(validatePlacedObjectLayers(mapResource, mapResource.geometryLayers)
        ? { layers: mapResource.geometryLayers } : {}),
      faceCount: indexBytes ? indexBytes.byteLength / indexStride / 3 : 0,
      bounds: mapResource.bounds || projectMap?.bounds || null,
      sphere: mapResource.sphere || null,
      positions: {
        file: PROJECT_ARCHIVE_MAP_POSITIONS,
        encoding: 'float32-le',
        components: 3,
      },
      colors: colorBytes
        ? { file: PROJECT_ARCHIVE_MAP_COLORS, encoding: 'rgb8', components: 3 }
        : null,
      triangles: indexBytes
        ? { file: indexFile, encoding: `${indexComponentType}-le`, components: 3 }
        : null,
    },
  };
  addEntry(entries, PROJECT_ARCHIVE_MAP_META, jsonBytes(metadata));
  return metadata;
};

const addRobotResource = (entries, robotPackage, projectRobot) => {
  if (!projectRobot) return null;
  const normalized = normalizePortableRobotPackage(robotPackage, projectRobot);
  if (!normalized) throw new Error('机器人资源收集失败，无法生成便携工程包');
  const fileRecords = normalized.files.map((file) => {
    const archivePath = `robot/files/${file.path}`;
    const extension = extensionForPath(file.path);
    const compressionLevel = ['glb', 'jpg', 'jpeg', 'png'].includes(extension) ? 0 : 1;
    addEntry(entries, archivePath, file.bytes, compressionLevel);
    return {
      path: file.path,
      archivePath,
      mimeType: file.mimeType || mimeTypeForPath(file.path),
      byteLength: file.bytes.byteLength,
    };
  });
  const metadata = {
    schemaVersion: 1,
    storage: 'atlas-portable-robot-package',
    id: String(projectRobot.id || normalized.relativePath),
    name: String(projectRobot.name || normalized.relativePath.split('/').at(-1)),
    relativePath: normalized.relativePath,
    format: normalized.format,
    packageName: normalized.packageName || null,
    packagePath: normalized.packagePath || null,
    files: fileRecords,
  };
  addEntry(entries, PROJECT_ARCHIVE_ROBOT_META, jsonBytes(metadata));
  return metadata;
};

const roleForArchivePath = (path) => {
  if (path === PROJECT_DIRECTORY_DESCRIPTOR) return 'project-descriptor';
  if (path === PROJECT_ARCHIVE_CONFIG) return 'project-config';
  if (path === PROJECT_ARCHIVE_MAP_META) return 'environment-metadata';
  if (path.startsWith('environment/')) return 'environment-geometry';
  if (path === PROJECT_ARCHIVE_ROBOT_META) return 'robot-metadata';
  if (path.startsWith('robot/files/')) return 'robot-resource';
  if (path.startsWith('teaching-data/') && /\/rgb\//.test(path)) return 'teaching-rgb';
  if (path.startsWith('teaching-data/') && /\/pointcloud\//.test(path)) return 'teaching-pointcloud';
  if (path.startsWith('teaching-data/')) return 'teaching-metadata';
  if (path === 'README.txt') return 'instructions';
  return 'project-resource';
};

async function buildProjectEntries(payload, options = {}) {
  if (!payload || typeof payload !== 'object') throw new Error('工程配置为空，无法打包');
  const { mapResource, existingRobotPackage = null, onProgress } = options;
  const entries = {};
  const statistics = {
    taskCount: 0,
    parkingPointCount: 0,
    poseCount: 0,
    cameraFrameCount: 0,
    rgbFileCount: 0,
    pointCloudCount: 0,
    previewFileCount: 0,
    assetByteLength: 0,
    environmentFileCount: 0,
    robotFileCount: 0,
  };
  onProgress?.({ phase: '冻结地图资源', detail: payload.map?.fileName || '当前地图' });
  const environmentMetadata = await addEnvironmentResource(entries, mapResource, payload.map);
  const robotPackage = payload.robot
    ? await collectProjectRobotResources(payload.robot, onProgress, existingRobotPackage)
    : null;
  const robotMetadata = robotPackage
    ? addRobotResource(entries, robotPackage, payload.robot)
    : null;
  const abxExport = options.includeAbxTeaching
    ? await buildAbxTeachingExport(payload, { robotPackage })
    : null;
  if (abxExport) {
    Object.entries(abxExport.files).forEach(([path, data]) => addEntry(entries, path, data));
  }
  statistics.environmentFileCount = Object.keys(entries).filter((path) => path.startsWith('environment/')).length;
  statistics.robotFileCount = Object.keys(entries).filter((path) => path.startsWith('robot/')).length;
  const project = {
    ...payload,
    robotTwin: normalizeRobotTwinProfiles(payload.robotTwin) || undefined,
    schemaVersion: '1.3',
    archive: {
      format: PROJECT_ARCHIVE_FORMAT,
      version: PROJECT_ARCHIVE_VERSION,
      manifestFile: PROJECT_ARCHIVE_MANIFEST,
      projectFile: PROJECT_ARCHIVE_CONFIG,
      mediaStorage: 'external-files',
      resourceStorage: 'embedded',
      resources: {
        environment: {
          metadataFile: PROJECT_ARCHIVE_MAP_META,
          positionsFile: PROJECT_ARCHIVE_MAP_POSITIONS,
          colorsFile: environmentMetadata.geometry.colors?.file || null,
          trianglesFile: environmentMetadata.geometry.triangles?.file || null,
        },
        robot: robotMetadata
          ? { metadataFile: PROJECT_ARCHIVE_ROBOT_META, root: 'robot/files/' }
          : null,
      },
    },
    virtualTeaching: {
      ...(payload.virtualTeaching || {}),
      tasks: externalizeTeachingTasks(
        payload.virtualTeaching?.tasks,
        entries,
        statistics,
      ),
    },
  };
  const projectFile = jsonBytes(project);
  addEntry(entries, PROJECT_ARCHIVE_CONFIG, projectFile);
  addEntry(entries, PROJECT_DIRECTORY_DESCRIPTOR, jsonBytes({
    format: PROJECT_ARCHIVE_FORMAT,
    version: PROJECT_ARCHIVE_VERSION,
    kind: 'directory-project',
    manifestFile: PROJECT_ARCHIVE_MANIFEST,
    projectFile: PROJECT_ARCHIVE_CONFIG,
    name: String(payload.workspace?.independentTeachingName || payload.virtualTeaching?.tasks?.[0]?.name || payload.map?.fileName || '未命名工程'),
    updatedAt: project.exportedAt || new Date().toISOString(),
  }));
  addEntry(entries, 'README.txt', textBytes([
    '虚拟示教平台 · 工程目录',
    '',
    `工程入口：${PROJECT_DIRECTORY_DESCRIPTOR}`,
    `主配置：${PROJECT_ARCHIVE_CONFIG}`,
    `地图几何：${PROJECT_ARCHIVE_MAP_META} + environment/*.f32le|rgb8|u16le|u32le`,
    robotMetadata ? `机器人资源：${PROJECT_ARCHIVE_ROBOT_META} + robot/files/` : '机器人资源：当前工程未选择机器人',
    '视觉目录：teaching-data/<任务>/<停车点>/<姿态>/',
    'RGB：rgb/<left|right>.<图片格式>',
    '点云：pointcloud/<left|right>/positions.u16le + colors.rgb8 + point-cloud.json',
    '',
    'positions.u16le 通过 point-cloud.json 中的 positionOffset / positionScale 还原坐标。',
    'manifest.json 保存逐文件 SHA-256；导入时会先校验完整性、地图与机器人身份。',
    '日常工作请直接打开本目录；程序会增量写入配置与新增示教资源，不会反复压缩。',
    '需要迁移到其他设备时，请人工压缩/解压整个目录，保持目录层级不变。',
    ...(abxExport ? ['', 'ABX 地图示教适配结果及导入说明：abx/README.txt'] : []),
  ].join('\n')));

  const entryPaths = Object.keys(entries).sort();
  const fileRecords = [];
  for (let index = 0; index < entryPaths.length; index += 1) {
    const path = entryPaths[index];
    const bytes = asBytes(entries[path][0]);
    onProgress?.({
      phase: '生成完整性清单',
      detail: `${index + 1} / ${entryPaths.length} · ${path}`,
      progress: entryPaths.length ? (index + 1) / entryPaths.length : 1,
    });
    fileRecords.push({
      path,
      role: roleForArchivePath(path),
      byteLength: bytes.byteLength,
      sha256: await sha256Bytes(bytes),
    });
  }
  const environmentFiles = fileRecords.filter((file) => file.path.startsWith('environment/'));
  const robotFiles = fileRecords.filter((file) => file.path.startsWith('robot/files/'));
  const manifest = {
    format: PROJECT_ARCHIVE_FORMAT,
    archiveVersion: PROJECT_ARCHIVE_VERSION,
    schemaVersion: project.schemaVersion,
    exportedAt: project.exportedAt || new Date().toISOString(),
    projectFile: PROJECT_ARCHIVE_CONFIG,
    portable: true,
    ...(abxExport ? { abxExport: abxExport.summary } : {}),
    layout: {
      descriptor: PROJECT_DIRECTORY_DESCRIPTOR,
      environment: 'environment/{map.json,positions.f32le,colors.rgb8,triangles.*}',
      robot: 'robot/{robot.json,files/**}',
      teaching: 'teaching-data/<task>/<parking-point>/<pose>/{pose.json,rgb,pointcloud}',
    },
    identities: {
      map: {
        fileName: String(payload.map?.fileName || ''),
        sourceHash: payload.map?.sourceHash || null,
        sourceHashKind: payload.map?.sourceHashKind || null,
        geometryDigest: await sha256Json(environmentFiles.map((file) => ({
          path: file.path,
          byteLength: file.byteLength,
          sha256: file.sha256,
        }))),
      },
      robot: robotMetadata
        ? {
            id: String(payload.robot?.id || payload.robot?.relativePath || ''),
            relativePath: robotMetadata.relativePath,
            packageName: robotMetadata.packageName,
            resourceDigest: await sha256Json(robotFiles.map((file) => ({
              path: file.path,
              byteLength: file.byteLength,
              sha256: file.sha256,
            }))),
          }
        : null,
    },
    files: fileRecords,
    statistics: {
      ...statistics,
      assetByteLength: fileRecords
        .filter((file) => !['project-config', 'project-descriptor', 'instructions'].includes(file.role))
        .reduce((total, file) => total + file.byteLength, 0),
      projectJsonByteLength: projectFile.byteLength,
      fileCount: fileRecords.length + 1,
    },
  };
  addEntry(entries, PROJECT_ARCHIVE_MANIFEST, jsonBytes(manifest));
  return { entries, manifest, project };
}

async function buildLinkedProjectEntries(payload, options) {
  const mode = payload?.workspace?.teachingSpaceMode;
  const other = options.linkedWorkspace;
  const workspaces = {
    [mode]: { mode, map: { ...options.mapResource, portableRobotPackage: options.existingRobotPackage },
      config: { mapId: options.mapResource?.mapId,
        config: { project: payload, ui: options.workspaceUI || {} } } },
    [other.mode]: { ...other },
  };
  validateLinkedWorkspaces(workspaces, { requireRobotResources: false });
  // Robot files may still need collecting from the local model library.
  for (const workspace of Object.values(workspaces)) {
    const robot = workspace.config.config.project.robot;
    if (robot) workspace.map = { ...workspace.map,
      portableRobotPackage: await collectProjectRobotResources(robot, options.onProgress,
        workspace.map.portableRobotPackage?.relativePath === robot.relativePath
          ? workspace.map.portableRobotPackage : null) };
  }
  const entries = {};
  const files = [];
  const descriptors = {};
  const statistics = { workspaceCount: 2 };
  for (const workspaceMode of LINKED_WORKSPACE_MODES) {
    const workspace = workspaces[workspaceMode];
    const prefix = `workspaces/${workspaceMode}/`;
    const child = await buildProjectEntries({ ...workspace.config.config.project,
      ...(payload.robotTwin ? { robotTwin: payload.robotTwin } : {}) }, {
      mapResource: workspace.map,
      existingRobotPackage: workspace.map.portableRobotPackage,
      onProgress: (progress) => options.onProgress?.({ ...progress,
        phase: `${workspaceMode === 'map' ? '地图示教' : '独立示教'} · ${progress.phase}` }),
    });
    Object.entries(child.entries).forEach(([path, entry]) => { entries[prefix + path] = entry; });
    files.push(...child.manifest.files.map((record) => ({ ...record, path: prefix + record.path })));
    const manifestBytes = asBytes(child.entries[PROJECT_ARCHIVE_MANIFEST][0]);
    files.push({ path: prefix + PROJECT_ARCHIVE_MANIFEST, byteLength: manifestBytes.byteLength,
      sha256: await sha256Bytes(manifestBytes) });
    descriptors[workspaceMode] = { prefix, mapId: workspace.map.mapId,
      ui: { mapRouteSyncEnabled: workspace.config.config.ui?.mapRouteSyncEnabled === true,
        showSlice3D: workspace.config.config.ui?.showSlice3D !== false } };
    Object.entries(child.manifest.statistics).forEach(([key, value]) => {
      if (typeof value === 'number') statistics[key] = (statistics[key] || 0) + value;
    });
  }
  const instructions = textBytes([
    '虚拟示教平台 · 双边完整工程',
    '本文件同时包含已绑定的地图示教与独立示教；两侧数据各自保留原坐标系。',
    '从任一示教模式加载整个 ZIP，即可恢复两侧工程及转换关系。',
    '也可解压后选择根目录加载；双边目录作为只读快照导入，不启用目录增量写入。',
    'workspaces/map/ 和 workspaces/independent/ 分别保存两侧地图、机器人与示教数据。',
    '请保留整个包，单独复制其中一侧无法完整恢复绑定工程。',
  ].join('\n'));
  addEntry(entries, 'README.txt', instructions);
  files.push({ path: 'README.txt', byteLength: instructions.byteLength, sha256: await sha256Bytes(instructions) });
  const manifest = {
    format: LINKED_PROJECT_ARCHIVE_FORMAT,
    archiveVersion: LINKED_PROJECT_ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    activeMode: mode,
    portable: true,
    workspaces: descriptors,
    files,
    statistics: { ...statistics, fileCount: files.length + 1 },
  };
  addEntry(entries, PROJECT_ARCHIVE_MANIFEST, jsonBytes(manifest));
  return { entries, manifest, project: payload };
}

async function buildWorkspaceCollectionEntries(payload, options) {
  const mode = payload?.workspace?.teachingSpaceMode;
  const companion = options.companionWorkspace || options.linkedWorkspace;
  const collection = {
    activeMode: mode,
    workspaces: {
      ...(companion ? { [companion.mode]: companion } : {}),
      [mode]: { mode, map: { ...options.mapResource, portableRobotPackage: options.existingRobotPackage },
        config: { mapId: options.mapResource?.mapId, config: { project: payload, ui: options.workspaceUI || {} } } },
    },
    independentHistory: options.independentHistory || [],
  };
  validateWorkspaceCollection(collection, { requireRobotResources: false });
  const entries = {};
  const files = [];
  const statistics = { workspaceCount: 0, independentHistoryCount: collection.independentHistory.length,
    independentWorkspaceCount: collection.independentHistory.length + (collection.workspaces.independent ? 1 : 0) };
  const addWorkspace = async (snapshot, prefix, label) => {
    const project = snapshot.config.config.project;
    const child = await buildProjectEntries({ ...project,
      ...(payload.robotTwin ? { robotTwin: payload.robotTwin } : {}) }, {
      mapResource: snapshot.map,
      existingRobotPackage: snapshot.map.portableRobotPackage?.relativePath === project.robot?.relativePath
        ? snapshot.map.portableRobotPackage : null,
      onProgress: (progress) => options.onProgress?.({ ...progress, phase: `${label} · ${progress.phase}` }),
    });
    Object.entries(child.entries).forEach(([path, entry]) => { entries[prefix + path] = entry; });
    files.push(...child.manifest.files.map((record) => ({ ...record, path: prefix + record.path })));
    const bytes = asBytes(child.entries[PROJECT_ARCHIVE_MANIFEST][0]);
    files.push({ path: prefix + PROJECT_ARCHIVE_MANIFEST, byteLength: bytes.byteLength, sha256: await sha256Bytes(bytes) });
    statistics.workspaceCount += 1;
    Object.entries(child.manifest.statistics).forEach(([key, value]) => {
      if (typeof value === 'number') statistics[key] = (statistics[key] || 0) + value;
    });
    // UI configuration contains no device-local handles or binary resources.
    const { selectedRobot, ...ui } = snapshot.config.config.ui || {};
    return { prefix, mapId: snapshot.map.mapId,
      portableOriginalMapId: snapshot.map.portableOriginalMapId || snapshot.map.mapId, ui };
  };
  const workspaces = {};
  for (const [workspaceMode, snapshot] of Object.entries(collection.workspaces)) {
    workspaces[workspaceMode] = await addWorkspace(snapshot, `workspaces/${workspaceMode}/`,
      workspaceMode === 'map' ? '地图示教' : '独立示教');
  }
  const independentHistory = [];
  for (const [index, snapshot] of collection.independentHistory.entries()) {
    const descriptor = await addWorkspace(snapshot, `independent-history/${index + 1}/`,
      `独立示教缓存 ${index + 1}/${collection.independentHistory.length}`);
    independentHistory.push({ ...descriptor, archivedAt: snapshot.archivedAt });
  }
  const instructions = textBytes([
    '虚拟示教平台 · 完整工程与独立示教列表',
    '本文件包含当前工作区、另一侧已打开的工作区以及独立示教缓存列表的全部模型和配置。',
    '每组均包含地图/物体、机器人模型与资源、预设姿态、路径、示教任务、RGB/点云、视角及转换关系。',
    '在另一台运行本平台的设备上加载整个 ZIP，即可恢复工作区和独立示教列表；坐标和转换矩阵保持不变。',
    'workspaces/ 保存当前工作区；independent-history/ 保存历史示教组，包含同名模型的不同组。',
    '也可解压后选择根目录加载；完整集合按快照导入，不绑定本机工程目录。',
    '请保留整个包；manifest.json 对所有资源逐文件执行 SHA-256 校验。',
  ].join('\n'));
  addEntry(entries, 'README.txt', instructions);
  files.push({ path: 'README.txt', byteLength: instructions.byteLength, sha256: await sha256Bytes(instructions) });
  const manifest = { format: WORKSPACE_PROJECT_ARCHIVE_FORMAT, archiveVersion: WORKSPACE_PROJECT_ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(), portable: true, activeMode: mode, workspaces, independentHistory,
    files, statistics: { ...statistics, fileCount: files.length + 1 } };
  addEntry(entries, PROJECT_ARCHIVE_MANIFEST, jsonBytes(manifest));
  return { entries, manifest, project: payload };
}

export async function buildProjectArchive(payload, options = {}) {
  const { entries, manifest, project } = await (options.companionWorkspace || options.independentHistory?.length
    ? buildWorkspaceCollectionEntries(payload, options)
    : options.linkedWorkspace ? buildLinkedProjectEntries(payload, options) : buildProjectEntries(payload, options));
  const recipes = await projectGeometryRecipes(payload, options, entries);
  const compact = await compactProjectResources(entries, manifest, recipes, options.onProgress);
  options.onProgress?.({ phase: '压缩便携工程', detail: `${manifest.statistics.fileCount} 个文件` });
  const bytes = await zipEntries(compact.entries);
  return {
    bytes,
    blob: new Blob([bytes], { type: 'application/zip' }),
    manifest,
    storage: compact.storage,
    project,
    byteLength: bytes.byteLength,
  };
}

const triggerDownload = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

export async function downloadProjectArchive(payload, filename, options = {}) {
  const archive = await buildProjectArchive(payload, options);
  triggerDownload(archive.blob, filename);
  return archive;
}

export async function saveProjectArchive(payload, fileHandle, options = {}) {
  const archive = await buildProjectArchive(payload, options);
  options.onProgress?.({ phase: '保存工程 ZIP', detail: fileHandle.name, progress: 1 });
  // Open the writable only after packing succeeds; close commits the new file.
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(archive.blob);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch {
      // Preserve the original write/close failure.
    }
    throw error;
  }
  return archive;
}

const readJsonEntry = (files, path, label) => {
  const bytes = files[path];
  if (!bytes) throw new Error(`${label}不存在：${path}`);
  try {
    return JSON.parse(strFromU8(bytes).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`${label}解析失败：${error.message}`);
  }
};

const requiredAsset = (files, path) => {
  const bytes = files[String(path || '')];
  if (!bytes) throw new Error(`ZIP 中缺少视觉资源：${path}`);
  return bytes;
};

const hydrateImage = (image, files) => {
  if (!image || typeof image !== 'object' || image.dataUrl || !image.file) {
    return image || null;
  }
  const bytes = requiredAsset(files, image.file);
  const { file, ...metadata } = image;
  const mimeType = String(metadata.mimeType || 'image/png');
  return {
    ...metadata,
    encoding: 'data-url',
    byteLength: bytes.byteLength,
    dataUrl: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
  };
};

const base64Encoding = (value, fallback) => {
  const encoding = String(value || fallback);
  return /\/base64$/i.test(encoding) ? encoding : `${encoding}/base64`;
};

const hydratePointCloud = (pointCloud, files) => {
  if (!pointCloud || typeof pointCloud !== 'object') return null;
  const positionBytes = pointCloud.positionData
    ? null
    : pointCloud.positionFile ? requiredAsset(files, pointCloud.positionFile) : null;
  const colorBytes = pointCloud.colorData
    ? null
    : pointCloud.colorFile ? requiredAsset(files, pointCloud.colorFile) : null;
  const {
    positionFile,
    colorFile,
    metadataFile,
    ...metadata
  } = pointCloud;
  return {
    ...metadata,
    positionEncoding: base64Encoding(pointCloud.positionEncoding, 'uint16-le'),
    positionData: pointCloud.positionData || (positionBytes ? bytesToBase64(positionBytes) : ''),
    colorEncoding: base64Encoding(pointCloud.colorEncoding, 'rgb8'),
    colorData: pointCloud.colorData || (colorBytes ? bytesToBase64(colorBytes) : ''),
    preview: hydrateImage(pointCloud.preview, files),
  };
};

const hydrateProjectAssets = (project, files) => ({
  ...project,
  virtualTeaching: {
    ...(project.virtualTeaching || {}),
    tasks: (project.virtualTeaching?.tasks || []).map((task) => ({
      ...task,
      parkingPoints: (task.parkingPoints || []).map((parkingPoint) => ({
        ...parkingPoint,
        poses: (parkingPoint.poses || []).map((pose) => ({
          ...pose,
          cameraCapture: pose.cameraCapture
            ? {
                ...pose.cameraCapture,
                frames: Object.fromEntries(
                  Object.entries(pose.cameraCapture.frames || {}).map(([side, frame]) => [
                    side,
                    {
                      ...frame,
                      rgb: hydrateImage(frame.rgb, files),
                      pointCloud: hydratePointCloud(frame.pointCloud, files),
                    },
                  ]),
                ),
              }
            : null,
        })),
      })),
    })),
  },
});

const validateArchiveEntryPaths = (files) => {
  Object.keys(files).forEach((path) => {
    if (path.endsWith('/')) return;
    const normalized = normalizeArchivePath(path, 'ZIP 成员路径');
    if (normalized !== path) throw new Error(`ZIP 成员路径不规范：${path}`);
  });
};

const progressRange = (onProgress, start, end) => onProgress && ((value) => onProgress({
  ...value,
  progress: start + Math.min(1, Math.max(0, Number(value.progress) || 0)) * (end - start),
}));

const verifyArchiveFiles = async (files, manifest, onProgress, digests = new WeakMap()) => {
  const linked = [LINKED_PROJECT_ARCHIVE_FORMAT, WORKSPACE_PROJECT_ARCHIVE_FORMAT].includes(manifest.format);
  if (!linked && Number(manifest.archiveVersion) < 2) return;
  if (!Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('便携工程包缺少逐文件完整性清单');
  }
  const declared = new Set();
  for (let index = 0; index < manifest.files.length; index += 1) {
    const record = manifest.files[index];
    const path = normalizeArchivePath(record?.path, 'manifest 文件路径');
    if (declared.has(path)) throw new Error(`manifest 重复声明文件：${path}`);
    declared.add(path);
    const file = files[path];
    if (!file) throw new Error(`工程包缺少 manifest 声明的文件：${path}`);
    if (Number(record.byteLength) !== file.byteLength) {
      throw new Error(`工程包文件长度校验失败：${path}`);
    }
    const digest = digests.get(file) || await sha256Bytes(file);
    digests.set(file, digest);
    if (digest !== String(record.sha256 || '').toLowerCase()) {
      throw new Error(`工程包 SHA-256 校验失败：${path}`);
    }
    onProgress?.({
      phase: '校验工程包完整性',
      detail: `${index + 1} / ${manifest.files.length} · ${path}`,
      progress: (index + 1) / manifest.files.length,
    });
  }
  const extras = Object.keys(files).filter((path) => (
    !path.endsWith('/') && path !== PROJECT_ARCHIVE_MANIFEST && !declared.has(path)
  ));
  if (extras.length) throw new Error(`工程包包含未登记文件：${extras[0]}`);
  if (linked) return;

  const environmentRecords = manifest.files
    .filter((record) => String(record.path).startsWith('environment/'))
    .map(({ path, byteLength, sha256 }) => ({ path, byteLength, sha256 }));
  const geometryDigest = await sha256Json(environmentRecords);
  if (manifest.identities?.map?.geometryDigest !== geometryDigest) {
    throw new Error('地图几何身份摘要不匹配');
  }
  const robotRecords = manifest.files
    .filter((record) => String(record.path).startsWith('robot/files/'))
    .map(({ path, byteLength, sha256 }) => ({ path, byteLength, sha256 }));
  if (manifest.identities?.robot) {
    const resourceDigest = await sha256Json(robotRecords);
    if (manifest.identities.robot.resourceDigest !== resourceDigest) {
      throw new Error('机器人资源身份摘要不匹配');
    }
  }
};

const hydrateEnvironmentResource = (project, files, manifest) => {
  const reference = project.archive?.resources?.environment;
  if (!reference?.metadataFile) return null;
  const metadataPath = normalizeArchivePath(reference.metadataFile, '地图元数据路径');
  const metadata = readJsonEntry(files, metadataPath, '地图资源元数据');
  const geometry = metadata.geometry;
  if (!geometry?.positions?.file) throw new Error('地图资源元数据缺少坐标文件');
  const positionBytes = requiredAsset(files, geometry.positions.file);
  if (geometry.positions.encoding !== 'float32-le' || positionBytes.byteLength % 12 !== 0) {
    throw new Error('地图坐标资源格式无效');
  }
  const pointCount = positionBytes.byteLength / 12;
  if (Number(geometry.pointCount) !== pointCount) throw new Error('地图点数与坐标资源不一致');
  const colorBytes = geometry.colors?.file ? requiredAsset(files, geometry.colors.file) : null;
  if (colorBytes && colorBytes.byteLength !== pointCount * 3) {
    throw new Error('地图颜色数量与坐标数量不一致');
  }
  const indexBytes = geometry.triangles?.file
    ? requiredAsset(files, geometry.triangles.file)
    : null;
  if (
    indexBytes
    && !['uint16-le', 'uint32-le'].includes(String(geometry.triangles?.encoding || ''))
  ) throw new Error('地图三角面索引编码无效');
  const indexComponentType = geometry.triangles?.encoding === 'uint16-le' ? 'uint16' : 'uint32';
  const indexStride = indexComponentType === 'uint16' ? 2 : 4;
  if (indexBytes && indexBytes.byteLength % (indexStride * 3) !== 0) {
    throw new Error('地图三角面索引资源无效');
  }
  const sourceHash = metadata.original?.sourceHash || null;
  const sourceBytes = metadata.original?.file
    ? requiredAsset(files, metadata.original.file)
    : null;
  if (sourceBytes && sourceBytes.byteLength !== Number(metadata.original.byteLength)) {
    throw new Error('地图原始文件大小与元数据不一致');
  }
  if (
    project.map?.sourceHash
    && sourceHash
    && String(project.map.sourceHash) !== String(sourceHash)
  ) throw new Error('工程配置引用的地图与归档地图不匹配');
  if (
    manifest.identities?.map?.sourceHash
    && sourceHash
    && String(manifest.identities.map.sourceHash) !== String(sourceHash)
  ) throw new Error('manifest 绑定的地图与归档地图不匹配');
  const geometryLayers = validatePlacedObjectLayers({ pointCount, sourceHash }, geometry.layers);
  return {
    geometryCacheVersion: 1,
    name: String(metadata.name || project.map?.fileName || 'portable-map.ply'),
    byteLength: Math.max(0, Number(metadata.original?.byteLength) || positionBytes.byteLength),
    pointCount,
    ...(geometryLayers ? { geometryLayers } : {}),
    faceCount: indexBytes ? indexBytes.byteLength / indexStride / 3 : 0,
    positionBuffer: exactArrayBuffer(positionBytes),
    colorBuffer: colorBytes ? exactArrayBuffer(colorBytes) : null,
    indexBuffer: indexBytes ? exactArrayBuffer(indexBytes) : null,
    indexComponentType,
    bounds: geometry.bounds || project.map?.bounds || null,
    sphere: geometry.sphere || null,
    sourceHash,
    sourceBlob: sourceBytes
      ? new Blob([sourceBytes], { type: metadata.original.mimeType || 'application/octet-stream' })
      : null,
    sourceHashKind: metadata.original?.sourceHashKind || project.map?.sourceHashKind || 'file',
    fileModifiedAt: metadata.original?.fileModifiedAt || project.map?.fileModifiedAt || null,
    mimeType: metadata.original?.mimeType || project.map?.mimeType || 'application/octet-stream',
    loadedAt: new Date().toISOString(),
    sourceKind: 'project-archive',
    ...(project.map?.teachingGroupId ? { teachingGroupId: project.map.teachingGroupId } : {}),
    teachingSpaceMode: String(
      metadata.teachingSpaceMode || project.map?.teachingSpaceMode || 'map',
    ),
    coordinateFrame: String(
      metadata.coordinateFrame || project.map?.coordinateFrame || 'map',
    ),
    geometryDigest: manifest.identities?.map?.geometryDigest || null,
  };
};

const hydrateRobotResource = (project, files, manifest) => {
  const reference = project.archive?.resources?.robot;
  if (!reference?.metadataFile) return null;
  const metadataPath = normalizeArchivePath(reference.metadataFile, '机器人元数据路径');
  const metadata = readJsonEntry(files, metadataPath, '机器人资源元数据');
  const relativePath = normalizeArchivePath(metadata.relativePath, '机器人主文件路径');
  if (
    project.robot?.relativePath
    && String(project.robot.relativePath) !== relativePath
  ) throw new Error('工程配置引用的机器人与归档机器人不匹配');
  if (
    manifest.identities?.robot?.relativePath
    && String(manifest.identities.robot.relativePath) !== relativePath
  ) throw new Error('manifest 绑定的机器人与归档机器人不匹配');
  const packagePathSet = new Set();
  const packageFiles = (metadata.files || []).map((record) => {
    const path = normalizeArchivePath(record.path, '机器人资源路径');
    if (packagePathSet.has(path)) throw new Error(`机器人资源路径重复：${path}`);
    packagePathSet.add(path);
    const archivePath = normalizeArchivePath(record.archivePath, '机器人归档路径');
    const bytes = requiredAsset(files, archivePath);
    if (Number(record.byteLength) !== bytes.byteLength) {
      throw new Error(`机器人资源长度不匹配：${path}`);
    }
    return {
      path,
      mimeType: String(record.mimeType || mimeTypeForPath(path)),
      bytes: exactArrayBuffer(bytes),
    };
  });
  if (!packageFiles.some((file) => file.path === relativePath)) {
    throw new Error(`机器人归档缺少主文件：${relativePath}`);
  }
  return {
    schemaVersion: 1,
    packageName: metadata.packageName || project.robot?.packageName || '',
    packagePath: metadata.packagePath || project.robot?.packagePath || '',
    relativePath,
    format: metadata.format || project.robot?.format || extensionForPath(relativePath),
    resourceDigest: manifest.identities?.robot?.resourceDigest || null,
    files: packageFiles,
  };
};

const readProjectEntries = async (files, options = {}) => {
  options = { ...options, digests: options.digests || new WeakMap() };
  const {
    onProgress,
    source = 'zip',
    manifestLabel = source === 'zip' ? 'ZIP 清单' : '工程清单',
  } = options;
  validateArchiveEntryPaths(files);
  if (!options.nested && readJsonEntry(files, PROJECT_ARCHIVE_MANIFEST, manifestLabel).format === RESOURCE_PROJECT_FORMAT) {
    const expanded = await expandProjectResources(files, progressRange(onProgress, 0, 0.5));
    const imported = await readProjectEntries(expanded.files, { ...options, digests: expanded.digests,
      onProgress: progressRange(onProgress, 0.5, 1) });
    return { ...imported, manifest: { ...imported.manifest, archiveStorage: expanded.storage },
      archiveFileCount: Object.keys(files).filter((path) => !path.endsWith('/')).length };
  }
  const manifest = readJsonEntry(
    files,
    PROJECT_ARCHIVE_MANIFEST,
    manifestLabel,
  );
  if (manifest.format === WORKSPACE_PROJECT_ARCHIVE_FORMAT) {
    if (options.nested || manifest.archiveVersion !== WORKSPACE_PROJECT_ARCHIVE_VERSION
      || !LINKED_WORKSPACE_MODES.includes(manifest.activeMode)
      || !Array.isArray(manifest.independentHistory)) {
      throw new Error('完整工程包版本或结构不受支持');
    }
    // The root manifest and each child share one validation range. A child's
    // local percentage must never restart the overall archive progress.
    await verifyArchiveFiles(files, manifest, progressRange(onProgress, 0, 0.5), options.digests);
    const workspaceCount = Object.keys(manifest.workspaces || {}).length + manifest.independentHistory.length;
    let workspaceIndex = 0;
    const readWorkspace = async (descriptor, mode, prefix) => {
      if (descriptor?.prefix !== prefix || typeof descriptor.mapId !== 'string' || !descriptor.mapId) {
        throw new Error('完整工程工作区清单不完整');
      }
      const childFiles = Object.fromEntries(Object.entries(files)
        .filter(([path]) => path.startsWith(prefix) && path.length > prefix.length)
        .map(([path, bytes]) => [path.slice(prefix.length), bytes]));
      const start = 0.5 + workspaceIndex++ * 0.5 / workspaceCount;
      const child = await readProjectEntries(childFiles, { ...options, nested: true,
        onProgress: progressRange(onProgress, start, start + 0.5 / workspaceCount) });
      if (!child.portable) throw new Error('完整工程包含缺少资源的工作区');
      return { mode,
        map: { ...child.resources.map, mapId: descriptor.mapId, portableRobotPackage: child.resources.robot,
          portableOriginalMapId: descriptor.portableOriginalMapId || descriptor.mapId },
        config: { mapId: descriptor.mapId, config: { schemaVersion: 1, project: child.payload,
          ui: { ...child.payload.workspace, ...descriptor.ui, selectedRobot: child.payload.robot } } },
      };
    };
    const workspaces = {};
    for (const [mode, descriptor] of Object.entries(manifest.workspaces || {})) {
      if (!LINKED_WORKSPACE_MODES.includes(mode)) throw new Error('完整工程工作区模式无效');
      workspaces[mode] = await readWorkspace(descriptor, mode, `workspaces/${mode}/`);
    }
    const independentHistory = [];
    for (const [index, descriptor] of manifest.independentHistory.entries()) {
      independentHistory.push({ ...await readWorkspace(descriptor, 'independent', `independent-history/${index + 1}/`),
        archivedAt: descriptor.archivedAt });
    }
    const workspaceCollection = { workspaces, independentHistory, activeMode: manifest.activeMode };
    validateWorkspaceCollection(workspaceCollection);
    return { source, manifest, portable: true, workspaceCollection,
      archiveFileCount: Object.keys(files).filter((path) => !path.endsWith('/')).length };
  }
  if (manifest.format === LINKED_PROJECT_ARCHIVE_FORMAT) {
    if (options.nested || manifest.archiveVersion !== LINKED_PROJECT_ARCHIVE_VERSION
      || !LINKED_WORKSPACE_MODES.includes(manifest.activeMode)) {
      throw new Error('双边工程包版本或结构不受支持');
    }
    await verifyArchiveFiles(files, manifest, progressRange(onProgress, 0, 0.5), options.digests);
    const workspaces = {};
    for (const [index, mode] of LINKED_WORKSPACE_MODES.entries()) {
      const descriptor = manifest.workspaces?.[mode];
      const prefix = `workspaces/${mode}/`;
      if (descriptor?.prefix !== prefix || !descriptor.mapId) throw new Error('双边工程清单不完整');
      const childFiles = Object.fromEntries(Object.entries(files)
        .filter(([path]) => path.startsWith(prefix) && path.length > prefix.length)
        .map(([path, bytes]) => [path.slice(prefix.length), bytes]));
      const start = 0.5 + index * 0.5 / LINKED_WORKSPACE_MODES.length;
      const child = await readProjectEntries(childFiles, { ...options, nested: true,
        onProgress: progressRange(onProgress, start, start + 0.5 / LINKED_WORKSPACE_MODES.length) });
      workspaces[mode] = { mode,
        map: { ...child.resources.map, mapId: descriptor.mapId, portableRobotPackage: child.resources.robot },
        config: { mapId: descriptor.mapId, config: { schemaVersion: 1, project: child.payload,
          ui: { ...child.payload.workspace, ...descriptor.ui, selectedRobot: child.payload.robot } } },
      };
    }
    validateLinkedWorkspaces(workspaces);
    return { source, manifest, portable: true, linkedWorkspaces: workspaces,
      archiveFileCount: Object.keys(files).filter((path) => !path.endsWith('/')).length };
  }
  if (manifest.format !== PROJECT_ARCHIVE_FORMAT) {
    throw new Error('所选内容不是虚拟示教平台工程');
  }
  const archiveVersion = Number(manifest.archiveVersion) || 1;
  if (archiveVersion > PROJECT_ARCHIVE_VERSION) {
    throw new Error(`工程包版本 ${archiveVersion} 高于当前支持版本 ${PROJECT_ARCHIVE_VERSION}`);
  }
  await verifyArchiveFiles(files, manifest, onProgress, options.digests);
  const projectPath = normalizeArchivePath(
    manifest.projectFile || PROJECT_ARCHIVE_CONFIG,
    '工程配置路径',
  );
  const project = readJsonEntry(files, projectPath, '工程配置');
  const resources = archiveVersion >= 2
    ? {
        map: hydrateEnvironmentResource(project, files, manifest),
        robot: hydrateRobotResource(project, files, manifest),
      }
    : { map: null, robot: null };
  return {
    payload: hydrateProjectAssets(project, files),
    rawPayload: project,
    source,
    manifest,
    resources,
    portable: Boolean(resources.map && (!project.robot || resources.robot)),
    archiveFileCount: Object.keys(files).filter((path) => !path.endsWith('/')).length,
  };
};

export async function readProjectArchive(bytes, options = {}) {
  const files = await unzipEntries(bytes, {
    onProgress: progressRange(options.onProgress, 0, 0.35),
  });
  const imported = await readProjectEntries(files, {
    ...options,
    onProgress: progressRange(options.onProgress, 0.35, 1),
    source: 'zip',
  });
  options.onProgress?.({ phase: '校验工程包完整性', detail: '工程资源校验完成', progress: 1 });
  return imported;
}

const directoryFileHandle = async (rootHandle, path, create = false) => {
  const parts = normalizeArchivePath(path, '工程目录路径').split('/');
  const fileName = parts.pop();
  let directory = rootHandle;
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part, { create });
  }
  return directory.getFileHandle(fileName, { create });
};

const readDirectoryBytes = async (rootHandle, path) => {
  try {
    const handle = await directoryFileHandle(rootHandle, path, false);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    if (error?.name === 'NotFoundError') throw new Error(`工程目录缺少文件：${path}`);
    throw error;
  }
};

const manifestPaths = (manifest) => {
  if (!Array.isArray(manifest?.files) || !manifest.files.length) {
    throw new Error('工程目录缺少逐文件完整性清单，请先解压完整工程包');
  }
  return manifest.files.map((record) => normalizeArchivePath(record?.path, 'manifest 文件路径'));
};

export async function queryProjectDirectoryPermission(directoryHandle, request = false) {
  if (!directoryHandle || directoryHandle.kind !== 'directory') return 'denied';
  const descriptor = { mode: 'readwrite' };
  let permission = typeof directoryHandle.queryPermission === 'function'
    ? await directoryHandle.queryPermission(descriptor)
    : 'granted';
  if (permission !== 'granted' && request && typeof directoryHandle.requestPermission === 'function') {
    permission = await directoryHandle.requestPermission(descriptor);
  }
  return permission;
}

export async function readProjectDirectoryMetadata(directoryHandle) {
  const manifestBytes = await readDirectoryBytes(directoryHandle, PROJECT_ARCHIVE_MANIFEST);
  const manifest = logicalStorageManifest(readJsonEntry(
    { [PROJECT_ARCHIVE_MANIFEST]: manifestBytes },
    PROJECT_ARCHIVE_MANIFEST,
    '工程清单',
  ));
  if (manifest.format !== PROJECT_ARCHIVE_FORMAT) {
    throw new Error('所选文件夹不是虚拟示教平台工程目录');
  }
  const projectPath = normalizeArchivePath(
    manifest.projectFile || PROJECT_ARCHIVE_CONFIG,
    '工程配置路径',
  );
  const projectBytes = await readDirectoryBytes(directoryHandle, projectPath);
  const rawPayload = readJsonEntry({ [projectPath]: projectBytes }, projectPath, '工程配置');
  return {
    manifest,
    rawPayload,
    projectPath,
    name: String(directoryHandle.name || rawPayload.map?.fileName || '工程目录'),
  };
}

export async function readProjectDirectoryHandle(directoryHandle, options = {}) {
  if (!directoryHandle || directoryHandle.kind !== 'directory') {
    throw new Error('请选择完整的工程文件夹');
  }
  const permission = await queryProjectDirectoryPermission(
    directoryHandle,
    options.requestPermission === true,
  );
  if (permission !== 'granted') throw new Error('未获得工程文件夹的读写权限');

  const manifestBytes = await readDirectoryBytes(directoryHandle, PROJECT_ARCHIVE_MANIFEST);
  const manifest = readJsonEntry(
    { [PROJECT_ARCHIVE_MANIFEST]: manifestBytes },
    PROJECT_ARCHIVE_MANIFEST,
    '工程清单',
  );
  if (![PROJECT_ARCHIVE_FORMAT, LINKED_PROJECT_ARCHIVE_FORMAT, WORKSPACE_PROJECT_ARCHIVE_FORMAT, RESOURCE_PROJECT_FORMAT].includes(manifest.format)) {
    throw new Error('所选文件夹不是虚拟示教平台工程目录');
  }
  const paths = manifestPaths(manifest);
  const files = { [PROJECT_ARCHIVE_MANIFEST]: manifestBytes };
  await mapLimit(paths, 3, async (path, index) => {
    options.onProgress?.({
      phase: '读取工程目录',
      detail: `${index + 1} / ${paths.length} · ${path}`,
      progress: paths.length ? (index + 1) / paths.length * 0.35 : 0.35,
    });
    files[path] = await readDirectoryBytes(directoryHandle, path);
  });
  const imported = await readProjectEntries(files, {
    ...options,
    onProgress: progressRange(options.onProgress, 0.35, 1),
    source: 'directory',
    manifestLabel: '工程清单',
  });
  return {
    ...imported,
    directory: {
      handle: imported.linkedWorkspaces || imported.workspaceCollection ? null : directoryHandle,
      name: String(directoryHandle.name || '工程目录'),
      writable: !imported.linkedWorkspaces && !imported.workspaceCollection,
      projectFile: normalizeArchivePath(
        imported.manifest.projectFile || PROJECT_ARCHIVE_CONFIG,
        '工程配置路径',
      ),
    },
  };
}

const relativeDirectoryFiles = (fileList) => {
  const sourceFiles = Array.from(fileList || []);
  const manifestFile = sourceFiles.filter((file) => (
    String(file.webkitRelativePath || file.name).replaceAll('\\', '/').endsWith(`/${PROJECT_ARCHIVE_MANIFEST}`)
    || String(file.webkitRelativePath || file.name) === PROJECT_ARCHIVE_MANIFEST
  )).sort((left, right) => String(left.webkitRelativePath || left.name).split('/').length
    - String(right.webkitRelativePath || right.name).split('/').length)[0];
  if (!manifestFile) throw new Error('所选文件夹中没有 manifest.json');
  const manifestPath = String(manifestFile.webkitRelativePath || manifestFile.name).replaceAll('\\', '/');
  const prefix = manifestPath.slice(0, -PROJECT_ARCHIVE_MANIFEST.length);
  const files = new Map();
  sourceFiles.forEach((file) => {
    const fullPath = String(file.webkitRelativePath || file.name).replaceAll('\\', '/');
    if (!fullPath.startsWith(prefix)) return;
    const relativePath = fullPath.slice(prefix.length);
    if (!relativePath) return;
    files.set(normalizeArchivePath(relativePath, '工程目录路径'), file);
  });
  return { files, name: prefix.split('/').filter(Boolean).at(-1) || '工程目录' };
};

export async function readProjectDirectoryFiles(fileList, options = {}) {
  const selected = relativeDirectoryFiles(fileList);
  const manifestFile = selected.files.get(PROJECT_ARCHIVE_MANIFEST);
  const manifestBytes = new Uint8Array(await manifestFile.arrayBuffer());
  const manifest = readJsonEntry(
    { [PROJECT_ARCHIVE_MANIFEST]: manifestBytes },
    PROJECT_ARCHIVE_MANIFEST,
    '工程清单',
  );
  if (![PROJECT_ARCHIVE_FORMAT, LINKED_PROJECT_ARCHIVE_FORMAT, WORKSPACE_PROJECT_ARCHIVE_FORMAT, RESOURCE_PROJECT_FORMAT].includes(manifest.format)) {
    throw new Error('所选文件夹不是虚拟示教平台工程目录');
  }
  const paths = manifestPaths(manifest);
  const files = { [PROJECT_ARCHIVE_MANIFEST]: manifestBytes };
  await mapLimit(paths, 3, async (path, index) => {
    const file = selected.files.get(path);
    if (!file) throw new Error(`工程目录缺少文件：${path}`);
    options.onProgress?.({
      phase: '读取工程目录',
      detail: `${index + 1} / ${paths.length} · ${path}`,
      progress: paths.length ? (index + 1) / paths.length * 0.35 : 0.35,
    });
    files[path] = new Uint8Array(await file.arrayBuffer());
  });
  const imported = await readProjectEntries(files, {
    ...options,
    onProgress: progressRange(options.onProgress, 0.35, 1),
    source: 'directory-readonly',
    manifestLabel: '工程清单',
  });
  return {
    ...imported,
    directory: {
      handle: null,
      name: selected.name,
      writable: false,
      projectFile: normalizeArchivePath(
        imported.manifest.projectFile || PROJECT_ARCHIVE_CONFIG,
        '工程配置路径',
      ),
    },
  };
}

const cameraCaptureSignature = (capture) => {
  if (!capture || typeof capture !== 'object') return '';
  const frames = Object.entries(capture.frames || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([side, frame]) => ({
      side,
      capturedAt: String(frame?.capturedAt || ''),
      rgb: frame?.rgb
        ? [frame.rgb.mimeType, frame.rgb.width, frame.rgb.height, frame.rgb.byteLength]
        : null,
      cloud: frame?.pointCloud
        ? [
            frame.pointCloud.pointCount,
            frame.pointCloud.visiblePointCount,
            frame.pointCloud.byteLength,
            frame.pointCloud.positionOffset,
            frame.pointCloud.positionScale,
          ]
        : null,
    }));
  return JSON.stringify({
    capturedAt: String(capture.capturedAt || ''),
    cameraModel: String(capture.cameraModel || ''),
    frames,
  });
};

const externalizeTeachingTasksIncremental = (
  tasks,
  previousProject,
  entries,
  statistics,
) => {
  const previousPoses = new Map();
  (previousProject?.virtualTeaching?.tasks || []).forEach((task) => {
    (task.parkingPoints || []).forEach((parkingPoint) => {
      (parkingPoint.poses || []).forEach((pose) => {
        if (pose?.id) previousPoses.set(String(pose.id), pose);
      });
    });
  });

  return (Array.isArray(tasks) ? tasks : []).map((task, taskIndex) => {
    const taskRoot = `teaching-data/${indexedFolder(taskIndex, task.name, 'task')}`;
    const parkingPoints = (task.parkingPoints || []).map((parkingPoint, parkingIndex) => {
      const parkingRoot = `${taskRoot}/${indexedFolder(
        parkingIndex,
        parkingPoint.name,
        'parking-point',
      )}`;
      const poses = (parkingPoint.poses || []).map((pose, poseIndex) => {
        const poseRoot = `${parkingRoot}/${indexedFolder(poseIndex, pose.name, 'pose')}`;
        const previousPose = previousPoses.get(String(pose.id || ''));
        const canReuseCapture = Boolean(
          pose.cameraCapture
          && previousPose?.cameraCapture
          && cameraCaptureSignature(pose.cameraCapture)
            === cameraCaptureSignature(previousPose.cameraCapture),
        );
        const externalPose = {
          ...pose,
          cameraCapture: canReuseCapture
            ? previousPose.cameraCapture
            : externalizeCameraCapture(
                pose.cameraCapture,
                poseRoot,
                entries,
                statistics,
              ),
        };
        addEntry(entries, `${poseRoot}/pose.json`, jsonBytes({
          schemaVersion: 1,
          recordType: 'teaching-pose',
          task: { id: task.id, name: task.name, sequence: task.sequence },
          parkingPoint: {
            id: parkingPoint.id,
            name: parkingPoint.name,
            sequence: parkingPoint.sequence,
          },
          pose: externalPose,
        }));
        statistics.poseCount += 1;
        return externalPose;
      });
      statistics.parkingPointCount += 1;
      return { ...parkingPoint, poses };
    });
    statistics.taskCount += 1;
    return { ...task, parkingPoints };
  });
};

const teachingAssetStatistics = (tasks) => {
  const totals = {
    cameraFrameCount: 0,
    rgbFileCount: 0,
    pointCloudCount: 0,
    previewFileCount: 0,
  };
  (tasks || []).forEach((task) => {
    (task.parkingPoints || []).forEach((parkingPoint) => {
      (parkingPoint.poses || []).forEach((pose) => {
        Object.values(pose.cameraCapture?.frames || {}).forEach((frame) => {
          totals.cameraFrameCount += 1;
          if (frame?.rgb) totals.rgbFileCount += 1;
          if (frame?.pointCloud) totals.pointCloudCount += 1;
          if (frame?.pointCloud?.preview) totals.previewFileCount += 1;
        });
      });
    });
  });
  return totals;
};

const writeDirectoryBytes = async (rootHandle, path, bytes) => {
  const fileHandle = await directoryFileHandle(rootHandle, path, true);
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(asBytes(bytes));
    await writable.close();
  } catch (error) {
    try {
      await writable.abort?.();
    } catch {
      // The original write error carries the useful context.
    }
    throw error;
  }
};

export async function updateProjectDirectory(directoryHandle, payload, options = {}) {
  if (!payload || typeof payload !== 'object') throw new Error('工程配置为空，无法保存');
  if (await queryProjectDirectoryPermission(directoryHandle, false) !== 'granted') {
    throw new Error('工程目录写入权限已失效，请重新点击“加载工程”授权');
  }
  const previousManifest = options.manifest;
  const previousProject = options.rawPayload;
  if (!previousManifest || previousManifest.format !== PROJECT_ARCHIVE_FORMAT) {
    throw new Error('工程目录缺少有效 manifest，无法增量保存');
  }

  const entries = {};
  const statistics = {
    taskCount: 0,
    parkingPointCount: 0,
    poseCount: 0,
    cameraFrameCount: 0,
    rgbFileCount: 0,
    pointCloudCount: 0,
    previewFileCount: 0,
    assetByteLength: 0,
    environmentFileCount: 0,
    robotFileCount: 0,
  };
  const externalTasks = externalizeTeachingTasksIncremental(
    payload.virtualTeaching?.tasks,
    previousProject,
    entries,
    statistics,
  );
  Object.assign(statistics, teachingAssetStatistics(externalTasks));
  const projectPath = normalizeArchivePath(
    previousManifest.projectFile || previousProject?.archive?.projectFile || PROJECT_ARCHIVE_CONFIG,
    '工程配置路径',
  );
  const savedAt = new Date().toISOString();
  const project = {
    ...payload,
    schemaVersion: '1.3',
    archive: {
      ...(previousProject?.archive || {}),
      format: PROJECT_ARCHIVE_FORMAT,
      version: PROJECT_ARCHIVE_VERSION,
      manifestFile: PROJECT_ARCHIVE_MANIFEST,
      projectFile: projectPath,
      mediaStorage: 'external-files',
      resourceStorage: 'directory',
      saveMode: 'incremental',
    },
    virtualTeaching: {
      ...(payload.virtualTeaching || {}),
      tasks: externalTasks,
    },
  };
  addEntry(entries, projectPath, jsonBytes(project));
  addEntry(entries, PROJECT_DIRECTORY_DESCRIPTOR, jsonBytes({
    format: PROJECT_ARCHIVE_FORMAT,
    version: PROJECT_ARCHIVE_VERSION,
    kind: 'directory-project',
    manifestFile: PROJECT_ARCHIVE_MANIFEST,
    projectFile: projectPath,
    name: String(
      payload.virtualTeaching?.tasks?.[0]?.name
      || payload.map?.fileName
      || directoryHandle.name
      || '未命名工程'
    ),
    updatedAt: savedAt,
  }));

  const updatedRecords = new Map(
    (previousManifest.files || []).map((record) => [String(record.path), { ...record }]),
  );
  const candidatePaths = Object.keys(entries).sort();
  const changedPaths = [];
  for (let index = 0; index < candidatePaths.length; index += 1) {
    const path = candidatePaths[index];
    const bytes = asBytes(entries[path][0]);
    options.onProgress?.({
      phase: '增量保存工程',
      detail: `${index + 1} / ${candidatePaths.length} · ${path}`,
      progress: candidatePaths.length ? (index + 1) / candidatePaths.length : 1,
    });
    const record = {
      path,
      role: roleForArchivePath(path),
      byteLength: bytes.byteLength,
      sha256: await sha256Bytes(bytes),
    };
    const previousRecord = updatedRecords.get(path);
    if (
      previousRecord
      && Number(previousRecord.byteLength) === record.byteLength
      && String(previousRecord.sha256 || '') === record.sha256
    ) continue;
    updatedRecords.set(path, record);
    changedPaths.push(path);
  }
  const fileRecords = [...updatedRecords.values()]
    .sort((left, right) => String(left.path).localeCompare(String(right.path)));
  statistics.environmentFileCount = fileRecords
    .filter((record) => String(record.path).startsWith('environment/')).length;
  statistics.robotFileCount = fileRecords
    .filter((record) => String(record.path).startsWith('robot/')).length;
  const projectRecord = updatedRecords.get(projectPath);
  let manifest = {
    ...previousManifest,
    archiveVersion: PROJECT_ARCHIVE_VERSION,
    schemaVersion: project.schemaVersion,
    projectFile: projectPath,
    portable: true,
    updatedAt: savedAt,
    saveMode: 'incremental-directory',
    files: fileRecords,
    statistics: {
      ...(previousManifest.statistics || {}),
      ...statistics,
      assetByteLength: fileRecords
        .filter((file) => !['project-config', 'project-descriptor', 'instructions'].includes(file.role))
        .reduce((total, file) => total + Number(file.byteLength || 0), 0),
      projectJsonByteLength: Number(projectRecord?.byteLength || 0),
      fileCount: fileRecords.length + 1,
    },
  };

  const storageUpdate = await updateStorageReferences(manifest, changedPaths.map((path) => updatedRecords.get(path)),
    (path) => readDirectoryBytes(directoryHandle, path));
  manifest = storageUpdate.manifest;

  // New assets are committed before the config that references them; manifest is the final commit marker.
  const writeOrder = changedPaths.sort((left, right) => {
    const priority = (path) => (
      path === projectPath ? 2 : path === PROJECT_DIRECTORY_DESCRIPTOR ? 3 : 1
    );
    return priority(left) - priority(right) || left.localeCompare(right);
  });
  for (const { path, bytes } of storageUpdate.preserved) await writeDirectoryBytes(directoryHandle, path, bytes);
  for (const path of writeOrder) {
    await writeDirectoryBytes(directoryHandle, path, entries[path][0]);
  }
  await writeDirectoryBytes(directoryHandle, PROJECT_ARCHIVE_MANIFEST, jsonBytes(physicalStorageManifest(manifest)));
  return { manifest, rawPayload: project, savedAt, writtenFileCount: writeOrder.length + storageUpdate.preserved.length + 1 };
}

const hasZipSignature = (bytes) => (
  bytes.length >= 4
  && bytes[0] === 0x50
  && bytes[1] === 0x4b
  && [0x03, 0x05, 0x07].includes(bytes[2])
  && [0x04, 0x06, 0x08].includes(bytes[3])
);

export async function readProjectFile(file, options = {}) {
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (hasZipSignature(signature) || String(file.name || '').toLowerCase().endsWith('.zip')) {
    return readProjectArchive(file, options);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let payload;
  try {
    payload = JSON.parse(strFromU8(bytes).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`JSON 解析失败：${error.message}`);
  }
  if (payload?.format === TEACHING_DATA_FORMAT) {
    throw new Error('这是轻量示教数据文件，不能作为完整工程加载；请使用工程 ZIP 或工程目录');
  }
  return {
    payload,
    rawPayload: payload,
    source: 'json',
    manifest: null,
    resources: { map: null, robot: null },
    portable: false,
    archiveFileCount: 0,
  };
}
