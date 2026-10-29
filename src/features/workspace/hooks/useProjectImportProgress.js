import { useCallback, useEffect, useRef, useState } from 'react';

const CHECKPOINT_KEY = 'atlas-project-import-progress';
const clearCheckpoint = () => {
  try { sessionStorage.removeItem(CHECKPOINT_KEY); } catch { /* Storage can be disabled. */ }
};
const readCheckpoint = () => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(CHECKPOINT_KEY));
    if (window.location.pathname === '/workbench' && typeof saved?.sourceName === 'string'
      && Date.now() - saved.savedAt >= 0 && Date.now() - saved.savedAt < 120_000) {
      return { ...saved, progress: 0.9, stage: '准备工程现场', resuming: true };
    }
  } catch { /* Start normally if a previous checkpoint cannot be read. */ }
  clearCheckpoint();
  return null;
};

// Importing a collection reloads the workspace after its atomic commit. Keep
// the same overall progress across that reload, without persisting project data.
export function useProjectImportProgress() {
  const [state, setState] = useState(readCheckpoint);
  const current = useRef(state);
  const finishTimer = useRef(null);
  useEffect(() => () => window.clearTimeout(finishTimer.current), []);

  const begin = useCallback((sourceName) => {
    window.clearTimeout(finishTimer.current);
    clearCheckpoint();
    current.current = { sourceName, progress: 0.02, stage: '读取工程', resuming: false };
    setState(current.current);
  }, []);
  const step = useCallback((progress, stage) => {
    if (!current.current) return;
    current.current = { ...current.current, stage,
      progress: Math.max(current.current.progress, Math.min(1, Math.max(0, progress))) };
    setState(current.current);
  }, []);
  const cancel = useCallback(() => {
    window.clearTimeout(finishTimer.current);
    clearCheckpoint();
    current.current = null;
    setState(null);
  }, []);
  const finish = useCallback(() => {
    if (!current.current) return;
    clearCheckpoint();
    step(1, '加载完成');
    window.clearTimeout(finishTimer.current);
    finishTimer.current = window.setTimeout(cancel, 300);
  }, [cancel, step]);
  const prepareReload = useCallback((sessionId, mode) => {
    step(0.9, '准备工程现场');
    try {
      sessionStorage.setItem(CHECKPOINT_KEY, JSON.stringify({ ...current.current, sessionId, mode, savedAt: Date.now() }));
    } catch { /* The workspace can still reload without a progress checkpoint. */ }
  }, [step]);

  return { state, current, begin, step, finish, cancel, prepareReload };
}
