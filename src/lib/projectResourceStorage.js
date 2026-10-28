import { strFromU8, strToU8 } from 'fflate';
import { Matrix4, Vector3 } from 'three';
import { sha256Bytes } from './hash.js';

// This envelope changes only the on-disk representation. The existing project
// reader still receives the same logical files and validates their old hashes.
export const RESOURCE_PROJECT_FORMAT = 'atlas-route-studio-resource-project';
const VERSION = 1;
const jsonBytes = (value) => strToU8(JSON.stringify(value, null, 2));
const bytesOf = (value) => value instanceof Uint8Array ? value
  : value instanceof ArrayBuffer ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
const validPath = (path) => typeof path === 'string' && path.length > 0
  && !/[\\\0]/.test(path) && !/^[a-z]:\//i.test(path)
  && path.split('/').every((part) => part && part !== '.' && part !== '..');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));

export function logicalStorageManifest(manifest) {
  if (manifest?.format !== RESOURCE_PROJECT_FORMAT) return manifest;
  check(manifest.archiveVersion === VERSION && manifest.projectManifest
    && manifest.projectManifest.format !== RESOURCE_PROJECT_FORMAT
    && !manifest.projectManifest.archiveStorage, '共享资源工程包版本或结构不受支持');
  return { ...manifest.projectManifest,
    archiveStorage: { version: VERSION, files: manifest.files, references: manifest.references } };
}

export function physicalStorageManifest(manifest) {
  const { archiveStorage, ...projectManifest } = manifest;
  return archiveStorage ? { format: RESOURCE_PROJECT_FORMAT, archiveVersion: VERSION,
    projectManifest, files: archiveStorage.files, references: archiveStorage.references } : manifest;
}

// Incremental directory saves keep existing shared resources in place. A changed
// logical file becomes a normal file; no other group or shared blob is modified.
export async function updateStorageReferences(manifest, changedRecords, readBytes) {
  if (!manifest.archiveStorage) return { manifest, preserved: [] };
  const files = new Map(manifest.archiveStorage.files.map((record) => [record.path, record]));
  const references = structuredClone(manifest.archiveStorage.references), preserved = [];
  for (const record of changedRecords) {
    const users = Object.values(references).flatMap((reference) => reference.parts || [reference])
      .filter((part) => part.resource === record.path);
    if (users.length) {
      // Copy on write: replacing the canonical photo must not change another
      // pose that still references its original bytes.
      const previous = files.get(record.path), bytes = await readBytes(record.path);
      check(previous && bytes.byteLength === previous.byteLength
        && await sha256Bytes(bytes) === previous.sha256, `工程包 SHA-256 校验失败：${record.path}`);
      const path = `resources/${previous.sha256}.bin`;
      if (!files.has(path)) {
        preserved.push({ path, bytes });
        files.set(path, { ...previous, path });
      }
      users.forEach((part) => { part.resource = path; });
    }
    delete references[record.path];
    files.set(record.path, record);
  }
  return { manifest: { ...manifest, archiveStorage: { version: VERSION, references, files: [...files.values()] } }, preserved };
}

// Parts always refer directly to physical bytes, never to another recipe. This
// prevents cycles and makes the expanded size computable before allocation.
export async function restoreResourceParts(parts, getResource, expectedByteLength) {
  check(Array.isArray(parts) && parts.length > 0, '共享资源重建记录无效');
  const inputs = parts.map((part) => {
    check(validPath(part?.resource), '共享资源引用路径无效');
    const bytes = getResource(part.resource);
    check(bytes instanceof Uint8Array, `工程包缺少共享资源：${part.resource}`);
    let length = bytes.byteLength;
    if (part.kind === 'positions') {
      check(length % 12 === 0 && Array.isArray(part.matrix) && part.matrix.length === 16
        && part.matrix.every(Number.isFinite) && [3, 7, 11].every((i) => part.matrix[i] === 0)
        && part.matrix[15] === 1, '共享模型转换矩阵无效');
    } else if (part.kind === 'indices') {
      check([2, 4].includes(part.stride) && length % (part.stride * 3) === 0
        && Number.isSafeInteger(part.offset) && part.offset >= 0, '共享模型索引转换无效');
      length = length / part.stride * 4;
    } else check(part.kind === 'bytes', '共享资源重建类型不受支持');
    return { part, bytes, length };
  });
  const size = inputs.reduce((sum, input) => sum + input.length, 0);
  check(Number.isSafeInteger(size) && size > 0 && size === expectedByteLength, '共享资源重建长度无效');
  const result = new Uint8Array(size);
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const { part, bytes, length } of inputs) {
    if (part.kind === 'bytes') result.set(bytes, offset);
    else {
      const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (part.kind === 'positions') {
        const matrix = new Matrix4().fromArray(part.matrix), point = new Vector3();
        for (let i = 0; i < length; i += 12) {
          point.set(source.getFloat32(i, true), source.getFloat32(i + 4, true), source.getFloat32(i + 8, true)).applyMatrix4(matrix);
          view.setFloat32(offset + i, point.x, true);
          view.setFloat32(offset + i + 4, point.y, true);
          view.setFloat32(offset + i + 8, point.z, true);
          if (i && i % 3000000 === 0) await yieldToUI();
        }
      } else {
        for (let i = 0; i < bytes.byteLength; i += part.stride) {
          const value = (part.stride === 2 ? source.getUint16(i, true) : source.getUint32(i, true)) + part.offset;
          check(value <= 0xffffffff, '共享模型索引超出范围');
          view.setUint32(offset + i / part.stride * 4, value, true);
          if (i && i % 3000000 === 0) await yieldToUI();
        }
      }
    }
    offset += length;
  }
  return result;
}

export async function compactProjectResources(entries, manifest, recipes = new Map(), onProgress) {
  const physical = {}, records = new Map(), references = {}, byContent = new Map();
  const declared = new Map(manifest.files.map((record) => [record.path, record]));
  // Keep readable configuration/metadata at their established paths. Only heavy
  // resources are shared; distinct teaching groups retain distinct configs.
  const shareable = (path) => /(^|\/)(environment\/(?!map\.json$)|robot\/files\/|teaching-data\/.*\/(rgb|pointcloud)\/)/.test(path)
    && !path.endsWith('.json');
  const store = async (bytes, preferredPath, compression = 1) => {
    bytes = bytesOf(bytes);
    const digest = declared.get(preferredPath)?.sha256 || await sha256Bytes(bytes);
    const key = `${bytes.byteLength}:${digest}`;
    if (byContent.has(key)) return byContent.get(key);
    const path = preferredPath || `resources/${digest}.bin`;
    physical[path] = [bytes, { level: compression }];
    records.set(path, { path, byteLength: bytes.byteLength, sha256: digest });
    byContent.set(key, path);
    return path;
  };
  // Ordinary model resources go first, so map recipes can reference the same
  // physical geometry as independent groups rather than writing a second copy.
  for (const [path, entry] of Object.entries(entries)) {
    if (path === 'manifest.json' || recipes.has(path)) continue;
    if (shareable(path)) {
      const resource = await store(entry[0], path, entry[1]?.level);
      if (resource !== path) references[path] = { resource };
    } else {
      physical[path] = entry;
      records.set(path, declared.get(path) || { path, byteLength: entry[0].byteLength, sha256: await sha256Bytes(entry[0]) });
    }
  }
  for (const [path, parts] of recipes) {
    const stored = [];
    for (const { bytes, ...part } of parts) stored.push({ ...part, resource: await store(bytes) });
    references[path] = { parts: stored };
  }
  if (!Object.keys(references).length) return { entries, manifest, storage: null };
  const storage = { version: VERSION, references, files: [...records.values()] };
  const storedManifest = { ...manifest, archiveStorage: storage };
  physical['manifest.json'] = [jsonBytes(physicalStorageManifest(storedManifest)), { level: 6 }];
  onProgress?.({ phase: '共享重复模型与资源', detail: `${Object.keys(references).length} 个资源使用共享存储` });
  return { entries: physical, manifest: storedManifest, storage: {
    referenceCount: Object.keys(references).length,
    logicalByteLength: manifest.files.reduce((sum, file) => sum + file.byteLength, 0),
    storedByteLength: storage.files.reduce((sum, file) => sum + file.byteLength, 0),
  } };
}

// Exported for archive/directory readers and format regression fixtures. Legacy
// archives are returned unchanged, with no migration or cache reset required.
export async function expandProjectResources(files, onProgress) {
  const envelope = JSON.parse(strFromU8(files['manifest.json']).replace(/^\uFEFF/, ''));
  if (envelope.format !== RESOURCE_PROJECT_FORMAT) return { files, storage: null };
  const manifest = logicalStorageManifest(envelope);
  const storage = manifest.archiveStorage;
  check(Array.isArray(storage.files) && storage.files.length > 0 && storage.references
    && typeof storage.references === 'object' && !Array.isArray(storage.references)
    && Array.isArray(envelope.projectManifest.files), '共享资源工程清单无效');
  const physicalPaths = new Set();
  const digests = new WeakMap();
  for (const [index, record] of storage.files.entries()) {
    check(validPath(record?.path) && record.path !== 'manifest.json' && !physicalPaths.has(record.path), '共享资源清单路径无效或重复');
    physicalPaths.add(record.path);
    const bytes = files[record.path];
    check(bytes instanceof Uint8Array, `工程包缺少共享资源：${record.path}`);
    check(bytes.byteLength === record.byteLength, `工程包文件长度校验失败：${record.path}`);
    const digest = await sha256Bytes(bytes);
    check(digest === record.sha256, `工程包 SHA-256 校验失败：${record.path}`);
    digests.set(bytes, digest);
    onProgress?.({ phase: '校验共享资源', detail: record.path, progress: (index + 1) / storage.files.length * 0.5 });
  }
  for (const path of Object.keys(files)) check(path.endsWith('/') || path === 'manifest.json'
    || physicalPaths.has(path), `工程包包含未登记文件：${path}`);
  const logical = envelope.projectManifest.files;
  const paths = new Set(logical.map((record) => record.path));
  check(paths.size === logical.length, '共享资源工程包含重复文件');
  for (const path of Object.keys(storage.references)) check(paths.has(path) && !physicalPaths.has(path), '共享资源引用目标冲突');
  const expanded = Object.create(null);
  expanded['manifest.json'] = jsonBytes(envelope.projectManifest);
  const getResource = (path) => physicalPaths.has(path) ? files[path] : undefined;
  for (const [index, record] of logical.entries()) {
    check(validPath(record?.path) && record.path !== 'manifest.json', '共享资源逻辑路径无效');
    const reference = Object.hasOwn(storage.references, record.path) ? storage.references[record.path] : null;
    let bytes;
    if (!reference) bytes = getResource(record.path);
    else if (reference.resource && !reference.parts) {
      check(validPath(reference.resource), '共享资源引用路径无效');
      bytes = getResource(reference.resource);
    } else if (reference.parts && !reference.resource) bytes = await restoreResourceParts(reference.parts, getResource, record.byteLength);
    else throw new Error('共享资源引用格式无效');
    check(bytes instanceof Uint8Array, `工程包缺少共享资源：${record.path}`);
    check(bytes.byteLength === record.byteLength, `工程包文件长度校验失败：${record.path}`);
    const digest = digests.get(bytes) || await sha256Bytes(bytes);
    check(digest === record.sha256, `工程包 SHA-256 校验失败：${record.path}`);
    digests.set(bytes, digest);
    expanded[record.path] = bytes;
    onProgress?.({ phase: '恢复共享模型与资源', detail: record.path, progress: 0.5 + (index + 1) / logical.length * 0.5 });
  }
  return { files: expanded, storage, digests };
}
