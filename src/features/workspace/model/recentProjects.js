import { loadProjectDirectoryBinding } from './projectDirectoryStore.js';
import { listProjectSaveTargets } from './projectSaveTarget.js';

export const RECENT_PROJECT_LIMIT = 10;
export const RECENT_PROJECTS_CHANGED = 'atlas-recent-projects-changed';
const DATABASE_NAME = 'atlas-recent-projects';
const STORE_NAME = 'history';
let writeChain = Promise.resolve();

const withStore = async (mode, operation) => {
  const database = await new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('当前浏览器无法保存最近工程记录'));
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('最近工程记录保存失败'));
    });
  } finally {
    database.close();
  }
};

const readHistory = () => withStore('readonly', (store) => store.get('recent'));

// Earlier versions retained one ZIP and one directory per teaching mode. Import
// those references once; removed records must not reappear on the next visit.
const legacyHistory = async () => {
  const results = await Promise.allSettled([
    listProjectSaveTargets(), loadProjectDirectoryBinding('map'), loadProjectDirectoryBinding('independent'),
  ]);
  const sources = results.flatMap((result) => result.status === 'fulfilled' ? result.value || [] : []);
  let records = [];
  for (const source of sources) {
    let updatedAt = source.savedAt || null;
    if (!updatedAt && source.handle?.kind === 'file') {
      try { updatedAt = new Date((await source.handle.getFile()).lastModified).toISOString(); }
      catch { /* The user can authorize the old file when opening it. */ }
    }
    records = await upsertRecord(records, { ...source, updatedAt });
  }
  return records.sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0));
};

export const listRecentProjects = async () => {
  const records = await readHistory();
  return Array.isArray(records) ? records.slice(0, RECENT_PROJECT_LIMIT) : updateHistory((initial) => initial);
};

// Handle comparison is asynchronous, so keep it outside an IndexedDB transaction.
// The lock also prevents two tabs from losing each other's history updates.
const updateHistory = (operation) => {
  const update = async () => {
    const previous = await readHistory();
    const records = await operation(Array.isArray(previous) ? previous : await legacyHistory());
    await withStore('readwrite', (store) => store.put(records, 'recent'));
    globalThis.dispatchEvent?.(new Event(RECENT_PROJECTS_CHANGED));
    return records;
  };
  const pending = writeChain.catch(() => undefined).then(() => globalThis.navigator?.locks
    ? navigator.locks.request(DATABASE_NAME, update) : update());
  writeChain = pending;
  return pending;
};

const upsertRecord = async (records, source) => {
  const handle = ['file', 'directory'].includes(source.handle?.kind) ? source.handle : null;
  const kind = handle?.kind || (source.kind === 'directory' ? 'directory' : 'file');
  const name = String(handle?.name || source.name || '').trim();
  if (!name) throw new Error('最近工程缺少名称');
  const teachingSpaceMode = source.teachingSpaceMode === 'independent' ? 'independent' : 'map';
  const path = String(source.path || (kind === 'directory'
    ? `${name}/${source.projectFile || 'config/project.json'}` : name));
  let previous = records.find((record) => record.id === source.id);
  if (!previous) {
    for (const record of records) {
      if (record.kind !== kind) continue;
      if (handle && record.handle) {
        try {
          if (await handle.isSameEntry(record.handle)) { previous = record; break; }
        } catch { /* An unavailable old handle must not block recording a new file. */ }
      } else if (!handle && !record.handle && record.path === path && record.teachingSpaceMode === teachingSpaceMode) {
        previous = record;
        break;
      }
    }
  }
  const record = {
    id: previous?.id || globalThis.crypto?.randomUUID?.() || `project-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    kind, name, path, handle, teachingSpaceMode,
    source: source.source || 'local',
    updatedAt: source.updatedAt === undefined ? new Date().toISOString() : source.updatedAt,
  };
  return [record, ...records.filter((item) => item.id !== previous?.id)].slice(0, RECENT_PROJECT_LIMIT);
};

export const rememberRecentProject = (source) => updateHistory((records) => upsertRecord(records, {
  ...source, updatedAt: new Date().toISOString(),
}));

export const removeRecentProject = (id) => updateHistory((records) => records.filter((record) => record.id !== id));

// Call this directly from the open button before awaiting other work, so that
// browser authorization can use the original user activation.
export const requestRecentProjectPermission = (record) => {
  if (typeof record.handle?.requestPermission !== 'function') return Promise.resolve('granted');
  return record.handle.requestPermission({ mode: record.kind === 'directory' ? 'readwrite' : 'read' });
};
