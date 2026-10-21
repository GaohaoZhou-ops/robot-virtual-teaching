// Shared, JSON-only synchronization. Entity arrays are addressed by ID, never
// by index, so edits to different parking points in one task remain independent.
export const WORK_SYNC_INTERVAL = 3000;
export const WORK_SYNC_LEASE = 5 * 60 * 1000;
const collections = ['waypoints', 'edges', 'abxRoutes', 'teachingTasks', 'jointPoses'];
const fields = new Set([...collections, 'independentTeachingName']);
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const equal = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => own(b, key) && equal(a[key], b[key]));
};
const idArray = (value) => Array.isArray(value) && value.every((item) => object(item)
  && typeof item.id === 'string' && item.id.length > 0)
  && new Set(value.map((item) => item.id)).size === value.length;

export function syncDocument(project) {
  // Match the wire representation, including optional fields omitted by JSON.
  return JSON.parse(JSON.stringify(Object.fromEntries([
    ...collections.map((key) => [key, project[key] || []]),
    ['independentTeachingName', project.workspace?.independentTeachingName || ''],
  ])));
}

function validateJSON(value, depth = 0) {
  if (depth > 48) throw new Error('同步数据层级过深');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach((item) => validateJSON(item, depth + 1)); return; }
  if (!object(value)) throw new Error('同步数据必须为 JSON');
  for (const [key, item] of Object.entries(value)) {
    if (unsafeKeys.has(key)) throw new Error('同步字段无效');
    validateJSON(item, depth + 1);
  }
}

export function validateSyncDocument(document) {
  validateJSON(document);
  if (!object(document) || Object.keys(document).some((key) => !fields.has(key))
    || collections.some((key) => !idArray(document[key]))
    || typeof document.independentTeachingName !== 'string') throw new Error('同步工程数据无效');
  return document;
}

export function diffSyncDocument(before, after) {
  const operations = [];
  const visit = (a, b, path) => {
    if (equal(a, b)) return;
    if (idArray(a) && idArray(b)) {
      const old = new Map(a.map((item) => [item.id, item]));
      const next = new Map(b.map((item) => [item.id, item]));
      for (const item of a) if (!next.has(item.id)) operations.push({ type: 'delete', path: [...path, { id: item.id }] });
      for (const item of b) visit(old.get(item.id), item, [...path, { id: item.id }]);
      if (!equal(a.map((item) => item.id), b.map((item) => item.id))) {
        operations.push({ type: 'order', path, value: b.map((item) => item.id) });
      }
    } else if (object(a) && object(b)) {
      for (const key of Object.keys(a)) if (!own(b, key)) operations.push({ type: 'delete', path: [...path, key] });
      for (const key of Object.keys(b)) visit(a[key], b[key], [...path, key]);
    } else operations.push({ type: 'set', path, value: structuredClone(b) });
  };
  visit(before, after, []);
  return operations;
}

export function applySyncOperations(document, operations) {
  if (!Array.isArray(operations) || operations.length > 50000) throw new Error('同步操作数量无效');
  const result = structuredClone(document);
  for (const operation of operations) {
    const { type, path, value } = operation || {};
    if (!['set', 'delete', 'order'].includes(type) || !Array.isArray(path) || !path.length
      || path.length > 48 || !fields.has(path[0]) || path.some((part) => typeof part === 'string'
        ? unsafeKeys.has(part) : !object(part) || Object.keys(part).length !== 1 || typeof part.id !== 'string' || !part.id)) {
      throw new Error('同步操作路径无效');
    }
    if (type !== 'delete') validateJSON(value);
    let parent = result;
    // A removed ancestor stays removed; stale edits cannot resurrect its children.
    for (const part of path.slice(0, -1)) {
      parent = typeof part === 'string'
        ? object(parent) && own(parent, part) ? parent[part] : undefined
        : Array.isArray(parent) ? parent.find((item) => item?.id === part.id) : undefined;
      if (parent == null) break;
    }
    if (parent == null) continue;
    const last = path.at(-1);
    const index = typeof last === 'string' ? last
      : Array.isArray(parent) ? parent.findIndex((item) => item?.id === last.id) : -1;
    if (type === 'order') {
      const array = parent[index];
      if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) throw new Error('同步排序无效');
      if (!idArray(array)) continue;
      const rank = new Map(value.map((id, offset) => [id, offset]));
      array.sort((a, b) => (rank.get(a.id) ?? value.length) - (rank.get(b.id) ?? value.length));
    } else if (typeof last !== 'string') {
      if (!Array.isArray(parent)) continue;
      if (type === 'delete') { if (index >= 0) parent.splice(index, 1); }
      else {
        if (!object(value) || value.id !== last.id) throw new Error('同步实体标识不匹配');
        if (index < 0) parent.push(structuredClone(value));
        else parent[index] = structuredClone(value);
      }
    } else {
      if (!object(parent)) throw new Error('同步字段类型无效');
      if (type === 'delete') delete parent[index];
      else parent[index] = structuredClone(value);
    }
  }
  return validateSyncDocument(result);
}

// Preserve edits made while an exchange was in flight, without echoing the
// remote changes as fresh local edits on the following three-second cycle.
export function rebaseSyncDocument(remote, sentLocal, currentLocal) {
  return applySyncOperations(remote, diffSyncDocument(sentLocal, currentLocal));
}

// Keep unchanged capture/geometry-adjacent references stable. Background teaching
// jobs use those references to detect actual changes to their source data.
export function retainSyncReferences(previous, next) {
  if (equal(previous, next)) return previous;
  if (Array.isArray(previous) && Array.isArray(next)) {
    const byId = idArray(previous) && idArray(next) ? new Map(previous.map((item) => [item.id, item])) : null;
    return next.map((item, index) => retainSyncReferences(byId ? byId.get(item.id) : previous[index], item));
  }
  if (object(previous) && object(next)) return Object.fromEntries(Object.entries(next)
    .map(([key, value]) => [key, retainSyncReferences(previous[key], value)]));
  return next;
}
