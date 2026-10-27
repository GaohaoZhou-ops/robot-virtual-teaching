import { useEffect, useMemo, useRef, useState } from 'react';
import { isVisionWorkbench, openVisionWorkspaceScene, visionMessage, visionRequest } from '../lib/visionWorkbench.js';
import './VisionWorkbench.css';

// The desktop document engine is retained behind the native immersive project.
// A launch is consumed once; synchronization must finish before exporting its
// scene, so a cached previous project can never appear instead of the new one.
export default function VisionWorkbenchBridge(props) {
  const latest = useRef(props); latest.current = props;
  const operation = useRef(null), commandHandler = useRef(null), generation = useRef(0), sequence = useRef(0);
  const [running, setRunning] = useState(false), [launchPlan, setLaunchPlan] = useState(null);
  const [status, setStatus] = useState(''), [error, setError] = useState('');
  const native = isVisionWorkbench(), immersive = native && window.AtlasVision.immersive;
  const revision = useMemo(() => `${Date.now()}:${++sequence.current}`, [props.scene.mapData?.geometry,
    props.scene.robot, props.scene.robotPose, props.scene.robotJointValues, props.scene.tasks, props.scene.waypoints, props.scene.edges,
    props.scene.pointColorMode, props.scene.placedObjectColorMode, props.scene.workspaceTransfer, props.scene.mode]);
  const currentRevision = useRef(revision); currentRevision.current = revision;
  useEffect(() => {
    if (!native || !props.ready) return undefined;
    let disposed = false;
    async function perform(command) {
      if (!command?.type) return;
      if (command.generation != null) generation.current = command.generation;
      if (command.type === 'resume') { if (immersive) setLaunchPlan('resume'); return; }
      if (command.type === 'home') { operation.current?.abort(); setLaunchPlan(null); }
      else if (operation.current) return;
      const controller = new AbortController(); operation.current = controller; setRunning(true); setError('');
      const progress = message => {
        if (controller.signal.aborted) return;
        setStatus(message);
        if (immersive) visionMessage('sceneProgress', { message, busy: true, generation: generation.current }).catch(() => {});
      };
      try {
        const current = latest.current;
        if (command.type === 'sync') {
          if (immersive) setLaunchPlan('sync');
          await current.sync.request();
        } else if (command.type === 'import') {
          setLaunchPlan(null); progress('正在载入完整工程…');
          const response = await visionRequest(`imports/${command.id}`, { signal: controller.signal });
          const file = new File([await response.blob()], command.name, { type: 'application/zip' });
          controller.signal.throwIfAborted(); await current.importFile(file);
          controller.signal.throwIfAborted(); await visionRequest(`imports/${command.id}`, { method: 'DELETE' });
          if (immersive) setLaunchPlan('resume');
        } else if (command.type === 'scene') {
          const snapshotRevision = currentRevision.current;
          setLaunchPlan(null); progress('正在构建沉浸式工程…');
          await current.persist(); controller.signal.throwIfAborted();
          await openVisionWorkspaceScene(current.scene, progress, { signal: controller.signal,
            generation: generation.current, revision: snapshotRevision });
        } else if (command.type === 'home') {
          progress('正在保存工程…'); await current.persist(); await current.sync.disconnect(); await visionMessage('home');
        } else if (command.type === 'save') await current.save();
        else if (command.type === 'checkpoint') await current.persist();
      } catch (failure) {
        if (!controller.signal.aborted) {
          setLaunchPlan(null); setError(failure.message || '操作未完成，请重试');
          await visionMessage('error', { message: failure.message || '操作未完成' }).catch(() => {});
        }
      } finally {
        if (operation.current === controller) {
          operation.current = null; setRunning(false); setStatus('');
          if (immersive) visionMessage('sceneProgress', { message: '', busy: false, generation: generation.current }).catch(() => {});
        }
      }
    }
    commandHandler.current = perform;
    const command = event => { void perform(event.detail); };
    window.addEventListener('atlas-vision-command', command);
    Promise.resolve().then(async () => {
      if (disposed) return;
      try { const action = await visionMessage('ready'); if (action) await perform(action); }
      catch (failure) { if (!disposed) setError(failure.message); }
    });
    return () => { disposed = true; window.removeEventListener('atlas-vision-command', command); commandHandler.current = null; };
  }, [native, immersive, props.ready]);
  useEffect(() => {
    if (!immersive || !launchPlan || running || !props.ready || !props.sceneReady) return;
    if (launchPlan === 'sync' && props.sync.phase !== 'connected') return;
    void commandHandler.current?.({ type: 'scene' });
  }, [immersive, launchPlan, running, props.ready, props.sceneReady, props.sync.phase]);
  useEffect(() => {
    if (!native || !props.ready) return;
    visionMessage('status', { name: props.name || '', hasProject: Boolean(props.scene.mapData?.geometry),
      sceneReady: props.sceneReady, revision, phase: props.sync.phase, connected: Boolean(props.sync.link), error: props.sync.error || '',
      progress: props.sync.progress?.phase || '' }).catch(() => {});
  }, [native, props.ready, props.name, props.scene.mapData?.mapId, props.sceneReady, revision, props.sync.phase, props.sync.link?.id,
    props.sync.error, props.sync.progress?.phase]);
  if (!native || (!status && !error)) return null;
  return <div className={`vision-workbench-notice ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>
    <span>{error || status}</span>{error && <button onClick={() => setError('')}>关闭</button>}
  </div>;
}
