import { validateWorkspaceCollection } from './projectWorkspaceCollection.js';
import { normalizeIndependentTeachingName, validateIndependentTeachingName } from './independentTeachingName.js';
import { matchesPlacedSource } from './placedObjectRendering.js';
import { sharedRobotPresetEntries, withSharedRobotPresetConfig, mergeImportedRobotPresets } from './sharedRobotPresets.js';

const DATABASE_NAME = 'atlas-route-studio';
const DATABASE_VERSION = 1;
const STORE_NAME = 'workspace-session';
const VIEW_STATE_KEY = 'atlas-route-studio:view-state-v1';
const CURRENT_KEYS = ['meta', 'map', 'config'];
const RECOVERY_KEYS = ['recovery-meta', 'recovery-map', 'recovery-config'];
const WORKSPACE_INDEX_KEY = 'workspace-slots';
const WORKSPACE_MODES = ['map', 'independent'];
// History survives workspace switches and service-session recovery.
const INDEPENDENT_HISTORY_KEY = 'independent-history';
const SHARED_ROBOT_PRESETS_KEY = 'shared-robot-presets';
const historyMapKey = (id) => `independent-history-map:${id}`;
const historyConfigKey = (id) => `independent-history-config:${id}`;

const normalizeWorkspaceMode = (value) => value === 'independent' ? 'independent' : 'map';
const workspaceMapKey = (mode) => `workspace-map:${normalizeWorkspaceMode(mode)}`;
const workspaceConfigKey = (mode) => `workspace-config:${normalizeWorkspaceMode(mode)}`;
const workspaceViewKey = (mode) => `${VIEW_STATE_KEY}:${normalizeWorkspaceMode(mode)}`;
const ALL_WORKSPACE_KEYS = [
  ...CURRENT_KEYS,
  WORKSPACE_INDEX_KEY,
  ...WORKSPACE_MODES.flatMap((mode) => [workspaceMapKey(mode), workspaceConfigKey(mode)]),
];

let databasePromise = null;

// Retain the last shared baseline separately from the user's live workspace.
// Reauthorization can then upload offline work without restoring stale poses.
export async function loadWorkSyncCheckpoint(projectKey) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  return (await requestResult(transaction.objectStore(STORE_NAME).get(`work-sync:${projectKey}`)))?.checkpoint || null;
}

export async function saveWorkSyncCheckpoint(checkpoint) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).put({ key: `work-sync:${checkpoint.projectKey}`, checkpoint });
  await transactionComplete(transaction);
}

const MAP_BUFFER_FIELDS = ['positionBuffer', 'colorBuffer', 'indexBuffer'];
const MAX_INLINE_MAP_BYTES = 64 * 1024 * 1024;

const binaryByteLength = (value) => value instanceof ArrayBuffer || ArrayBuffer.isView(value)
  ? value.byteLength : 0;

const packMapRecord = (record) => {
  const files = record?.portableRobotPackage?.files || [];
  const byteLength = MAP_BUFFER_FIELDS.reduce((sum, key) => sum + binaryByteLength(record?.[key]), 0)
    + files.reduce((sum, file) => sum + binaryByteLength(file.bytes), 0);
  if (byteLength <= MAX_INLINE_MAP_BYTES) return record;
  // Large maps plus bundled robot meshes can exceed IndexedDB's per-value
  // serialization limit. Blobs store the binary payload outside that value.
  const packed = { ...record };
  for (const key of MAP_BUFFER_FIELDS) {
    if (binaryByteLength(record[key])) packed[key] = new Blob([record[key]]);
  }
  if (record.portableRobotPackage) {
    packed.portableRobotPackage = { ...record.portableRobotPackage,
      files: files.map((file) => ({ ...file, bytes: binaryByteLength(file.bytes)
        ? new Blob([file.bytes], { type: file.mimeType || 'application/octet-stream' }) : file.bytes })) };
  }
  return packed;
};

const unpackMapRecord = async (record) => {
  if (!record) return null;
  const unpacked = { ...record };
  await Promise.all(MAP_BUFFER_FIELDS.map(async (key) => {
    if (record[key] instanceof Blob) unpacked[key] = await record[key].arrayBuffer();
  }));
  if (record.portableRobotPackage) {
    unpacked.portableRobotPackage = { ...record.portableRobotPackage,
      files: await Promise.all(record.portableRobotPackage.files.map(async (file) => ({ ...file,
        bytes: file.bytes instanceof Blob ? await file.bytes.arrayBuffer() : file.bytes }))) };
  }
  return unpacked;
};

const browserStorage = () => {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
};

export function saveWorkspaceViews(sessionId, mapId, views, mode = 'map') {
  const storage = browserStorage();
  if (!storage || !sessionId || !mapId) return false;
  try {
    const payload = JSON.stringify({
      version: 2,
      sessionId,
      mapId,
      teachingSpaceMode: normalizeWorkspaceMode(mode),
      view2d: views?.view2d || null,
      view3d: views?.view3d || null,
      savedAt: Date.now(),
    });
    storage.setItem(workspaceViewKey(mode), payload);
    storage.setItem(VIEW_STATE_KEY, payload);
    return true;
  } catch {
    return false;
  }
}

export function loadWorkspaceViews(sessionId, mapId, mode = 'map') {
  const storage = browserStorage();
  if (!storage || !sessionId) return null;
  try {
    const modeKey = workspaceViewKey(mode);
    const payload = JSON.parse(
      storage.getItem(modeKey)
      || storage.getItem(VIEW_STATE_KEY)
      || 'null',
    );
    if (payload?.sessionId === sessionId && mapId && payload?.mapId === mapId) return payload;
    storage.removeItem(modeKey);
  } catch {
    try {
      storage.removeItem(workspaceViewKey(mode));
    } catch {
      // A blocked storage backend should not prevent the IndexedDB fallback.
    }
  }
  return null;
}

const requestResult = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('本地存储请求失败'));
  });

const transactionComplete = (transaction) =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = (event) => reject(event.target?.error || transaction.error || new Error('本地存储事务失败'));
    transaction.onabort = () => reject(transaction.error || new Error('本地存储事务已取消'));
  });

const openDatabase = () => {
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error('当前浏览器不支持 IndexedDB'));
  }
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error || new Error('无法打开本地工作区'));
    };
  });

  return databasePromise;
};

const emptyPresetLibrary = () => ({ key: SHARED_ROBOT_PRESETS_KEY, version: 1, revision: 0, poses: [] });
const samePresets = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const presetConfigKey = key => typeof key === 'string' && (key === 'config' || key === 'recovery-config'
  || key.startsWith('workspace-config:') || key.startsWith('independent-history-config:'));
const readPresetConfigs = async (store) => {
  // Never deserialize the potentially huge point clouds just to migrate poses.
  const keys = (await requestResult(store.getAllKeys())).filter(presetConfigKey);
  return Promise.all(keys.map(key => requestResult(store.get(key))));
};
const writePresetSnapshots = (store, records, library) => {
  for (const record of records) {
    const config = withSharedRobotPresetConfig(record.config, library.poses);
    if (JSON.stringify(config?.project?.virtualTeaching?.jointPoses) !== JSON.stringify(record.config?.project?.virtualTeaching?.jointPoses)) {
      store.put({ ...record, config, savedAt: Date.now() });
    }
  }
};

// One device-wide library survives ordinary workspace switches. The initial
// migration deliberately takes the MAP copy, including an explicitly empty
// map list; independent copies never get merged back on later reloads.
export async function loadSharedRobotPresets() {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const completion = transactionComplete(transaction), store = transaction.objectStore(STORE_NAME);
  let library;
  try {
    const [existing, records] = await Promise.all([
      requestResult(store.get(SHARED_ROBOT_PRESETS_KEY)), readPresetConfigs(store),
    ]);
    library = existing || emptyPresetLibrary();
    if (!existing) {
      const available = records.filter(record => record.config?.project);
      const source = available.find(record => record.key === workspaceConfigKey('map'))
        || available.find(record => record.key === 'config' && inferWorkspaceMode(null, record) === 'map')
        || available.find(record => record.key === workspaceConfigKey('independent'))
        || available.find(record => record.key === 'config') || available[0];
      if (source) {
        library = { ...library, revision: 1, poses: sharedRobotPresetEntries(source.config.project), savedAt: Date.now() };
        store.put(library);
      }
    }
    if (library.revision) writePresetSnapshots(store, records, library);
  } catch (error) {
    transaction.abort(); await completion.catch(() => undefined); throw error;
  }
  await completion;
  return library;
}

// Explicit ZIP/directory imports may add new presets, retaining the current
// shared edits on identity/name conflicts. Ordinary cache restoration never does.
export async function importSharedRobotPresets(sessionId, incoming) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const completion = transactionComplete(transaction), store = transaction.objectStore(STORE_NAME);
  let library;
  try {
    const [meta, existing, records] = await Promise.all([
      requestResult(store.get('meta')), requestResult(store.get(SHARED_ROBOT_PRESETS_KEY)), readPresetConfigs(store),
    ]);
    if (!sessionId || meta?.sessionId !== sessionId) throw new Error('工作会话已变化，请刷新页面后重试');
    const previous = existing || emptyPresetLibrary();
    const poses = mergeImportedRobotPresets(previous.poses, incoming);
    library = { ...previous, poses, revision: previous.revision + Number(!existing || !samePresets(previous.poses, poses)), savedAt: Date.now() };
    store.put(library); writePresetSnapshots(store, records, library);
  } catch (error) {
    transaction.abort(); await completion.catch(() => undefined); throw error;
  }
  await completion;
  return library;
}

const replaceSession = async (database, sessionId) => {
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  ALL_WORKSPACE_KEYS.forEach((key) => store.delete(key));
  store.put({ key: 'meta', sessionId, startedAt: Date.now(), activeMode: 'map' });
  store.put({
    key: WORKSPACE_INDEX_KEY,
    sessionId,
    activeMode: 'map',
    modes: { map: null, independent: null },
    updatedAt: Date.now(),
  });
  await transactionComplete(transaction);
};

const readWorkspaceRecords = async (database) => {
  const headerTransaction = database.transaction(STORE_NAME, 'readonly');
  const headerStore = headerTransaction.objectStore(STORE_NAME);
  const headerCompletion = transactionComplete(headerTransaction);
  const [meta, workspaceIndex, recoveryMeta, recoveryMap, recoveryConfig] = await Promise.all([
    requestResult(headerStore.get('meta')),
    requestResult(headerStore.get(WORKSPACE_INDEX_KEY)),
    requestResult(headerStore.get('recovery-meta')),
    requestResult(headerStore.get('recovery-map')),
    requestResult(headerStore.get('recovery-config')),
  ]);
  await headerCompletion;

  const indexedMode = workspaceIndex?.activeMode
    ? normalizeWorkspaceMode(workspaceIndex.activeMode ?? meta?.activeMode)
    : null;
  const activeMode = indexedMode || normalizeWorkspaceMode(meta?.activeMode);
  const workspaceTransaction = database.transaction(STORE_NAME, 'readonly');
  const workspaceStore = workspaceTransaction.objectStore(STORE_NAME);
  const workspaceCompletion = transactionComplete(workspaceTransaction);
  const [map, config] = indexedMode
    ? await Promise.all([
        requestResult(workspaceStore.get(workspaceMapKey(activeMode))),
        requestResult(workspaceStore.get(workspaceConfigKey(activeMode))),
      ])
    : await Promise.all([
        requestResult(workspaceStore.get('map')),
        requestResult(workspaceStore.get('config')),
      ]);
  await workspaceCompletion;
  return {
    meta,
    map,
    config,
    workspaceIndex,
    activeMode,
    legacyWorkspace: !indexedMode,
    recoveryMeta: recoveryMeta?.available
      ? {
          ...recoveryMeta,
          teachingSpaceMode: inferWorkspaceMode(recoveryMap, recoveryConfig, recoveryMeta.teachingSpaceMode),
        }
      : recoveryMeta,
    recoveryMap,
    recoveryConfig,
  };
};

const isRecoverableWorkspace = (map, config) => Boolean(
  map || config?.config?.project,
);

const inferWorkspaceMode = (map, config, fallback = 'map') => normalizeWorkspaceMode(
  config?.config?.project?.workspace?.teachingSpaceMode
  ?? config?.config?.ui?.teachingSpaceMode
  ?? map?.teachingSpaceMode
  ?? fallback,
);

const summarizeWorkspace = (mode, map, config, previous = null) => {
  const snapshot = config?.config || null;
  const project = snapshot?.project || null;
  const teachingTasks = Array.isArray(project?.virtualTeaching?.tasks)
    ? project.virtualTeaching.tasks
    : Array.isArray(project?.teachingTasks)
      ? project.teachingTasks
      : [];
  const hasWorkspace = Boolean(map || project || snapshot?.ui?.selectedRobot);
  if (!hasWorkspace) return null;
  return {
    ...(previous || {}),
    available: true,
    mode: normalizeWorkspaceMode(mode),
    mapId: map?.mapId || config?.mapId || project?.map?.mapId || null,
    mapName: map?.name || project?.map?.fileName || previous?.mapName || '未命名工作现场',
    teachingName: project ? normalizeIndependentTeachingName(project.workspace?.independentTeachingName) : previous?.teachingName || '',
    pointCount: Number(map?.pointCount ?? project?.map?.pointCount ?? previous?.pointCount) || 0,
    faceCount: Number(map?.faceCount ?? project?.map?.faceCount ?? previous?.faceCount) || 0,
    waypointCount: Array.isArray(project?.waypoints)
      ? project.waypoints.length
      : Number(previous?.waypointCount) || 0,
    edgeCount: Array.isArray(project?.paths)
      ? project.paths.length
      : Array.isArray(project?.edges)
        ? project.edges.length
        : Number(previous?.edgeCount) || 0,
    taskCount: project ? teachingTasks.length : Number(previous?.taskCount) || 0,
    robotName: project
      ? project.robot?.name || snapshot?.ui?.selectedRobot?.name || ''
      : previous?.robotName || '',
    savedAt: Math.max(
      Number(map?.savedAt) || 0,
      Number(config?.savedAt) || 0,
      Number(previous?.savedAt) || 0,
      Date.now(),
    ),
  };
};

const normalizeWorkspaceIndex = (sessionId, activeMode, index, map, config) => {
  const mode = normalizeWorkspaceMode(activeMode);
  const modes = {
    map: index?.modes?.map || null,
    independent: index?.modes?.independent || null,
  };
  modes[mode] = summarizeWorkspace(mode, map, config, modes[mode]);
  return {
    key: WORKSPACE_INDEX_KEY,
    sessionId,
    activeMode: mode,
    modes,
    updatedAt: Date.now(),
  };
};

const clearWorkspaceViewState = (mode = null) => {
  const storage = browserStorage();
  if (!storage) return;
  try {
    if (mode) storage.removeItem(workspaceViewKey(mode));
    else WORKSPACE_MODES.forEach((workspaceMode) => storage.removeItem(workspaceViewKey(workspaceMode)));
    storage.removeItem(VIEW_STATE_KEY);
  } catch {
    // IndexedDB remains the authoritative fallback.
  }
};

const createRecoveryId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const readViewsForRecovery = (meta, map, config) => {
  const storage = browserStorage();
  if (!storage) return null;
  try {
    const payload = JSON.parse(storage.getItem(VIEW_STATE_KEY) || 'null');
    const mapId = map?.mapId || config?.mapId || null;
    const sourceSessionIds = new Set([
      meta?.sessionId,
      map?.sessionId,
      config?.sessionId,
    ].filter(Boolean));
    if (
      (payload?.version === 1 || payload?.version === 2)
      && payload?.mapId === mapId
      && sourceSessionIds.has(payload?.sessionId)
    ) {
      return {
        view2d: payload.view2d || null,
        view3d: payload.view3d || null,
        savedAt: Number(payload.savedAt) || Date.now(),
      };
    }
  } catch {
    // The IndexedDB snapshot still carries its most recently completed views.
  }
  return null;
};

const restoreRecoveryRecord = (record, key, sessionId) => {
  const restored = { ...record, key, sessionId };
  delete restored.recoveryId;
  delete restored.sourceSessionId;
  return restored;
};

const summarizeRecovery = ({ recoveryId, sourceSessionId, archivedAt }, map, config) => {
  const snapshot = config?.config || null;
  const project = snapshot?.project || null;
  const teachingTasks = Array.isArray(project?.virtualTeaching?.tasks)
    ? project.virtualTeaching.tasks
    : Array.isArray(project?.teachingTasks)
      ? project.teachingTasks
      : [];
  const edges = Array.isArray(project?.paths)
    ? project.paths
    : Array.isArray(project?.edges)
      ? project.edges
      : [];
  const parkingPointCount = teachingTasks.reduce(
    (total, task) => total + (Array.isArray(task?.parkingPoints) ? task.parkingPoints.length : 0),
    0,
  );
  const teachingPoseCount = teachingTasks.reduce(
    (taskTotal, task) => taskTotal + (Array.isArray(task?.parkingPoints)
      ? task.parkingPoints.reduce(
          (parkingTotal, parkingPoint) => parkingTotal
            + (Array.isArray(parkingPoint?.poses) ? parkingPoint.poses.length : 0),
          0,
        )
      : 0),
    0,
  );
  const activeTask = teachingTasks.find(
    (task) => task?.id === snapshot?.ui?.activeTeachingTaskId,
  ) || teachingTasks[0] || null;
  const savedAt = Math.max(
    Number(map?.savedAt) || 0,
    Number(config?.savedAt) || 0,
  ) || Number(archivedAt) || Date.now();

  return {
    available: true,
    recoveryId,
    teachingSpaceMode: inferWorkspaceMode(map, config),
    sourceSessionId: sourceSessionId || null,
    archivedAt: Number(archivedAt) || Date.now(),
    savedAt,
    mapId: map?.mapId || config?.mapId || null,
    teachingGroupId: map?.teachingGroupId || project?.map?.teachingGroupId || null,
    portableOriginalMapId: map?.portableOriginalMapId || null,
    mapName: map?.name || project?.map?.fileName || '未命名地图',
    teachingName: normalizeIndependentTeachingName(project?.workspace?.independentTeachingName),
    activeTaskName: activeTask?.name || '',
    taskCount: teachingTasks.length,
    parkingPointCount,
    teachingPoseCount,
    waypointCount: Array.isArray(project?.waypoints) ? project.waypoints.length : 0,
    edgeCount: edges.length,
    robotName: project?.robot?.name || snapshot?.ui?.selectedRobot?.name || '',
  };
};

const archiveWorkspaceAndReplaceSession = async (
  database,
  sessionId,
  { meta, map, config, recoveryMeta, activeMode },
) => {
  const shouldArchive = isRecoverableWorkspace(map, config);
  const archivedAt = Date.now();
  const recoveryId = shouldArchive ? createRecoveryId() : null;
  const workspaceViews = shouldArchive ? readViewsForRecovery(meta, map, config) : null;
  const summary = shouldArchive
    ? summarizeRecovery(
        { recoveryId, sourceSessionId: meta?.sessionId, archivedAt },
        map,
        config,
      )
    : recoveryMeta?.available
      ? recoveryMeta
      : null;
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  ALL_WORKSPACE_KEYS.forEach((key) => store.delete(key));

  if (shouldArchive) {
    RECOVERY_KEYS.forEach((key) => store.delete(key));
    store.put({ key: 'recovery-meta', ...summary });
    if (map) {
      store.put({
        ...map,
        key: 'recovery-map',
        recoveryId,
        sourceSessionId: meta?.sessionId || map.sessionId || null,
        workspaceViews,
      });
    }
    if (config) {
      store.put({
        ...config,
        key: 'recovery-config',
        recoveryId,
        sourceSessionId: meta?.sessionId || config.sessionId || null,
        workspaceViews,
      });
    }
  }

  const nextMode = normalizeWorkspaceMode(activeMode);
  store.put({ key: 'meta', sessionId, startedAt: archivedAt, activeMode: nextMode });
  store.put({
    key: WORKSPACE_INDEX_KEY,
    sessionId,
    activeMode: nextMode,
    modes: { map: null, independent: null },
    updatedAt: archivedAt,
  });
  await transactionComplete(transaction);
  clearWorkspaceViewState();
  return summary;
};

export async function fetchServiceSession() {
  const response = await fetch('/__atlas/session', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`无法读取服务会话（${response.status}）`);
  const payload = await response.json();
  if (!payload?.sessionId) throw new Error('服务会话标识无效');
  return payload;
}

export async function prepareWorkspaceSession(sessionId, { preserveExisting = false } = {}) {
  const database = await openDatabase();
  const records = await readWorkspaceRecords(database);
  const { meta, recoveryMeta } = records;
  // Browser work belongs to this device, not to the lifetime of the LAN server.
  if (preserveExisting && meta?.sessionId) sessionId = meta.sessionId;

  if (meta?.sessionId !== sessionId) {
    const recovery = await archiveWorkspaceAndReplaceSession(database, sessionId, records);
    return {
      sessionId,
      restarted: Boolean(meta?.sessionId),
      map: null,
      config: null,
      activeMode: 'map',
      workspaceSlots: { map: null, independent: null },
      recovery,
      activatedRecoveryId: null,
    };
  }

  const map = records.map?.sessionId === sessionId ? records.map : null;
  const config = records.config?.sessionId === sessionId ? records.config : null;
  const activeMode = inferWorkspaceMode(
    map,
    config,
    records.workspaceIndex?.activeMode ?? records.activeMode ?? meta?.activeMode,
  );
  const workspaceIndex = normalizeWorkspaceIndex(
    sessionId,
    activeMode,
    records.workspaceIndex,
    map,
    config,
  );

  if (records.legacyWorkspace || !records.workspaceIndex) {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.delete('map');
    store.delete('config');
    if (map) store.put({ ...map, key: workspaceMapKey(activeMode) });
    if (config) store.put({ ...config, key: workspaceConfigKey(activeMode) });
    store.put(workspaceIndex);
    store.put({ ...meta, key: 'meta', sessionId, activeMode });
    await transactionComplete(transaction);
  } else if (
    records.workspaceIndex.activeMode !== activeMode
    || meta?.activeMode !== activeMode
  ) {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.put(workspaceIndex);
    store.put({ ...meta, key: 'meta', sessionId, activeMode });
    await transactionComplete(transaction);
  }

  return {
    sessionId,
    restarted: false,
    map: await unpackMapRecord(map),
    config,
    activeMode,
    workspaceSlots: workspaceIndex.modes,
    recovery: recoveryMeta?.available ? recoveryMeta : null,
    activatedRecoveryId: meta?.activatedRecoveryId || null,
  };
}

export async function activateWorkspaceRecovery(sessionId, requestedMode = null) {
  if (!sessionId) throw new Error('当前服务会话尚未就绪');
  const database = await openDatabase();
  const records = await readWorkspaceRecords(database);
  const { recoveryMeta, recoveryMap, recoveryConfig } = records;
  if (
    !recoveryMeta?.available
    || !recoveryMeta.recoveryId
    || !isRecoverableWorkspace(recoveryMap, recoveryConfig)
  ) {
    throw new Error('没有可恢复的上一次工程');
  }
  if (
    (recoveryMap && recoveryMap.recoveryId !== recoveryMeta.recoveryId)
    || (recoveryConfig && recoveryConfig.recoveryId !== recoveryMeta.recoveryId)
  ) {
    throw new Error('上一次工程的恢复清单不完整');
  }

  const activeMode = inferWorkspaceMode(recoveryMap, recoveryConfig, 'map');
  if (requestedMode !== null && normalizeWorkspaceMode(requestedMode) !== activeMode) {
    throw new Error('恢复副本的示教类型与当前入口不一致，请切换示教模式后再加载');
  }
  const restoredMap = recoveryMap
    ? restoreRecoveryRecord(recoveryMap, workspaceMapKey(activeMode), sessionId)
    : null;
  const restoredConfig = recoveryConfig
    ? restoreRecoveryRecord(recoveryConfig, workspaceConfigKey(activeMode), sessionId)
    : null;
  const workspaceIndex = normalizeWorkspaceIndex(
    sessionId,
    activeMode,
    records.workspaceIndex?.sessionId === sessionId
      ? {
          ...records.workspaceIndex,
          modes: { ...records.workspaceIndex.modes, [activeMode]: null },
        }
      : null,
    restoredMap,
    restoredConfig,
  );

  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  CURRENT_KEYS.forEach((key) => store.delete(key));
  store.delete(workspaceMapKey(activeMode));
  store.delete(workspaceConfigKey(activeMode));
  store.put({
    key: 'meta',
    sessionId,
    startedAt: Date.now(),
    activeMode,
    activatedRecoveryId: recoveryMeta.recoveryId,
  });
  store.put(workspaceIndex);
  if (restoredMap) store.put(restoredMap);
  if (restoredConfig) store.put(restoredConfig);
  RECOVERY_KEYS.forEach((key) => store.delete(key));
  await transactionComplete(transaction);
  clearWorkspaceViewState(activeMode);
  return recoveryMeta;
}

export async function finalizeWorkspaceRecovery(recoveryId) {
  if (!recoveryId) return false;
  const database = await openDatabase();
  const records = await readWorkspaceRecords(database);
  const meta = records.meta;
  if (meta?.activatedRecoveryId !== recoveryId) return false;
  if (records.recoveryMeta && records.recoveryMeta.recoveryId !== recoveryId) return false;

  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  RECOVERY_KEYS.forEach((key) => store.delete(key));
  store.put({ ...meta, activatedRecoveryId: null, recoveryRestoredAt: Date.now() });
  await transactionComplete(transaction);
  return true;
}

export async function saveWorkspaceMap(sessionId, mapId, name, mapCache, mode = null) {
  const database = await openDatabase();
  const workspaceMode = normalizeWorkspaceMode(mode ?? mapCache?.teachingSpaceMode);
  const savedAt = Date.now();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const completion = transactionComplete(transaction);
  const [workspaceIndex, meta] = await Promise.all([
    requestResult(store.get(WORKSPACE_INDEX_KEY)),
    requestResult(store.get('meta')),
  ]);
  const legacyBuffer = mapCache instanceof ArrayBuffer ? mapCache : null;
  const mapRecord = legacyBuffer
    ? {
        key: workspaceMapKey(workspaceMode),
        sessionId,
        mapId,
        name,
        teachingSpaceMode: workspaceMode,
        byteLength: legacyBuffer.byteLength,
        blob: new Blob([legacyBuffer], { type: 'application/octet-stream' }),
        savedAt,
      }
    : {
        ...mapCache,
        key: workspaceMapKey(workspaceMode),
        sessionId,
        mapId,
        name,
        teachingSpaceMode: workspaceMode,
        savedAt,
      };
  const previousSummary = workspaceIndex?.modes?.[workspaceMode] || null;
  const replacesMap = previousSummary?.mapId !== mapId;
  const modes = {
    map: workspaceIndex?.modes?.map || null,
    independent: workspaceIndex?.modes?.independent || null,
  };
  modes[workspaceMode] = summarizeWorkspace(
    workspaceMode,
    mapRecord,
    null,
    replacesMap ? null : previousSummary,
  );
  store.put(packMapRecord(mapRecord));
  if (replacesMap) store.delete(workspaceConfigKey(workspaceMode));
  store.delete('map');
  store.delete('config');
  store.put({
    key: WORKSPACE_INDEX_KEY,
    sessionId,
    activeMode: workspaceMode,
    modes,
    updatedAt: savedAt,
  });
  store.put({
    ...(meta || {}),
    key: 'meta',
    sessionId,
    activeMode: workspaceMode,
    startedAt: Number(meta?.startedAt) || savedAt,
  });
  await completion;
  return modes[workspaceMode];
}

export async function saveWorkspaceConfig(sessionId, mapId, config, mode = null, { presetLibrary } = {}) {
  const database = await openDatabase();
  const workspaceMode = normalizeWorkspaceMode(
    mode
    ?? config?.project?.workspace?.teachingSpaceMode
    ?? config?.ui?.teachingSpaceMode,
  );
  const savedAt = Date.now();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const completion = transactionComplete(transaction);
  let library, modes;
  try {
    const [workspaceIndex, meta, storedLibrary] = await Promise.all([
      requestResult(store.get(WORKSPACE_INDEX_KEY)),
      requestResult(store.get('meta')),
      requestResult(store.get(SHARED_ROBOT_PRESETS_KEY)),
    ]);
    library = storedLibrary;
    if (presetLibrary) {
      if (!sessionId || meta?.sessionId !== sessionId) throw new Error('工作会话已变化，请刷新页面后重试');
      const previous = storedLibrary || emptyPresetLibrary();
      const poses = sharedRobotPresetEntries(config?.project);
      if (previous.revision !== presetLibrary.revision && !samePresets(poses, previous.poses)) {
        throw new Error('共享预设姿态已在其他页面更新，请刷新后重试，避免覆盖新的修改');
      }
      if (!storedLibrary || !samePresets(previous.poses, poses)) {
        library = { ...previous, poses, revision: previous.revision + 1, savedAt };
        store.put(library);
        writePresetSnapshots(store, await readPresetConfigs(store), library);
      }
    }
    if (library) config = withSharedRobotPresetConfig(config, library.poses);
    const configRecord = {
      key: workspaceConfigKey(workspaceMode), sessionId, mapId, config,
      teachingSpaceMode: workspaceMode, savedAt,
    };
    modes = {
      map: workspaceIndex?.modes?.map || null,
      independent: workspaceIndex?.modes?.independent || null,
    };
    modes[workspaceMode] = summarizeWorkspace(workspaceMode, null, configRecord, modes[workspaceMode]);
    store.put(configRecord);
    store.delete('map');
    store.delete('config');
    store.put({ key: WORKSPACE_INDEX_KEY, sessionId, activeMode: workspaceMode, modes, updatedAt: savedAt });
    store.put({ ...(meta || {}), key: 'meta', sessionId, activeMode: workspaceMode,
      startedAt: Number(meta?.startedAt) || savedAt });
  } catch (error) {
    transaction.abort(); await completion.catch(() => undefined); throw error;
  }
  await completion;
  return presetLibrary ? { ...modes[workspaceMode], presetLibrary: library } : modes[workspaceMode];
}

// Read another workspace's route/relation without unpacking its point cloud.
export async function loadWorkspaceConfig(sessionId, mode) {
  const workspaceMode = normalizeWorkspaceMode(mode);
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  const [meta, index, config] = await Promise.all([
    requestResult(store.get('meta')),
    requestResult(store.get(WORKSPACE_INDEX_KEY)),
    requestResult(store.get(workspaceConfigKey(workspaceMode))),
  ]);
  await completion;
  if (!sessionId || meta?.sessionId !== sessionId || index?.sessionId !== sessionId) {
    throw new Error('工作会话已变化，请刷新页面后重试');
  }
  if (config && (config.sessionId !== sessionId
    || (config.mapId ?? null) !== (index.modes?.[workspaceMode]?.mapId ?? null))) {
    throw new Error('工程缓存不完整，请重新加载工程');
  }
  return config || null;
}

// Update a map's configuration from either teaching workspace without activating
// it or rewriting geometry. A stale dialog must never replace newer map data.
export async function commitMapWorkspaceConfig(sessionId, { expectedConfig, config, activeMode }) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  let record, summary;
  try {
    const [meta, index, current, geometryKey] = await Promise.all([
      requestResult(store.get('meta')), requestResult(store.get(WORKSPACE_INDEX_KEY)),
      requestResult(store.get(workspaceConfigKey('map'))), requestResult(store.getKey(workspaceMapKey('map'))),
    ]);
    if (!sessionId || meta?.sessionId !== sessionId || index?.sessionId !== sessionId
      || index.activeMode !== activeMode) throw new Error('工作会话已变化，请刷新页面后重试');
    if (!geometryKey || !expectedConfig?.mapId || current?.sessionId !== sessionId
      || current.mapId !== expectedConfig.mapId || current.savedAt !== expectedConfig.savedAt
      || index.modes?.map?.mapId !== expectedConfig.mapId
      || config?.project?.workspace?.teachingSpaceMode !== 'map') {
      throw new Error('地图示教已变化，请重新打开新增独立示教窗口后加载路网');
    }
    const savedAt = Date.now();
    record = { ...current, savedAt, config };
    summary = summarizeWorkspace('map', null, record, index.modes.map);
    store.put(record);
    store.put({ ...index, updatedAt: savedAt, modes: { ...index.modes, map: summary } });
  } catch (error) {
    transaction.abort();
    await completion.catch(() => undefined);
    throw error;
  }
  await completion;
  return { record, summary };
}

export async function loadWorkspaceSnapshot(sessionId, mode) {
  const workspaceMode = normalizeWorkspaceMode(mode);
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  const [meta, map, config] = await Promise.all([
    requestResult(store.get('meta')),
    requestResult(store.get(workspaceMapKey(workspaceMode))),
    requestResult(store.get(workspaceConfigKey(workspaceMode))),
  ]);
  await completion;
  if (!sessionId || meta?.sessionId !== sessionId) throw new Error('工作会话已变化，请刷新页面后重试');
  if ((map && map.sessionId !== sessionId) || (config && config.sessionId !== sessionId)
    || (map && config && config.mapId !== map.mapId)) throw new Error('工程缓存不完整，请重新加载工程');
  return { mode: workspaceMode, map: await unpackMapRecord(map), config: config || null };
}

// Legacy display-layer recovery reads only the matching object's geometry.
// Avoid unpacking every historical model just to identify one appended block.
export async function loadIndependentDisplaySource(sessionId, identity) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  const [meta, history, current] = await Promise.all([
    requestResult(store.get('meta')), requestResult(store.get(INDEPENDENT_HISTORY_KEY)),
    requestResult(store.get(workspaceConfigKey('independent'))),
  ]);
  let found = null;
  if (sessionId && meta?.sessionId === sessionId) {
    const candidates = [{ config: current, mapKey: workspaceMapKey('independent') },
      ...(history?.entries || []).map((entry) => ({ historyId: entry.historyId }))];
    for (const candidate of candidates) {
      const config = candidate.config || (candidate.historyId
        ? await requestResult(store.get(historyConfigKey(candidate.historyId))) : null);
      if (!matchesPlacedSource(identity, { ...config?.config?.project?.map, mapId: config?.mapId })) continue;
      found = await requestResult(store.get(candidate.mapKey || historyMapKey(candidate.historyId)));
      break;
    }
  }
  await completion;
  return found ? unpackMapRecord(found) : null;
}

export async function listIndependentHistory() {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const completion = transactionComplete(transaction);
  const record = await requestResult(transaction.objectStore(STORE_NAME).get(INDEPENDENT_HISTORY_KEY));
  await completion;
  return (record?.entries || []).slice().sort((a, b) => b.archivedAt - a.archivedAt);
}

// Freeze the other active workspace and the entire history index in one read
// transaction. Never silently skip a missing group and call the ZIP complete.
export async function loadProjectCompanions(sessionId, currentMode) {
  const otherMode = normalizeWorkspaceMode(currentMode) === 'map' ? 'independent' : 'map';
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  const [meta, index, map, config, history] = await Promise.all([
    requestResult(store.get('meta')),
    requestResult(store.get(WORKSPACE_INDEX_KEY)),
    requestResult(store.get(workspaceMapKey(otherMode))),
    requestResult(store.get(workspaceConfigKey(otherMode))),
    requestResult(store.get(INDEPENDENT_HISTORY_KEY)),
  ]);
  const records = await Promise.all((history?.entries || []).map(async (entry) => {
    const [archivedMap, archivedConfig] = await Promise.all([
      requestResult(store.get(historyMapKey(entry.historyId))),
      requestResult(store.get(historyConfigKey(entry.historyId))),
    ]);
    return { mode: 'independent', map: archivedMap, config: archivedConfig, archivedAt: entry.archivedAt };
  }));
  await completion;
  if (!sessionId || meta?.sessionId !== sessionId || index?.sessionId !== sessionId) {
    throw new Error('工作会话已变化，请刷新页面后重试');
  }
  const available = index.modes?.[otherMode]?.available;
  if ((map || config?.config?.project || available) && (!map || !config?.config?.project
    || map.sessionId !== sessionId || config.sessionId !== sessionId
    || map.mapId !== config.mapId || map.mapId !== index.modes?.[otherMode]?.mapId)) {
    throw new Error('另一侧工程缓存不完整，无法保存完整工程');
  }
  return {
    companionWorkspace: map ? { mode: otherMode, map: await unpackMapRecord(map), config } : null,
    independentHistory: await Promise.all(records.map(async (snapshot) => ({
      ...snapshot, map: await unpackMapRecord(snapshot.map),
    }))),
  };
}

// Only read configuration and summaries; choosing a group must not unpack its
// model or alter either workspace before the user makes a selection.
export async function listIndependentWorkspaces(sessionId) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  const [meta, index, config, history] = await Promise.all([
    requestResult(store.get('meta')),
    requestResult(store.get(WORKSPACE_INDEX_KEY)),
    requestResult(store.get(workspaceConfigKey('independent'))),
    requestResult(store.get(INDEPENDENT_HISTORY_KEY)),
  ]);
  await completion;
  if (!sessionId || meta?.sessionId !== sessionId || index?.sessionId !== sessionId) {
    throw new Error('工作会话已变化，请刷新页面后重试');
  }
  const current = index.modes?.independent;
  if (current?.available && (!config || config.sessionId !== sessionId || config.mapId !== current.mapId)) {
    throw new Error('独立示教缓存不完整，请重新加载工程');
  }
  const entries = (history?.entries || [])
    .filter((entry) => !current?.available || entry.mapId !== current.mapId)
    .slice().sort((a, b) => b.archivedAt - a.archivedAt)
    .map((entry) => ({ ...entry, current: false }));
  if (current?.available) {
    entries.unshift({
      ...summarizeRecovery({ sourceSessionId: sessionId }, null, config),
      mapName: current.mapName, archivedAt: null, current: true, historyId: null,
    });
  }
  return entries;
}

// A display-name edit touches configuration and the cache index in one
// transaction. Geometry, group IDs and transformation links remain unchanged.
export async function renameIndependentWorkspace(sessionId, { historyId = null, mapId, name, expectedName = '' }) {
  const teachingName = validateIndependentTeachingName(name);
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  try {
    const configKey = historyId ? historyConfigKey(historyId) : workspaceConfigKey('independent');
    const mapKey = historyId ? historyMapKey(historyId) : workspaceMapKey('independent');
    const [meta, index, history, record, geometryKey] = await Promise.all([
      requestResult(store.get('meta')), requestResult(store.get(WORKSPACE_INDEX_KEY)),
      requestResult(store.get(INDEPENDENT_HISTORY_KEY)), requestResult(store.get(configKey)),
      requestResult(store.getKey(mapKey)),
    ]);
    if (!sessionId || meta?.sessionId !== sessionId || index?.sessionId !== sessionId) {
      throw new Error('工作会话已变化，请刷新页面后重试');
    }
    const entry = historyId ? history?.entries?.find((item) => item.historyId === historyId) : index.modes?.independent;
    const project = record?.config?.project;
    if (!mapId || !geometryKey || !entry || entry.mapId !== mapId || record?.mapId !== mapId
      || project?.workspace?.teachingSpaceMode !== 'independent' || (!historyId && record.sessionId !== sessionId)) {
      throw new Error('所选独立示教缓存已变化，请重新打开列表后重试');
    }
    if (normalizeIndependentTeachingName(project.workspace.independentTeachingName) !== normalizeIndependentTeachingName(expectedName)) {
      throw new Error('独立示教名称已被修改，请重新打开列表后重试');
    }
    const savedAt = Date.now();
    store.put({ ...record, savedAt, config: { ...record.config,
      project: { ...project, workspace: { ...project.workspace, independentTeachingName: teachingName } },
      ui: { ...record.config.ui, independentTeachingName: teachingName },
    } });
    const updated = { ...entry, teachingName, savedAt };
    if (historyId) {
      store.put({ ...history, entries: history.entries.map((item) => item.historyId === historyId ? updated : item) });
    } else {
      store.put({ ...index, updatedAt: savedAt, modes: { ...index.modes, independent: updated } });
    }
  } catch (error) {
    transaction.abort();
    await completion.catch(() => undefined);
    throw error;
  }
  await completion;
  return teachingName;
}

// Delete one logical independent workspace atomically, including its stored
// geometry. The map workspace and other independent groups are untouched.
export async function deleteIndependentWorkspace(sessionId, { historyId = null, mapId }) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  try {
    const [meta, index, history, recovery, keys] = await Promise.all([
      requestResult(store.get('meta')), requestResult(store.get(WORKSPACE_INDEX_KEY)),
      requestResult(store.get(INDEPENDENT_HISTORY_KEY)), requestResult(store.get('recovery-config')),
      requestResult(store.getAllKeys()),
    ]);
    if (!sessionId || meta?.sessionId !== sessionId || index?.sessionId !== sessionId) {
      throw new Error('工作会话已变化，请刷新页面后重试');
    }
    const entry = historyId ? history?.entries?.find((item) => item.historyId === historyId) : index.modes?.independent;
    if (!mapId || !entry || entry.mapId !== mapId || (historyId && index.modes?.independent?.mapId === mapId)) {
      throw new Error('所选独立示教缓存已变化，请重新打开列表后重试');
    }
    const removed = (history?.entries || []).filter((item) => historyId ? item.historyId === historyId : item.mapId === mapId);
    for (const item of removed) {
      store.delete(historyMapKey(item.historyId));
      store.delete(historyConfigKey(item.historyId));
    }
    store.put({ key: INDEPENDENT_HISTORY_KEY, entries: (history?.entries || []).filter((item) => !removed.includes(item)) });
    if (!historyId) {
      store.delete(workspaceMapKey('independent'));
      store.delete(workspaceConfigKey('independent'));
      store.put({ ...index, modes: { ...index.modes, independent: null }, updatedAt: Date.now() });
    }
    if (recovery?.mapId === mapId && inferWorkspaceMode(null, recovery) === 'independent') {
      RECOVERY_KEYS.forEach((key) => store.delete(key));
      store.put({ ...meta, activatedRecoveryId: null });
    }
    for (const key of keys) {
      if (typeof key !== 'string' || !key.startsWith('work-sync:')) continue;
      try {
        const [mode, identity] = JSON.parse(key.slice('work-sync:'.length));
        if (mode === 'independent' && identity === mapId) store.delete(key);
      } catch { /* Ignore unrelated checkpoint formats. */ }
    }
  } catch (error) {
    transaction.abort();
    await completion.catch(() => undefined);
    throw error;
  }
  await completion;
  if (!historyId) clearWorkspaceViewState('independent');
}

// Explicit user reset differs from session recovery: history, recovery copies
// and synchronization checkpoints must all be removed, not archived again.
export async function clearAllWorkspaceCaches(sessionId) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  try {
    const meta = await requestResult(store.get('meta'));
    if (!sessionId || meta?.sessionId !== sessionId) throw new Error('工作会话已变化，请刷新页面后重试');
    store.clear();
    store.put({ key: 'meta', sessionId, activeMode: 'map', startedAt: Date.now() });
    store.put({ key: WORKSPACE_INDEX_KEY, sessionId, activeMode: 'map', modes: { map: null, independent: null }, updatedAt: Date.now() });
  } catch (error) {
    transaction.abort();
    await completion.catch(() => undefined);
    throw error;
  }
  await completion;
  clearWorkspaceViewState();
  try { browserStorage()?.removeItem('atlas-ipad-handoffs-v1'); } catch { /* Storage can be disabled. */ }
  try { globalThis.sessionStorage?.removeItem('atlas-project-import-progress'); } catch { /* Storage can be disabled. */ }
}

// Archive the outgoing group and activate a new/restored group atomically.
// Neither a failed write nor restoring history can discard the current group.
// A requested map placement joins the same transaction; ordinary group switches
// leave the map workspace (including its absolute coordinates) untouched.
export async function switchIndependentWorkspace(sessionId, {
  replacement = null, historyId = null, expectedConfig = null, activeMode, currentRobotPackage,
  expectedMapConfig = null, mapPlacement = null,
}) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  try {
    const [meta, index, currentMap, currentConfig, history, archivedMap, archivedConfig, targetMap, targetConfig] = await Promise.all([
      requestResult(store.get('meta')),
      requestResult(store.get(WORKSPACE_INDEX_KEY)),
      requestResult(store.get(workspaceMapKey('independent'))),
      requestResult(store.get(workspaceConfigKey('independent'))),
      requestResult(store.get(INDEPENDENT_HISTORY_KEY)),
      historyId ? requestResult(store.get(historyMapKey(historyId))) : null,
      historyId ? requestResult(store.get(historyConfigKey(historyId))) : null,
      expectedMapConfig ? requestResult(store.get(workspaceMapKey('map'))) : null,
      expectedMapConfig ? requestResult(store.get(workspaceConfigKey('map'))) : null,
    ]);
    if (!sessionId || meta?.sessionId !== sessionId || index?.sessionId !== sessionId
      || index.activeMode !== activeMode) throw new Error('工作会话已变化，请刷新页面后重试');
    if (currentConfig?.mapId !== expectedConfig?.mapId || currentConfig?.savedAt !== expectedConfig?.savedAt
      || (index.modes?.independent?.mapId ?? null) !== (currentMap?.mapId ?? currentConfig?.mapId ?? null)) {
      throw new Error('独立工程在切换期间发生了修改，请重试');
    }
    if ((currentMap && (currentMap.sessionId !== sessionId || currentMap.mapId !== currentConfig?.mapId))
      || (currentConfig && currentConfig.sessionId !== sessionId)
      || (currentConfig?.config?.project && !currentMap)) {
      throw new Error('当前独立工程缓存不完整，无法创建缓存副本');
    }
    if (expectedMapConfig && (!targetMap?.positionBuffer || targetMap.sessionId !== sessionId
      || targetConfig?.sessionId !== sessionId || targetMap.mapId !== expectedMapConfig.mapId
      || targetConfig.mapId !== expectedMapConfig.mapId || targetConfig.savedAt !== expectedMapConfig.savedAt
      || index.modes?.map?.mapId !== expectedMapConfig.mapId)) {
      throw new Error('地图示教已变化，请重新打开新增独立示教窗口后加载转换矩阵');
    }
    const entries = history?.entries || [];
    if (historyId && (!entries.some((entry) => entry.historyId === historyId)
      || !archivedConfig?.config?.project || !archivedMap || archivedConfig.mapId !== archivedMap.mapId)) {
      throw new Error('独立示教缓存不完整，当前工程已保留');
    }
    const nextMap = historyId ? archivedMap : replacement?.map;
    const nextConfig = historyId ? archivedConfig?.config : replacement?.config;
    if (!historyId && nextConfig?.project?.workspace?.transfer?.kind === 'alignment'
      && (!expectedMapConfig || nextConfig.project.workspace.transfer.sourceMap?.mapId !== expectedMapConfig.mapId)) {
      throw new Error('转换矩阵缺少已加载的目标地图，当前工程已保留');
    }
    if (!nextMap?.mapId || !nextConfig?.project
      || nextConfig.project.workspace?.teachingSpaceMode !== 'independent'
      || (!nextMap.positionBuffer && !nextMap.blob)) throw new Error('新的独立工程资源不完整');
    if (nextMap.mapId === currentMap?.mapId) throw new Error('该独立工程已在当前工作区中');
    if (mapPlacement && (historyId || !expectedMapConfig || mapPlacement.mode !== 'map'
      || !mapPlacement.map?.mapId || !mapPlacement.map.positionBuffer
      || mapPlacement.config?.project?.workspace?.teachingSpaceMode !== 'map'
      || mapPlacement.config.project.workspace.transfer?.kind !== 'placement'
      || mapPlacement.config.project.workspace.transfer.sourceMap?.mapId !== nextMap.mapId)) {
      throw new Error('放置结果不完整，当前工程已保留');
    }

    const savedAt = Date.now();
    let nextEntries = entries.filter((entry) => entry.historyId !== historyId);
    if (currentMap) {
      if (!currentConfig?.config?.project) throw new Error('当前示教结果尚未完整保存，请重试');
      const id = currentMap.mapId;
      const summary = summarizeRecovery({ sourceSessionId: sessionId, archivedAt: savedAt }, currentMap, currentConfig);
      nextEntries = nextEntries.filter((entry) => entry.historyId !== id);
      nextEntries.push({ ...summary, historyId: id });
      // Stored buffers may already be Blobs; keep them packed while archiving.
      const project = currentConfig.config.project;
      const portableRobotPackage = currentRobotPackage === undefined ? currentMap.portableRobotPackage : currentRobotPackage;
      if (project.robot && portableRobotPackage?.relativePath !== project.robot.relativePath) {
        throw new Error('当前机器人资源尚未完整缓存，当前工程已保留');
      }
      store.put(packMapRecord({ ...currentMap, key: historyMapKey(id), portableRobotPackage,
        workspaceViews: { view2d: project.view2d || null, view3d: project.view3d || null } }));
      store.put({ ...currentConfig, key: historyConfigKey(id) });
    }
    const map = { ...nextMap, key: workspaceMapKey('independent'), teachingSpaceMode: 'independent', sessionId, savedAt };
    const config = { key: workspaceConfigKey('independent'), mapId: map.mapId,
      teachingSpaceMode: 'independent', sessionId, savedAt,
      config: { ...nextConfig, project: { ...nextConfig.project,
        workspace: { ...nextConfig.project.workspace, directoryAutosaveSuspended: true } } } };
    store.put(packMapRecord(map));
    store.put(config);
    const modes = { ...index.modes, independent: summarizeWorkspace('independent', map, config) };
    const nextMode = mapPlacement ? 'map' : 'independent';
    if (mapPlacement) {
      const placedMap = { ...mapPlacement.map, key: workspaceMapKey('map'), teachingSpaceMode: 'map', sessionId, savedAt };
      const placedConfig = { key: workspaceConfigKey('map'), teachingSpaceMode: 'map', sessionId, savedAt,
        mapId: placedMap.mapId, config: mapPlacement.config };
      store.put(packMapRecord(placedMap));
      store.put(placedConfig);
      modes.map = summarizeWorkspace('map', placedMap, placedConfig);
    }
    if (historyId) {
      store.delete(historyMapKey(historyId));
      store.delete(historyConfigKey(historyId));
    }
    store.put({ key: INDEPENDENT_HISTORY_KEY, entries: nextEntries });
    store.put({ ...index, activeMode: nextMode, updatedAt: savedAt, modes });
    store.put({ ...meta, activeMode: nextMode, activatedRecoveryId: null });
  } catch (error) {
    transaction.abort();
    await completion.catch(() => undefined);
    throw error;
  }
  await completion;
  clearWorkspaceViewState('independent');
  if (mapPlacement) clearWorkspaceViewState('map');
}

// Geometry, configuration, the reverse link and the active mode commit together.
// A failed conversion or a concurrent edit leaves both workspaces untouched.
export async function commitWorkspaceTransfer(sessionId, source, target, result) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  try {
    const [meta, index, sourceConfig, targetConfig] = await Promise.all([
      requestResult(store.get('meta')), requestResult(store.get(WORKSPACE_INDEX_KEY)),
      requestResult(store.get(workspaceConfigKey(source.mode))),
      requestResult(store.get(workspaceConfigKey(target.mode))),
    ]);
    if (meta?.sessionId !== sessionId || index?.sessionId !== sessionId || index.activeMode !== source.mode) {
      throw new Error('工作会话已变化，请关闭转换面板后重试');
    }
    for (const [actual, expected] of [[sourceConfig, source.config], [targetConfig, target.config]]) {
      if (actual?.savedAt !== expected?.savedAt || actual?.mapId !== expected?.mapId) {
        throw new Error('工程在转换期间发生了修改，请关闭转换面板后重试');
      }
    }
    for (const snapshot of [source, target]) {
      if ((index.modes?.[snapshot.mode]?.mapId ?? null) !== (snapshot.map?.mapId ?? snapshot.config?.mapId ?? null)) {
        throw new Error('工程地图在转换期间发生了变化，请关闭转换面板后重试');
      }
    }
    if (result.mode !== target.mode || !result.map?.positionBuffer || !result.config?.project) {
      throw new Error('转换结果不完整');
    }
    const savedAt = Date.now();
    const map = { ...result.map, key: workspaceMapKey(target.mode), sessionId, savedAt };
    const config = { key: workspaceConfigKey(target.mode), sessionId, savedAt,
      mapId: map.mapId, teachingSpaceMode: target.mode, config: result.config };
    store.put(packMapRecord(map));
    store.put(config);
    const modes = { ...index.modes, [target.mode]: summarizeWorkspace(target.mode, map, config) };
    if (result.sourceConfig) {
      const updatedSource = { ...sourceConfig, config: result.sourceConfig, savedAt };
      store.put(updatedSource);
      modes[source.mode] = summarizeWorkspace(source.mode, source.map, updatedSource);
    }
    store.put({ ...index, modes, activeMode: target.mode, updatedAt: savedAt });
    store.put({ ...meta, activeMode: target.mode });
  } catch (error) {
    transaction.abort();
    await completion.catch(() => undefined);
    throw error;
  }
  await completion;
  clearWorkspaceViewState(target.mode);
}

export async function activateWorkspaceMode(sessionId, mode, expectedMapId = undefined) {
  if (!sessionId) throw new Error('当前服务会话尚未就绪');
  const workspaceMode = normalizeWorkspaceMode(mode);
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const completion = transactionComplete(transaction);
  const [workspaceIndex, meta] = await Promise.all([
    requestResult(store.get(WORKSPACE_INDEX_KEY)),
    requestResult(store.get('meta')),
  ]);
  if (meta?.sessionId !== sessionId || workspaceIndex?.sessionId !== sessionId) {
    transaction.abort();
    await completion.catch(() => undefined);
    throw new Error('工作会话已变化，请刷新页面后重试');
  }
  const summary = workspaceIndex?.modes?.[workspaceMode] || null;
  if (expectedMapId !== undefined && summary?.mapId !== expectedMapId) {
    transaction.abort();
    await completion.catch(() => undefined);
    throw new Error('所选工程已发生变化，请重新选择要进入的工程');
  }
  if (!summary?.available) {
    transaction.abort();
    await completion.catch(() => undefined);
    throw new Error(workspaceMode === 'independent' ? '没有可继续的独立示教缓存' : '没有可继续的地图示教缓存');
  }
  store.put({
    ...workspaceIndex,
    activeMode: workspaceMode,
    updatedAt: Date.now(),
  });
  store.put({ ...meta, activeMode: workspaceMode });
  await completion;
  return summary;
}

// Import both sides in one transaction; quota/serialization failures roll back
// geometry, teaching configuration, and the active-workspace index together.
export async function restoreLinkedWorkspaces(sessionId, workspaces, activeMode) {
  if (!sessionId || !WORKSPACE_MODES.includes(activeMode)) throw new Error('工作会话尚未就绪');
  for (const mode of WORKSPACE_MODES) {
    const snapshot = workspaces?.[mode];
    if (!snapshot?.map?.positionBuffer || !snapshot.config?.config?.project
      || snapshot.config.mapId !== snapshot.map.mapId || snapshot.mode !== mode) {
      throw new Error('双边工程快照不完整');
    }
  }
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  try {
    const meta = await requestResult(store.get('meta'));
    if (meta?.sessionId !== sessionId) throw new Error('工作会话已变化，请刷新页面后重试');
    const savedAt = Date.now();
    const modes = {};
    for (const mode of WORKSPACE_MODES) {
      const snapshot = workspaces[mode];
      const map = { ...snapshot.map, key: workspaceMapKey(mode), teachingSpaceMode: mode, sessionId, savedAt };
      const config = { ...snapshot.config, key: workspaceConfigKey(mode), teachingSpaceMode: mode, sessionId, savedAt };
      store.put(packMapRecord(map));
      store.put(config);
      modes[mode] = summarizeWorkspace(mode, map, config);
    }
    store.delete('map');
    store.delete('config');
    store.put({ key: WORKSPACE_INDEX_KEY, sessionId, activeMode, modes, updatedAt: savedAt });
    store.put({ ...meta, activeMode });
  } catch (error) {
    transaction.abort();
    await completion.catch(() => undefined);
    throw error;
  }
  await completion;
  clearWorkspaceViewState();
}

// Commit all active workspaces and historical groups together. A quota error
// rolls back the whole import. Unrelated local history remains available.
export async function restoreWorkspaceCollection(sessionId, collection, activeMode = collection.activeMode) {
  validateWorkspaceCollection(collection);
  if (!sessionId || !collection.workspaces[activeMode]) throw new Error('工作会话尚未就绪');
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  try {
    const [meta, index, history] = await Promise.all([
      requestResult(store.get('meta')),
      requestResult(store.get(WORKSPACE_INDEX_KEY)),
      requestResult(store.get(INDEPENDENT_HISTORY_KEY)),
    ]);
    if (meta?.sessionId !== sessionId) throw new Error('工作会话已变化，请刷新页面后重试');
    const savedAt = Date.now();
    const modes = { ...index?.modes };
    for (const [mode, snapshot] of Object.entries(collection.workspaces)) {
      const map = { ...snapshot.map, key: workspaceMapKey(mode), teachingSpaceMode: mode, sessionId, savedAt };
      const config = { ...snapshot.config, key: workspaceConfigKey(mode), teachingSpaceMode: mode, sessionId, savedAt };
      store.put(packMapRecord(map));
      store.put(config);
      modes[mode] = summarizeWorkspace(mode, map, config);
    }
    const incoming = [collection.workspaces.independent, ...collection.independentHistory].filter(Boolean);
    const entries = [];
    for (const entry of history?.entries || []) {
      // Stable group identities avoid duplicates when the same backup is loaded again.
      const replaced = incoming.some(({ map }) => entry.teachingGroupId && map.teachingGroupId
        ? entry.teachingGroupId === map.teachingGroupId
        : (entry.portableOriginalMapId || entry.mapId) === (map.portableOriginalMapId || map.mapId));
      if (replaced) {
        store.delete(historyMapKey(entry.historyId));
        store.delete(historyConfigKey(entry.historyId));
      } else entries.push(entry);
    }
    for (const snapshot of collection.independentHistory) {
      const id = snapshot.map.mapId;
      const map = { ...snapshot.map, key: historyMapKey(id), teachingSpaceMode: 'independent', sessionId, savedAt };
      const config = { ...snapshot.config, key: historyConfigKey(id), teachingSpaceMode: 'independent', sessionId, savedAt };
      store.put(packMapRecord(map));
      store.put(config);
      entries.push({ ...summarizeRecovery({ sourceSessionId: sessionId, archivedAt: snapshot.archivedAt }, map, config),
        historyId: id, teachingGroupId: map.teachingGroupId,
        portableOriginalMapId: map.portableOriginalMapId });
    }
    store.put({ key: INDEPENDENT_HISTORY_KEY, entries });
    store.delete('map');
    store.delete('config');
    store.put({ key: WORKSPACE_INDEX_KEY, sessionId, activeMode, modes, updatedAt: savedAt });
    store.put({ ...meta, activeMode, activatedRecoveryId: null });
  } catch (error) {
    transaction.abort();
    await completion.catch(() => undefined);
    throw error;
  }
  await completion;
  clearWorkspaceViewState();
}

export async function resetWorkspaceSession(sessionId) {
  const database = await openDatabase();
  await replaceSession(database, sessionId);
  clearWorkspaceViewState();
}
