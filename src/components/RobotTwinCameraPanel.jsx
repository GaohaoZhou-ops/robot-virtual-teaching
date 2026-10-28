import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, Maximize2, Power, RefreshCw, Video, VideoOff, X } from 'lucide-react';
import { BODY_CAMERAS } from '../lib/robotTwinCamera.js';
import ViewerSelect from './ViewerSelect.jsx';

function CameraFrame({ camera, status, onError, children }) {
  return <div className="task-monitor-camera__stage">
    {camera?.imageUrl ? <img src={camera.imageUrl} alt={`${BODY_CAMERAS[camera.selected]}实时画面`} onError={onError} />
      : <div><Camera size={25} /><span>{camera?.catalogPhase === 'error' ? '相机列表不可用' : status}</span></div>}
    {camera?.phase === 'live' && <span className="task-monitor-camera__live"><span />LIVE</span>}
    {camera?.imageUrl && camera.phase === 'stale' && <span className="task-monitor-camera__stale" role="status" title={camera.error}>画面未更新 · 保留最后一帧</span>}
    {children}
  </div>;
}

function CameraMeta({ camera, status }) {
  return <div className="task-monitor-camera__meta"><span>{camera?.phase === 'live' ? <Video size={11} /> : <VideoOff size={11} />}{status}</span>
    {camera?.imageUrl && <span>{camera.width} × {camera.height} · {camera.fps ? camera.fps.toFixed(1) : '—'} FPS</span>}</div>;
}

function CameraPreviewDialog({ camera, status, onError, onClose }) {
  const dialogRef = useRef(null), closeRef = useRef(null), titleId = useId();
  useEffect(() => {
    const previous = document.activeElement, dialog = dialogRef.current;
    dialog.showModal(); closeRef.current?.focus();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus?.({ preventScroll: true }); };
  }, []);
  return createPortal(<dialog ref={dialogRef} className="task-monitor-camera-dialog" aria-labelledby={titleId} aria-modal="true"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
    }}>
    <header><Video size={17} /><h2 id={titleId}>{BODY_CAMERAS[camera.selected]} · 实时画面</h2>
      <button ref={closeRef} type="button" aria-label="关闭放大画面" title="关闭放大画面（Esc）" onClick={onClose}><X size={18} /></button></header>
    <CameraFrame camera={camera} status={status} onError={onError} />
    <footer><CameraMeta camera={camera} status={status} />
      {camera.error && !camera.imageUrl && <p className="task-monitor__warning" role="status">{camera.error}</p>}</footer>
  </dialog>, document.body);
}

export default function RobotTwinCameraPanel({ twin, collapsed }) {
  const camera = twin.camera;
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (collapsed) void twin.stopCamera(); }, [collapsed, twin.stopCamera]);
  const wanted = Boolean(camera?.wanted), loading = camera?.catalogPhase === 'loading';
  useEffect(() => { if (collapsed || !wanted) setExpanded(false); }, [collapsed, wanted]);
  const status = { idle: '画面未开启', starting: '正在连接画面…', live: '实时画面', stale: '等待画面恢复',
    stopping: '正在关闭画面…', error: '画面不可用' }[camera?.phase || 'idle'];
  const frameError = () => void twin.stopCamera('相机画面无法解码，请重新开启');
  return <section className="task-monitor__section task-monitor-camera" aria-label="本体相机" data-camera-phase={camera?.phase || 'idle'}>
    <div className="task-monitor__section-title"><Video size={14} /><h3>本体相机</h3>
      <button type="button" className="task-monitor-camera__refresh" aria-label="刷新相机列表" disabled={wanted || loading || twin.phase === 'connecting'}
        onClick={() => void twin.loadCameras()}><RefreshCw size={12} /></button></div>
    <div className="task-monitor-camera__controls">
      <ViewerSelect label="本体相机" ariaLabel="选择本体相机" icon={Camera}
        value={camera?.selected || ''} onChange={twin.selectCamera} disabled={loading} isActive={!collapsed}
        placeholder={loading ? '正在读取相机…' : '暂无可用相机'}
        options={(camera?.cameras || []).map((item) => ({ value: item.id, disabled: !item.available,
          label: `${item.label}${item.available ? '' : '（未发现）'}` }))} />
      <button type="button" role="switch" aria-checked={wanted} aria-label="本体相机实时画面" className={wanted ? 'is-on' : ''}
        disabled={!wanted && (!camera?.selected || camera.phase === 'stopping' || loading || twin.phase === 'connecting')}
        onClick={() => { if (wanted) void twin.stopCamera(); else void twin.startCamera(); }}>
        <Power size={12} />{wanted ? '关闭画面' : '开启画面'}</button>
    </div>
    <CameraFrame camera={camera} status={status} onError={frameError}>
      <button type="button" className="task-monitor-camera__expand" aria-label="放大本体相机画面" aria-haspopup="dialog"
        title="放大画面" disabled={!wanted} onClick={() => setExpanded(true)}><Maximize2 size={13} /></button>
    </CameraFrame>
    <CameraMeta camera={camera} status={status} />
    {(camera?.catalogError || (camera?.error && !camera.imageUrl)) && <p className="task-monitor__warning" role="status">{camera.catalogError || camera.error}</p>}
    {expanded && wanted && !collapsed && <CameraPreviewDialog camera={camera} status={status} onError={frameError} onClose={() => setExpanded(false)} />}
  </section>;
}
