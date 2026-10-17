const DATABASE_NAME = 'atlas-project-save-targets';
const STORE_NAME = 'targets';
const modeKey = (mode) => mode === 'independent' ? 'independent' : 'map';

const withStore = async (access, operation) => {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'teachingSpaceMode' });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, access);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('保存位置记录失败'));
      operation(transaction.objectStore(STORE_NAME), (value) => { result = value; });
    });
  } finally {
    database.close();
  }
};

export const loadProjectSaveTarget = (mapId, mode) => withStore('readonly', (store, done) => {
  const request = store.get(modeKey(mode));
  request.onsuccess = () => {
    const target = request.result;
    done(target?.mapId === mapId && target.handle?.kind === 'file' ? target : null);
  };
});

export const rememberProjectSaveTarget = (target) => withStore('readwrite', (store) => {
  store.put({ ...target, teachingSpaceMode: modeKey(target.teachingSpaceMode) });
});

export const clearProjectSaveTarget = (mapId, mode) => withStore('readwrite', (store) => {
  const request = store.get(modeKey(mode));
  request.onsuccess = () => {
    if (request.result?.mapId === mapId) store.delete(modeKey(mode));
  };
});

export const ensureProjectWritePermission = async (handle) => {
  if (typeof handle.queryPermission !== 'function') return;
  const options = { mode: 'readwrite' };
  if (await handle.queryPermission(options) === 'granted') return;
  if (await handle.requestPermission(options) !== 'granted') {
    throw new Error('未获得工程文件的写入权限，请重新授权或使用“另存为工程”');
  }
};
