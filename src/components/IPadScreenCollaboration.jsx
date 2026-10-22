import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Cable, CheckCircle2, LoaderCircle, Monitor, RefreshCw, Square, X } from 'lucide-react';
import ZividCameraPanel from './ZividCameraPanel.jsx';
import './IPadScreenCollaboration.css';

const api = '/__atlas/ipad-screen';
async function request(route, options = {}) {
  const response = await fetch(api + route, { ...options, signal: options.signal || AbortSignal.timeout(12000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '画面协作连接失败');
  return value;
}
const endSession = (session) => session && request(`/session/${session.id}`, {
  method: 'DELETE', headers: { Authorization: `Bearer ${session.token}` }, keepalive: true,
}).catch(() => {});
const jpeg = (canvas) => new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('相机画面编码失败')), 'image/jpeg', 0.8));

export default function IPadScreenCollaboration({ open, onClose, mapData, robot, robotLoadState, cameraPoses, meshRenderQuality }) {
  const [devices, setDevices] = useState([]);
  const [selected, setSelected] = useState('');
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [frames, setFrames] = useState(0);
  const sessionRef = useRef(null), operationRef = useRef(0), mountedRef = useRef(true), startingRef = useRef(false);
  const cache = useRef({ left: null, right: null });
  const dialogRef = useRef(null), stopRef = useRef(null);
  const canStream = Boolean(mapData?.geometry && robotLoadState?.status === 'loaded' && cameraPoses?.left && cameraPoses?.right);

  const stop = useCallback(() => {
    operationRef.current += 1;
    const current = sessionRef.current; sessionRef.current = null;
    setSession(null); setFrames(0); setBusy(false); setMessage('协作已结束，可重新连接。'); cache.current = { left: null, right: null };
    void endSession(current);
  }, []);
  stopRef.current = stop;
  useEffect(() => {
    mountedRef.current = true;
    const leaving = () => { void endSession(sessionRef.current); };
    const visibility = () => {
      if (document.hidden && sessionRef.current) { stopRef.current(); setError('电脑工作台已进入后台，画面协作已停止。请返回工作台重新连接。'); }
    };
    window.addEventListener('pagehide', leaving);
    document.addEventListener('visibilitychange', visibility);
    return () => { mountedRef.current = false; operationRef.current += 1; leaving(); window.removeEventListener('pagehide', leaving); document.removeEventListener('visibilitychange', visibility); };
  }, []);

  const start = async (deviceId) => {
    if (!canStream || !deviceId || sessionRef.current || startingRef.current) return;
    startingRef.current = true;
    const operation = ++operationRef.current;
    setBusy(true); setError(''); setMessage('正在连接设备…');
    try {
      const current = await request('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId }) });
      if (!mountedRef.current || operation !== operationRef.current) { void endSession(current); return; }
      cache.current = { left: null, right: null }; sessionRef.current = current;
      setSession(current); setFrames(0); setMessage('正在准备左右臂画面…');
    } catch (failure) { if (mountedRef.current && operation === operationRef.current) setError(failure.message); }
    finally { startingRef.current = false; if (mountedRef.current && operation === operationRef.current) setBusy(false); }
  };
  const refresh = async (autoStart = false) => {
    setChecking(true); setError('');
    try {
      const value = await request('/devices');
      if (!mountedRef.current) return;
      setDevices(value.devices); setMessage(value.message || (value.devices.length ? '' : '用数据线连接并解锁 iPad / iPhone，在设备上打开 Atlas App。'));
      const ready = value.devices.filter((device) => device.ready);
      const deviceId = ready.find((device) => device.id === selected)?.id || (ready.length === 1 ? ready[0].id : '');
      setSelected(deviceId);
      if (autoStart && ready.length === 1 && !sessionRef.current) void start(deviceId);
    } catch (failure) { if (mountedRef.current) setError(failure.message); }
    finally { if (mountedRef.current) setChecking(false); }
  };
  useEffect(() => { if (open && !sessionRef.current) void refresh(true); }, [open, canStream]);
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement; dialogRef.current?.focus();
    const keys = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') {
        const controls = [...dialogRef.current.querySelectorAll('button:not(:disabled), select:not(:disabled)')];
        if (!controls.length) return;
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus(); }
      }
    };
    const dialog = dialogRef.current; dialog?.addEventListener('keydown', keys);
    return () => { dialog?.removeEventListener('keydown', keys); previous?.focus(); };
  }, [open, onClose]);

  // A separate pair of camera renderers keeps both optical views alive when the
  // inspector is closed or its enlarged view switches to a different arm.
  const copyFrame = useCallback((side, source) => {
    if (!source) { cache.current[side] = null; return; }
    const canvas = cache.current[side] || document.createElement('canvas');
    if (canvas.width !== 960 || canvas.height !== 600) { canvas.width = 960; canvas.height = 600; }
    canvas.getContext('2d').drawImage(source, 0, 0, 960, 600); cache.current[side] = canvas;
  }, []);
  useEffect(() => {
    if (!session) return undefined;
    let cancelled = false, timer, sent = 0;
    const controller = new AbortController(); let waitingSince = performance.now();
    const send = async () => {
      const began = performance.now();
      try {
        if (!cache.current.left || !cache.current.right) {
          if (began - waitingSince > 7000) throw new Error('左右臂相机未就绪，请检查机器人模型和图形渲染。');
        } else {
          waitingSince = began;
          const blobs = await Promise.all([jpeg(cache.current.left), jpeg(cache.current.right)]);
          if (cancelled) return;
          const header = new ArrayBuffer(8), view = new DataView(header);
          view.setUint32(0, blobs[0].size); view.setUint32(4, blobs[1].size);
          await request(`/session/${session.id}/frame`, { method: 'PUT', signal: controller.signal,
            headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/octet-stream' }, body: new Blob([header, ...blobs]) });
          if (!cancelled) { sent += 1; setFrames(sent); }
        }
      } catch (failure) {
        if (!cancelled) { stopRef.current(); setError(failure.message); }
        return;
      }
      // Backpressure: at most one encoded pair and one request in flight.
      if (!cancelled) timer = setTimeout(send, Math.max(0, 150 - (performance.now() - began)));
    };
    void send();
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [session]);
  useEffect(() => () => stopRef.current(), [mapData?.geometry, robot?.id]);
  useEffect(() => { if (!canStream && sessionRef.current) { stop(); setError('相机或工程已切换，画面协作已停止。'); } }, [canStream, stop]);

  return <>
    {session && <div className="ipad-screen-renderers" aria-hidden="true">
      {['left', 'right'].map((side) => <ZividCameraPanel key={side} streamOnly side={side} activeSide={side} mapData={mapData}
        robot={robot} robotLoadState={robotLoadState} cameraPoses={cameraPoses} meshRenderQuality={meshRenderQuality}
        onStreamFrame={(source) => copyFrame(side, source)} />)}
    </div>}
    {session && !open && <div className="ipad-screen-dock" role="status"><Monitor size={16}/><span>{session.deviceName} · {frames ? '画面协作中' : '准备画面…'}</span>
      <button type="button" onClick={stop} aria-label="结束画面协作"><Square size={13}/>结束协作</button></div>}
    {error && !open && <div className="ipad-screen-dock is-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="关闭协作提示"><X size={14}/></button></div>}
    {open && createPortal(<div className="ipad-screen-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="ipad-screen-dialog" role="dialog" aria-modal="true" aria-labelledby="ipad-screen-title" ref={dialogRef} tabIndex={-1}>
        <header><span className="ipad-screen-mark"><Monitor size={24}/></span><div><small>USB CAMERA VIEW</small><h2 id="ipad-screen-title">画面协作</h2></div>
          <button type="button" onClick={onClose} aria-label="关闭画面协作窗口"><X size={18}/></button></header>
        <p className="ipad-screen-intro">在 iPad / iPhone 上同时查看左右臂末端相机，轻点画面可放大单臂。</p>
        <div className="ipad-screen-pair" aria-label="共享画面内容"><div><i/>左臂相机<small>ZIVID 2 M70</small></div><div><i/>右臂相机<small>ZIVID 2 M70</small></div></div>
        {!canStream && <p className="ipad-screen-notice">请先打开示教工程，加载带左右臂末端相机的机器人。</p>}
        {session ? <div className="ipad-screen-connection"><CheckCircle2 size={20}/><div><strong>{session.deviceName}</strong><span>{frames ? '正在共享双臂画面' : '正在准备左右臂画面…'}</span></div><span className="ipad-screen-live">USB</span></div>
          : <div className="ipad-screen-devices">
            <div className="ipad-screen-device-heading"><span><Cable size={16}/>数据线连接</span><button type="button" disabled={checking || busy} onClick={() => refresh()}><RefreshCw size={14} className={checking ? 'is-spinning' : ''}/>刷新设备</button></div>
            {devices.length > 0 && <select aria-label="画面协作设备" value={selected} disabled={busy} onChange={(event) => setSelected(event.target.value)}>
              <option value="">选择已连接的设备</option>{devices.map((device) => <option key={device.id} value={device.id} disabled={!device.ready}>{device.name}{!device.ready ? ` · ${device.message}` : ''}</option>)}
            </select>}
            {devices.filter((device) => !device.ready).map((device) => <p key={device.id}>{device.name}：{device.message}</p>)}
            {message && <p>{message}</p>}{checking && <p role="status">正在检测有线设备与 App…</p>}
          </div>}
        {error && <p className="ipad-screen-error" role="alert">{error}</p>}
        <footer><small>共享当前工程的相机仿真画面</small>{session
          ? <button type="button" className="ipad-screen-primary" onClick={stop}><Square size={14}/>结束协作</button>
          : <button type="button" className="ipad-screen-primary" disabled={!canStream || !selected || busy || checking} onClick={() => start(selected)}>{busy ? <LoaderCircle size={15} className="is-spinning"/> : <Monitor size={15}/>}开始协作</button>}</footer>
        {session && <p className="ipad-screen-footnote">关闭此窗口后继续共享；结束协作可在电脑或设备上操作。</p>}
      </section>
    </div>, document.body)}
  </>;
}
