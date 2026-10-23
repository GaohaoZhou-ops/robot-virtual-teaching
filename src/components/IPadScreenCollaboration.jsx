import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Cable, CheckCircle2, LoaderCircle, Monitor, QrCode, RefreshCw, Square, Wifi, X } from 'lucide-react';
import ZividCameraPanel from './ZividCameraPanel.jsx';
import IPadPairingQRCode from './IPadPairingQRCode.jsx';
import { screenJointState, screenJointCommand, screenPoseCaptureCommand, screenViewportCommand } from '../lib/ipadScreenControl.js';
import { connectIPadUSBBridge } from '../lib/ipadUSBBridge.js';
import './IPadScreenCollaboration.css';

const api = '/__atlas/ipad-screen';
async function request(route, options = {}) {
  const response = await fetch(api + route, { ...options, signal: options.signal || AbortSignal.timeout(12000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '画面协作连接失败');
  return value;
}
const sessionRequest = (session, route, options) => session?.bridge ? session.bridge.request(route, options) : request(route, options);
const endSession = (session) => session && sessionRequest(session, `/session/${session.id}`, {
  method: 'DELETE', headers: { Authorization: `Bearer ${session.token}` }, keepalive: true,
}).catch(() => {});
const jpeg = (canvas) => new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('相机画面编码失败')), 'image/jpeg', 0.8));
const getQRCode = (ticket, address, signal) => request(`/session/${ticket.id}/pairing-qr`, {
  method: 'POST', signal, headers: { Authorization: `Bearer ${ticket.ownerToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ address, code: ticket.pairingCode }),
});

export default function IPadScreenCollaboration({ open, onClose, mapData, robot, robotLoadState, cameraPoses, meshRenderQuality,
  jointValues, onChangeJoint, viewportCaptureRef, controlBlockedReason = '', poseCaptureState, onRecordPose }) {
  const [devices, setDevices] = useState([]);
  const [selected, setSelected] = useState('');
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [frames, setFrames] = useState(0);
  const [remotePage, setRemotePage] = useState('cameras');
  const [capabilities, setCapabilities] = useState(null);
  const [bridgeReady, setBridgeReady] = useState(false);
  const bridgeRef = useRef(null);
  const needsBridge = Boolean(capabilities?.usbBridgeSupported && !capabilities.usbSupported);
  const [method, setMethod] = useState(null);
  const methodRef = useRef(null); methodRef.current = method;
  const [address, setAddress] = useState('');
  const [copied, setCopied] = useState(false);
  const [deviceConnected, setDeviceConnected] = useState(false);
  const controlRef = useRef(null);
  controlRef.current = { state: { ...screenJointState(robot, robotLoadState?.movableJoints, jointValues, controlBlockedReason), capture: poseCaptureState }, onChangeJoint, onRecordPose };
  const sessionRef = useRef(null), operationRef = useRef(0), mountedRef = useRef(true), startingRef = useRef(false);
  const cache = useRef({ left: null, right: null });
  const dialogRef = useRef(null), stopRef = useRef(null);
  const canStream = Boolean(mapData?.geometry && robotLoadState?.status === 'loaded' && cameraPoses?.left && cameraPoses?.right);

  const stop = useCallback(() => {
    operationRef.current += 1;
    const current = sessionRef.current; sessionRef.current = null;
    setSession(null); setDeviceConnected(false); setFrames(0); setBusy(false); setMessage('协作已结束，可重新连接。'); cache.current = { left: null, right: null };
    void endSession(current);
  }, []);
  stopRef.current = stop;
  useEffect(() => {
    mountedRef.current = true;
    const leaving = () => { void endSession(sessionRef.current); };
    window.addEventListener('pagehide', leaving);
    return () => {
      mountedRef.current = false; operationRef.current += 1;
      void Promise.resolve(endSession(sessionRef.current)).finally(() => { bridgeRef.current?.close(); bridgeRef.current = null; });
      window.removeEventListener('pagehide', leaving);
    };
  }, []);

  const start = async (deviceId) => {
    if (!canStream || !deviceId || sessionRef.current || startingRef.current) return;
    startingRef.current = true;
    const operation = ++operationRef.current;
    setBusy(true); setError(''); setMessage('正在连接设备…');
    try {
      const bridge = needsBridge ? bridgeRef.current : null;
      if (needsBridge && !bridge) throw new Error('请先连接本机助手。');
      const current = await (bridge ? bridge.request : request)('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId }) });
      if (bridge) current.bridge = bridge;
      if (!mountedRef.current || operation !== operationRef.current) { void endSession(current); return; }
      cache.current = { left: null, right: null }; sessionRef.current = current;
      setSession(current); setDeviceConnected(true); setFrames(0); setMessage('正在准备左右臂画面…');
    } catch (failure) { if (mountedRef.current && operation === operationRef.current) setError(failure.message); }
    finally { startingRef.current = false; if (mountedRef.current && operation === operationRef.current) setBusy(false); }
  };
  const refresh = async (autoStart = false) => {
    if (needsBridge && !bridgeRef.current) { setDevices([]); setSelected(''); setMessage(''); return; }
    setChecking(true); setError('');
    try {
      const value = await (needsBridge ? bridgeRef.current.request : request)('/devices');
      if (!mountedRef.current) return;
      setDevices(value.devices); setMessage(value.message || (value.devices.length ? '' : '用数据线连接并解锁 iPad / iPhone，在设备上打开 Atlas App。'));
      const ready = value.devices.filter((device) => device.ready);
      const deviceId = ready.find((device) => device.id === selected)?.id || (ready.length === 1 ? ready[0].id : '');
      setSelected(deviceId);
      if (autoStart && methodRef.current === 'usb' && ready.length === 1 && !sessionRef.current) void start(deviceId);
    } catch (failure) { if (mountedRef.current) setError(failure.message); }
    finally { if (mountedRef.current) setChecking(false); }
  };
  const connectBridge = async () => {
    setBusy(true); setError('');
    try {
      const bridge = await connectIPadUSBBridge((reason) => {
        bridgeRef.current = null;
        if (!mountedRef.current) return;
        setBridgeReady(false); setDevices([]); setSelected('');
        if (sessionRef.current?.bridge) stopRef.current();
        setError(reason);
      });
      if (!mountedRef.current) { bridge.close(); return; }
      bridgeRef.current = bridge; setBridgeReady(true);
      await refresh(true);
    } catch (failure) { if (mountedRef.current) setError(failure.message); }
    finally { if (mountedRef.current) setBusy(false); }
  };
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    request('/info').then((info) => {
      if (cancelled) return;
      setCapabilities(info); setAddress((value) => info.addresses.includes(value) ? value : info.addresses[0] || '');
      const next = methodRef.current && (methodRef.current !== 'usb' || info.usbSupported || info.usbBridgeSupported) ? methodRef.current : info.usbSupported ? 'usb' : 'qr';
      methodRef.current = next; setMethod(next);
      if (next === 'usb' && !sessionRef.current && (info.usbSupported || bridgeRef.current)) void refresh(true);
    }).catch((failure) => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; };
  }, [open, canStream]);
  const startWireless = useCallback(async () => {
    if (!canStream || !address || sessionRef.current || startingRef.current) return;
    const operation = ++operationRef.current; startingRef.current = true; setBusy(true); setError(''); setCopied(false);
    try {
      const current = await request('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'wifi' }) });
      if (!mountedRef.current || operation !== operationRef.current) { void endSession(current); return; }
      sessionRef.current = current; setSession(current); setDeviceConnected(false); setFrames(0);
    } catch (failure) { if (mountedRef.current && operation === operationRef.current) setError(failure.message); }
    finally { startingRef.current = false; if (mountedRef.current && operation === operationRef.current) setBusy(false); }
  }, [canStream, address]);
  useEffect(() => {
    // Entering the QR page prepares one pairing; cancelling or a failed request
    // must not immediately create another session.
    if (open && method === 'qr') void startWireless();
  }, [open, method, startWireless]);
  const renewPairing = async () => {
    const current = sessionRef.current;
    if (!current || deviceConnected || busy) return;
    setBusy(true); setError(''); setCopied(false);
    try {
      const update = await request(`/session/${current.id}/renew`, { method: 'POST', headers: { Authorization: `Bearer ${current.token}` } });
      if (sessionRef.current?.id !== current.id) return;
      sessionRef.current = { ...current, ...update }; setSession(sessionRef.current);
    } catch (failure) { if (sessionRef.current?.id === current.id) setError(failure.message); }
    finally { if (mountedRef.current) setBusy(false); }
  };
  const selectMethod = (next) => {
    if (deviceConnected || busy || method === next) return;
    if (sessionRef.current?.mode !== 'wifi' && sessionRef.current) stop();
    setMethod(next); methodRef.current = next; setError(''); setMessage('');
    if (next === 'usb') { if (sessionRef.current) stop(); void refresh(); }
  };
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
    let cancelled = false, connected = false, deviceReady = session.mode !== 'wifi', sending = false, timer, sent = 0, ack = 0, publishedAck = 0, page = 'cameras', viewportSent = false;
    const awaitingCommit = new Map();
    const captureRequests = new Set();
    let captureResult = null;
    let viewportAck = 0;
    const viewportControl = () => ({ ...(viewportCaptureRef.current?.getState() || { enabled: false, aspect: 1.6 }), ack: viewportAck });
    setRemotePage('cameras');
    const viewport = document.createElement('canvas'); viewport.width = 960; viewport.height = 600;
    const controller = new AbortController(); let waitingSince = performance.now();
    const url = new URL(`${api}/session/${session.id}/events`, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const connection = session.bridge ? session.bridge.events(session) : new WebSocket(url);
    const fail = (message) => {
      if (cancelled) return;
      cancelled = true; clearTimeout(timer); controller.abort();
      stopRef.current(); setError(message);
    };
    const connectTimer = setTimeout(() => fail('电脑画面连接未就绪，请重新连接。'), 8000);
    connection.onopen = () => connection.send(JSON.stringify({ token: session.token }));
    connection.onmessage = (event) => {
      if (cancelled || sessionRef.current?.id !== session.id) return;
      const status = JSON.parse(event.data);
      if (status.error) { fail(status.error); return; }
      if (status.deviceReady === true && !deviceReady) {
        deviceReady = true; waitingSince = performance.now(); setDeviceConnected(true);
        sessionRef.current = { ...sessionRef.current, deviceName: status.deviceName || 'iPad' }; setSession(sessionRef.current);
        void send();
      }
      if (status.ready && !connected) { connected = true; clearTimeout(connectTimer); void send(); }
      const changedPage = status.page && status.page !== page;
      if (status.page) { page = status.page; setRemotePage(page); }
      let changedJoint = false;
      for (const candidate of status.commands || []) {
        if (captureResult?.status === 'recording') break;
        const command = screenJointCommand(candidate, controlRef.current.state, ack);
        if (!command) continue;
        ack = command.sequence; changedJoint = true;
        awaitingCommit.set(command.name, command.value);
        controlRef.current.onChangeJoint?.(command.name, command.value);
      }
      let changedViewport = false;
      const viewState = { ...controlRef.current.state, viewportControl: viewportControl() };
      for (const candidate of status.viewportCommands || []) {
        const command = screenViewportCommand(candidate, viewState, viewportAck);
        if (!command) continue;
        // Consume once even at a zoom limit; repeated transport replies must
        // never repeat a relative camera movement.
        changedViewport = Boolean(viewportCaptureRef.current?.navigate(command)) || changedViewport;
        viewportAck = command.sequence;
      }
      if (changedPage || changedJoint || changedViewport) void send();
      const capture = screenPoseCaptureCommand(status.captureRequest, controlRef.current.state);
      if (capture && !captureRequests.has(capture.id) && captureResult?.status !== 'recording') {
        captureRequests.add(capture.id);
        captureResult = { id: capture.id, status: 'recording', message: '正在记录姿态…' };
        void send();
        void (async () => {
          try {
            const result = awaitingCommit.size
              ? { success: false, message: '关节正在同步，请稍候再记录姿态。' }
              : await controlRef.current.onRecordPose?.(capture, () => !cancelled && sessionRef.current?.id === session.id);
            if (cancelled) return;
            captureResult = { id: capture.id, status: result?.success ? 'complete' : 'error',
              message: String(result?.message || '未能记录姿态，请在网页端检查任务和停车点。').slice(0, 512) };
          } catch (failure) {
            if (cancelled) return;
            captureResult = { id: capture.id, status: 'error', message: String(failure.message || '记录姿态失败，请重试。').slice(0, 512) };
          }
          void send();
        })();
      }
    };
    connection.onerror = () => fail('电脑画面连接已断开，请重新连接。');
    connection.onclose = () => fail('画面协作已结束，请重新连接。');
    const send = async () => {
      if (cancelled || sending || !connected || !deviceReady) return;
      clearTimeout(timer); sending = true;
      const began = performance.now();
      try {
        if (!cache.current.left || !cache.current.right) {
          if (!document.hidden && began - waitingSince > 7000) throw new Error('左右臂相机未就绪，请检查机器人模型和图形渲染。');
        } else {
          waitingSince = began;
          const currentState = controlRef.current.state;
          for (const [name, value] of awaitingCommit) {
            if (currentState.joints.some((joint) => joint.name === name && Math.abs(joint.value - value) < 1e-7)) awaitingCommit.delete(name);
          }
          if (!awaitingCommit.size) publishedAck = ack;
          const state = new Blob([JSON.stringify({ ...currentState, ack: publishedAck, captureResult, viewportControl: viewportControl() })]);
          let picture = new Blob();
          if ((page === 'joints' || !viewportSent) && viewportCaptureRef.current?.capture(viewport)) {
            picture = await jpeg(viewport); viewportSent = true;
          }
          if (cancelled) return;
          const workspaceHeader = new ArrayBuffer(8), workspaceView = new DataView(workspaceHeader);
          workspaceView.setUint32(0, state.size); workspaceView.setUint32(4, picture.size);
          await sessionRequest(session, `/session/${session.id}/workspace`, { method: 'PUT', signal: controller.signal,
            headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/octet-stream' },
            body: new Blob([workspaceHeader, state, picture]) });
          const blobs = await Promise.all([jpeg(cache.current.left), jpeg(cache.current.right)]);
          if (cancelled) return;
          const header = new ArrayBuffer(8), view = new DataView(header);
          view.setUint32(0, blobs[0].size); view.setUint32(4, blobs[1].size);
          await sessionRequest(session, `/session/${session.id}/frame`, { method: 'PUT', signal: controller.signal,
            headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/octet-stream' }, body: new Blob([header, ...blobs]) });
          if (!cancelled) { sent += 1; setFrames(sent); }
        }
      } catch (failure) {
        fail(failure.message);
        return;
      } finally { sending = false; }
      // Backpressure: at most one encoded pair and one request in flight.
      if (!cancelled) timer = setTimeout(send, Math.max(0, (document.hidden && page !== 'joints' ? 1000 : 150) - (performance.now() - began)));
    };
    const resume = () => { if (!document.hidden) { waitingSince = performance.now(); void send(); } };
    document.addEventListener('visibilitychange', resume);
    document.addEventListener('resume', resume);
    return () => {
      cancelled = true; clearTimeout(timer); clearTimeout(connectTimer); controller.abort(); connection.close();
      document.removeEventListener('visibilitychange', resume); document.removeEventListener('resume', resume);
    };
  }, [session?.id]);
  useEffect(() => () => stopRef.current(), [mapData?.geometry, robot?.id]);
  useEffect(() => { if (!canStream && sessionRef.current) { stop(); setError('相机或工程已切换，画面协作已停止。'); } }, [canStream, stop]);

  return <>
    {session && deviceConnected && <div className="ipad-screen-renderers" aria-hidden="true">
      {['left', 'right'].map((side) => <ZividCameraPanel key={side} streamOnly side={side} activeSide={side} mapData={mapData}
        robot={robot} robotLoadState={robotLoadState} cameraPoses={cameraPoses} meshRenderQuality={meshRenderQuality}
        onStreamFrame={(source) => copyFrame(side, source)} />)}
    </div>}
    {session && !open && <div className="ipad-screen-dock" role="status"><Monitor size={16}/><span>{session.deviceName} · {!deviceConnected ? '等待配对…' : frames ? remotePage === 'joints' ? '关节协作中' : '画面协作中' : '准备画面…'}</span>
      <button type="button" onClick={stop} aria-label="结束画面协作"><Square size={13}/>结束协作</button></div>}
    {error && !open && <div className="ipad-screen-dock is-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="关闭协作提示"><X size={14}/></button></div>}
    {open && createPortal(<div className="ipad-screen-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="ipad-screen-dialog" role="dialog" aria-modal="true" aria-labelledby="ipad-screen-title" ref={dialogRef} tabIndex={-1}>
        <header><span className="ipad-screen-mark"><Monitor size={24}/></span><div><small>IPAD COLLABORATION</small><h2 id="ipad-screen-title">画面协作</h2></div>
          <button type="button" onClick={onClose} aria-label="关闭画面协作窗口"><X size={18}/></button></header>
        <p className="ipad-screen-intro">与 iPad 协作当前浏览器中的工程，无需先同步工程。可切换相机画面与关节控制，记录姿态保存在本页当前任务中。</p>
        <div className="ipad-screen-pair" aria-label="共享画面内容"><div><i/>左臂相机<small>ZIVID 2 M70</small></div><div><i/>右臂相机<small>ZIVID 2 M70</small></div></div>
        {!canStream && <p className="ipad-screen-notice">请先打开示教工程，加载带左右臂末端相机的机器人。</p>}
        <div className="ipad-screen-methods" role="tablist" aria-label="协作连接方式">
          {[['qr', '扫码', QrCode], ['wifi', 'Wi-Fi', Wifi], ...(capabilities?.usbSupported || capabilities?.usbBridgeSupported ? [['usb', '数据线', Cable]] : [])].map(([id, label, Icon]) =>
            <button key={id} type="button" role="tab" aria-selected={method === id} disabled={deviceConnected || busy || !capabilities}
              onClick={() => selectMethod(id)}><Icon size={15}/>{label}</button>)}
        </div>
        {session && deviceConnected ? <div className="ipad-screen-connection"><CheckCircle2 size={20}/><div><strong>{session.deviceName}</strong><span>{frames ? '正在共享双臂画面' : '正在准备左右臂画面…'}</span></div><span className="ipad-screen-live">{session.mode === 'wifi' ? 'Wi-Fi' : 'USB'}</span></div>
          : method === 'usb' ? <div className="ipad-screen-devices">
            <div className="ipad-screen-device-heading"><span><Cable size={16}/>数据线连接{bridgeReady ? ' · 本机助手已连接' : ''}</span><button type="button" disabled={checking || busy || needsBridge && !bridgeReady} onClick={() => refresh()}><RefreshCw size={14} className={checking ? 'is-spinning' : ''}/>刷新设备</button></div>
            {needsBridge && !bridgeReady && <div className="ipad-screen-helper">
              <p>在这台电脑上运行连接助手，即可通过数据线协作当前工程，无需同步工程。</p>
              <ol><li>首次使用：安装 Python 3.9 或以上；Windows 还需安装并打开“Apple 设备”App。</li>
                <li><a href={`${api}/usb-helper`} download="Atlas-iPad-USB.zip">下载数据线连接助手</a>，解压后在 Windows 双击 <code>start-windows.cmd</code>。</li>
                <li>连接并解锁 iPad，信任电脑并打开 Atlas App，再点击下方“连接本机助手”。</li></ol>
              <p>连接窗口打开后点击“允许连接此工作台”，随后可最小化。Mac 远端工作台也可运行助手内的 Python 脚本。</p>
            </div>}
            {devices.length > 0 && <select aria-label="画面协作设备" value={selected} disabled={busy} onChange={(event) => setSelected(event.target.value)}>
              <option value="">选择已连接的设备</option>{devices.map((device) => <option key={device.id} value={device.id} disabled={!device.ready}>{device.name}{!device.ready ? ` · ${device.message}` : ''}</option>)}
            </select>}
            {devices.filter((device) => !device.ready).map((device) => <p key={device.id}>{device.name}：{device.message}</p>)}
            {message && <p>{message}</p>}{checking && <p role="status">正在检测有线设备与 App…</p>}
          </div> : <div className="ipad-screen-wireless">
            {session?.mode === 'wifi' ? <>
              <IPadPairingQRCode key={`${session.id}-${session.pairingCode}-${address}-${method}`} purpose="screen" mode={method} getQRCode={getQRCode}
                ticket={{ ...session, ownerToken: session.token, status: 'ready' }} address={address} disabled={busy} copied={copied}
                onCopy={() => navigator.clipboard.writeText(session.pairingCode).then(() => setCopied(true)).catch(() => setError('复制失败，请手动输入配对码。'))}/>
              {method === 'wifi' && <button type="button" onClick={renewPairing} disabled={busy}><RefreshCw size={14}/>更新配对码</button>}
            </> : <p>{method === 'wifi' ? '生成配对码后，在 iPad 首页选择「画面协作」，填写电脑地址并输入配对码。' : busy ? '正在生成二维码…' : '使用 iPad 上 Atlas App 首页的「扫码配对」扫描二维码即可连接。'}</p>}
            <label className="ipad-screen-address">协作连接地址
              <select aria-label="协作连接地址" value={address} disabled={busy} onChange={(event) => { setAddress(event.target.value); setCopied(false); }}>
                {!address && <option value="">未找到局域网地址</option>}
                {(capabilities?.addresses || []).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <p className="ipad-screen-footnote">{address ? '电脑与 iPad 需能访问上方地址。Windows 与 Mac 均可扫码、Wi-Fi 或数据线协作；远端电脑使用数据线时需运行本机助手。' : '请先连接局域网，再重新打开此窗口。'}</p>
          </div>}
        {error && <p className="ipad-screen-error" role="alert">{error}</p>}
        <footer><small>共享当前工程的相机仿真画面</small><div className="ipad-screen-actions">{session && (deviceConnected || method !== 'qr')
          ? <button type="button" className="ipad-screen-primary" onClick={stop}><Square size={14}/>{deviceConnected ? '结束协作' : '取消配对'}</button>
          : <>{session && <button type="button" onClick={stop} disabled={busy}><Square size={14}/>取消配对</button>}
            <button type="button" className="ipad-screen-primary" disabled={!canStream || !capabilities || busy || (method === 'usb' ? checking || (!(needsBridge && !bridgeReady) && !selected) : !address)}
              onClick={() => method === 'usb' ? needsBridge && !bridgeReady ? connectBridge() : start(selected) : session ? renewPairing() : startWireless()}>{busy ? <LoaderCircle size={15} className="is-spinning"/> : method === 'qr' ? <RefreshCw size={15}/> : <Monitor size={15}/>}
              {method === 'usb' ? needsBridge && !bridgeReady ? '连接本机助手' : '开始协作' : method === 'wifi' ? '生成配对码' : '重新生成二维码'}</button></>}
        </div></footer>
        {session && <p className="ipad-screen-footnote">关闭此窗口、切换电脑窗口或标签页后仍保持协作；结束协作可在电脑或 iPad 上操作。</p>}
      </section>
    </div>, document.body)}
  </>;
}
