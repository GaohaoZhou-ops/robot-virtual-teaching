import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Cable, FileUp, Glasses, QrCode, RefreshCw, ShieldAlert, Tablet, Wifi, X } from 'lucide-react';
import { IPadModelMismatchError, ipadRequest, mobileTicketDevice, readDeviceTickets, rememberIPadTicket } from '../lib/ipadTeaching.js';
import { readIPadResultFile } from '../lib/ipadResultFile.js';
import IPadPairingQRCode from './IPadPairingQRCode.jsx';
import './IPadTeaching.css';
import { prepareIPadTransfer } from '../lib/ipadTransferPreparation.js';

const statusText = { preparing: '准备模型', ready: '等待设备配对', paired: '已配对 · 在设备本机示教', completed: '示教完成 · 可以接收', imported: '已保存到当前工程', cancelled: '任务已结束' };
const emptyNavigation = [];

export default function IPadTeachingDialog({ device = 'ipad', mapData, teachingTasks = [], waypoints = emptyNavigation, edges = emptyNavigation, onClose, onImport, initialAction = 'pairing', initialTicketId }) {
  const vision = device === 'vision';
  const DeviceIcon = vision ? Glasses : Tablet;
  const pairingInfo = vision ? '配对信息' : '配对二维码';
  const refreshPairingLabel = vision ? '更新配对码' : '刷新二维码';
  const [tickets, setTickets] = useState(() => readDeviceTickets(device));
  const [ticket, setTicket] = useState(() => {
    const saved = readDeviceTickets(device);
    return saved.find((item) => item.id === initialTicketId)
      || saved.find((item) => item.manifest.sourceMapId === mapData.mapId) || null;
  });
  const [lanVisible, setLanVisible] = useState(initialAction !== 'file');
  const [addresses, setAddresses] = useState([]);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [modelMismatch, setModelMismatch] = useState(null);
  const [fileReceipt, setFileReceipt] = useState('');
  const [usb, setUSB] = useState({ supported: false, devices: [], message: '正在检测数据线连接…' });
  const [usbDevice, setUSBDevice] = useState('');
  const [usbReceipt, setUSBReceipt] = useState('');
  const [copied, setCopied] = useState(false);
  const [preparationPending, setPreparationPending] = useState(initialAction !== 'file');
  const [viewingHistory, setViewingHistory] = useState(['history', 'receive', 'status'].includes(initialAction));
  const preparedInputs = useRef(null), attemptedInputs = useRef(null);
  const inputsChanged = !vision && !viewingHistory && preparedInputs.current
    && (preparedInputs.current.mapData !== mapData || preparedInputs.current.teachingTasks !== teachingTasks
      || preparedInputs.current.waypoints !== waypoints || preparedInputs.current.edges !== edges);
  const pairable = ['ready', 'paired'].includes(ticket?.status);
  const canShowQR = pairable && !preparationPending && !inputsChanged;
  const legacyCode = pairable && !/^[A-Z0-9]{4}$/.test(ticket.pairingCode || '');
  const dialog = useRef(null), operation = useRef(false), initialized = useRef(false);
  const mismatchConfirm = useRef(null), operationFocus = useRef(null);
  const resultInput = useRef(null);
  const receivedCapture = teachingTasks.find((task) => task.mobileCapture?.sessionId === ticket?.id)?.mobileCapture;
  useEffect(() => {
    if (vision || !lanVisible) return;
    const controller = new AbortController();
    let checking = false;
    const refreshUSB = async () => {
      if (checking) return;
      checking = true;
      try {
        const status = await ipadRequest('/usb', { signal: controller.signal });
        if (!controller.signal.aborted) {
          setUSB(status);
          setUSBDevice((selected) => status.devices.some((item) => item.id === selected) ? selected
            : status.devices.length === 1 ? status.devices[0].id : '');
        }
      } catch {
        if (!controller.signal.aborted) setUSB({ supported: false, devices: [], message: '数据线服务暂不可用，请检查 Mac 示教服务。' });
      } finally { checking = false; }
    };
    void refreshUSB();
    const timer = setInterval(refreshUSB, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [vision, lanVisible]);
  useEffect(() => { setUSBReceipt(''); }, [ticket?.id, usbDevice]);
  const update = (next) => {
    rememberIPadTicket(next); setTickets(readDeviceTickets(device)); setCopied(false);
    if (mobileTicketDevice(next) !== device) {
      setTicket(null); setPreparationPending(true);
      const message = '此传输已绑定另一类设备，请从对应设备入口继续，或新建传输。';
      setError(message); throw new Error(message);
    }
    setTicket(next);
  };
  useEffect(() => {
    const focus = document.activeElement; dialog.current?.focus();
    return () => focus?.focus?.();
  }, []);
  useEffect(() => {
    if (modelMismatch) mismatchConfirm.current?.focus();
  }, [modelMismatch]);
  const dismissMismatch = () => {
    setModelMismatch(null);
    requestAnimationFrame(() => {
      const focus = operationFocus.current;
      if (focus?.isConnected && !focus.disabled && dialog.current?.contains(focus)) focus.focus();
      else dialog.current?.focus();
    });
  };
  useEffect(() => {
    if (!lanVisible || !['ready', 'paired'].includes(ticket?.status)) return;
    const controller = new AbortController();
    let checking = false;
    const timer = setInterval(async () => {
      if (operation.current || checking) return;
      checking = true;
      try {
        const next = await ipadRequest(`/sessions/${ticket.id}`, { token: ticket.ownerToken, signal: controller.signal });
        if (!controller.signal.aborted && !operation.current && (next.status !== ticket.status || next.deviceName !== ticket.deviceName)) update({ ...ticket, ...next });
      } catch { /* The manual status check remains available after a network interruption. */ }
      finally { checking = false; }
    }, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [ticket, lanVisible]);
  const perform = async (message, run) => {
    if (operation.current || modelMismatch) return;
    operationFocus.current = document.activeElement;
    operation.current = true; setBusy(message); setError('');
    try { await run(); } catch (e) {
      setError(e.message);
      if (e instanceof IPadModelMismatchError) setModelMismatch(e);
    }
    finally { operation.current = false; setBusy(''); }
  };
  const prepare = (newTransfer = false, action = '') => perform(`正在准备${pairingInfo}…`, async () => {
    setPreparationPending(true);
    attemptedInputs.current = { mapData, teachingTasks, waypoints, edges };
    if (newTransfer) setViewingHistory(false);
    const info = await ipadRequest('/info');
    setAddresses(info.addresses); setAddress(info.addresses.includes(address) ? address : info.addresses[0] || '');
    const next = await prepareIPadTransfer({ ticket, mapData, teachingTasks, waypoints, edges, device, forceNew: newTransfer,
      preserveSnapshot: !newTransfer && (viewingHistory || ['history', 'receive', 'status'].includes(action)),
      renew: action === 'renew', onUpdate: update, onProgress: setBusy });
    preparedInputs.current = { mapData, teachingTasks, waypoints, edges };
    setPreparationPending(false);
    if (action === 'receive' && ['completed', 'imported'].includes(next.status)) await receiveTicket(next);
  });
  useEffect(() => {
    // StrictMode replays effects; preparing a transfer must only start once per opening.
    if (initialized.current) return;
    initialized.current = true;
    if (initialAction !== 'file') prepare(initialAction === 'new', initialAction);
  }, []);
  useEffect(() => {
    // A background workspace sync can change poses while this modal is open.
    // Hide the old QR immediately, then attempt each new input snapshot once.
    if (!inputsChanged || !lanVisible || operation.current || modelMismatch
      || (attemptedInputs.current?.mapData === mapData && attemptedInputs.current?.teachingTasks === teachingTasks
        && attemptedInputs.current?.waypoints === waypoints && attemptedInputs.current?.edges === edges)) return;
    prepare();
  }, [mapData, teachingTasks, waypoints, edges, busy, lanVisible, viewingHistory]);
  const refresh = () => perform('检查完成状态…', async () => {
    const next = await ipadRequest(`/sessions/${ticket.id}`, { token: ticket.ownerToken });
    update({ ...ticket, ...next });
  });
  const receiveTicket = async (selectedTicket) => {
    setBusy('正在校验地图并接收示教结果…');
    setFileReceipt('');
    const result = await ipadRequest(`/sessions/${selectedTicket.id}/result`, { token: selectedTicket.ownerToken });
    const task = await onImport(result, selectedTicket);
    const next = await ipadRequest(`/sessions/${selectedTicket.id}/imported`, { method: 'POST', token: selectedTicket.ownerToken });
    update({ ...selectedTicket, ...next, receivedSampleCount: task.mobileCapture.samples.length });
  };
  const receive = () => perform('正在校验地图并接收示教结果…', () => receiveTicket(ticket));
  const renew = () => prepare(false, 'renew');
  const sendUSB = () => perform('正在通过数据线发送物体，请保持设备解锁并连接…', async () => {
    setUSBReceipt('');
    setPreparationPending(true);
    const next = await prepareIPadTransfer({ ticket, mapData, teachingTasks, waypoints, edges, device,
      preserveSnapshot: viewingHistory, onUpdate: update, onProgress: setBusy });
    preparedInputs.current = { mapData, teachingTasks, waypoints, edges };
    setPreparationPending(false);
    setBusy('正在通过数据线发送物体、Pose 与停车点参考，请保持设备解锁并连接…');
    const receipt = await ipadRequest(`/sessions/${next.id}/usb`, {
      method: 'POST', token: next.ownerToken, body: { deviceId: usbDevice },
    });
    setUSBReceipt(`已传至 ${receipt.deviceName}。请在设备欢迎页「方式三 · 数据线连接」点击接收物体。`);
  });
  const importFile = (file) => {
    if (!file) return;
    return perform('正在校验模型并导入结果文件…', async () => {
      setFileReceipt('');
      const imported = await readIPadResultFile(file);
      const task = await onImport(imported.result, imported.ticket);
      setFileReceipt(`已接收 ${task.mobileCapture.samples.length} 个 Pose，已保存到当前工程。重复导入会自动去重。`);
    });
  };
  const keyDown = (event) => {
    if (modelMismatch) {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); dismissMismatch(); }
      if (event.key === 'Tab') { event.preventDefault(); mismatchConfirm.current?.focus(); }
      return;
    }
    if (event.key === 'Escape' && !operation.current) { event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const elements = [...dialog.current.querySelectorAll('button:not(:disabled), select:not(:disabled), input:not([hidden]):not(:disabled)')];
    if (!elements.length) return;
    const first = elements[0], last = elements.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div className="ipad-modal" onKeyDown={keyDown}>
    <section className="ipad-dialog" role="dialog" aria-modal={modelMismatch ? undefined : true} aria-labelledby="ipad-title" ref={dialog} tabIndex={-1} inert={modelMismatch ? '' : undefined} data-sync-entry={initialAction}>
      <header><span className="ipad-mark"><DeviceIcon size={25} /></span><div><small>{vision ? 'ATLAS / SPATIAL TEACHING' : 'ATLAS / ON DEVICE'}</small><h2 id="ipad-title">{vision ? 'Vision Pro 空间示教' : 'iPad / iPhone 示教'}</h2></div><button aria-label="关闭设备示教窗口" disabled={!!busy} onClick={onClose}><X size={18} /></button></header>
      <div className="ipad-dialog__body ipad-dialog__body--transfer">
        <div className="ipad-model"><span>独立示教物体</span><strong>{mapData.name}</strong></div>
        {!vision && <section className="ipad-result-file" aria-label="AirDrop 或文件接收"
          onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onDrop={(event) => {
            event.preventDefault(); event.stopPropagation();
            if (operation.current) return;
            if (event.dataTransfer.files.length !== 1) { setFileReceipt(''); setError('请一次导入一个示教结果文件'); return; }
            importFile(event.dataTransfer.files[0]);
          }}>
          <div className="ipad-result-file__heading"><FileUp size={20} aria-hidden="true"/><h3>接收已完成的示教</h3></div>
          <p>在 iPhone / iPad 点击「同步数据」，选择「AirDrop 导出」并分享至这台 Mac。将收到的结果文件拖到这里，或点击导入；也可选择从 Finder 拷贝的文件。</p>
          <input ref={resultInput} type="file" hidden disabled={!!busy} accept=".json,application/json" data-ipad-result-input="true"
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; importFile(file); }}/>
          <button className="ipad-primary" disabled={!!busy} onClick={() => resultInput.current?.click()}><FileUp size={15}/>导入结果文件</button>
          {fileReceipt && <p className="ipad-result-file__receipt" role="status">{fileReceipt}</p>}
        </section>}
        {lanVisible && <>
        {(!ticket || ticket.status === 'preparing' || preparationPending || inputsChanged) && <div className="ipad-qr" aria-busy={!!busy}>
          <div className={vision ? 'vision-pairing-mark' : 'ipad-qr__image'}>{vision ? <Glasses size={64} strokeWidth={1} aria-hidden="true" /> : <QrCode size={64} strokeWidth={1} aria-hidden="true" />}</div>
          <div className="ipad-qr__instructions"><span className="ipad-qr__eyebrow">{vision ? 'CONNECT VISION PRO' : 'SCAN TO CONNECT'}</span>
            <h3>{error ? `${pairingInfo}准备失败` : `正在准备${pairingInfo}`}</h3>
            <p>电脑正在准备当前物体，完成后会在这里显示{vision ? '4 位配对码' : '二维码和配对码'}。</p>
          </div>
        </div>}
        {canShowQR && !legacyCode && <IPadPairingQRCode
          key={`${ticket.id}:${ticket.pairingCode}:${ticket.pairingExpiresAt}:${address}`}
          device={device} ticket={ticket} address={address} disabled={!!busy} copied={copied}
          onCopy={() => perform('复制配对码…', async () => { await navigator.clipboard.writeText(ticket.pairingCode); setCopied(true); })} />}
        {!vision && ticket && !preparationPending && !inputsChanged && <p className="ipad-pose-summary" role="status">
          本次传输携带 {ticket.referencePoseCount || 0} 个相机 Pose：
          <span style={{ color: '#59dbe8' }}>左臂 {ticket.referenceLeftArmPoseCount || 0} 个（青色）</span> ·
          <span style={{ color: '#f4c95d' }}>右臂 {ticket.referenceRightArmPoseCount || 0} 个（金黄色）</span> ·
          <span>移动端 {ticket.referenceIPadPoseCount || 0} 个（<span style={{ color: '#b39dff' }}>iPad 紫色</span> / <span style={{ color: '#ff5a5f' }}>iPhone 红色</span>）</span>。
          {(ticket.referencePoseCount || 0) > (ticket.referenceIPadPoseCount || 0) + (ticket.referenceLeftArmPoseCount || 0) + (ticket.referenceRightArmPoseCount || 0)
            && `另有 ${(ticket.referencePoseCount || 0) - (ticket.referenceIPadPoseCount || 0) - (ticket.referenceLeftArmPoseCount || 0) - (ticket.referenceRightArmPoseCount || 0)} 个 Mac Pose 未标注左右臂。`}
          {!viewingHistory && '电脑 Pose 或停车点变更后，重新打开配对窗口或刷新二维码会自动更新。'}
        </p>}
        {!vision && ticket && !preparationPending && !inputsChanged && ticket.referenceParkingPointCount > 0 && <p className="ipad-navigation-summary" role="status">
          同步参考：{ticket.referenceParkingPointCount} 个停车点、{ticket.referencePathCount || 0} 条路网连接。
          移动端显示停车点名称、位置与朝向，仅供参考，不可编辑；路网连接暂不显示。
        </p>}
        <div className="ipad-connection"><Wifi size={17}/><div>{addresses.length ? <select id="ipad-lan-address" aria-label="电脑局域网地址" value={address} disabled={!!busy} onChange={(event) => setAddress(event.target.value)}>{addresses.map((item) => <option key={item}>{item}</option>)}</select> : <p>尚未发现局域网地址，请连接 Wi-Fi 或以太网后重新打开。</p>}</div></div>
        {!vision && <section className="ipad-usb" aria-label="通过数据线发送物体">
          <div className="ipad-usb__heading"><Cable size={20}/><h3>数据线连接</h3>
            <span>{usb.devices.some((item) => item.ready) ? '已检测到设备' : '等待连接'}</span></div>
          <p>通过 USB 将当前物体发送到 iPhone / iPad，无需连接同一 Wi-Fi。发送后在设备欢迎页的「方式三」接收。</p>
          {usb.devices.length > 0 && <select aria-label="数据线连接的 iPhone / iPad" value={usbDevice} disabled={!!busy}
            onChange={(event) => setUSBDevice(event.target.value)}>
            <option value="" disabled>选择接收物体的设备</option>
            {usb.devices.map((item) => <option key={item.id} value={item.id}>{item.name}{item.ready ? '' : ' · 请解锁并信任电脑'}</option>)}
          </select>}
          {usb.message && <p>{usb.message}</p>}
          {!usb.message && usb.devices.length === 0 && <p>请用数据线连接 iPhone / iPad，解锁并信任此电脑。</p>}
          {usb.devices.find((item) => item.id === usbDevice)?.message && <p>{usb.devices.find((item) => item.id === usbDevice).message}</p>}
          <button className="ipad-primary" onClick={sendUSB} disabled={!!busy || preparationPending || inputsChanged || !ticket
            || !['ready', 'paired', 'completed', 'imported'].includes(ticket.status) || !usb.devices.some((item) => item.id === usbDevice && item.ready)}>
            <Cable size={15}/>通过数据线发送</button>
          {usbReceipt && <p className="ipad-usb__receipt" role="status">{usbReceipt}</p>}
        </section>}
        {tickets.length > 0 && <label className="ipad-history">传输任务<select disabled={!!busy} value={ticket?.id || ''} onChange={(e) => { setTicket(tickets.find((item) => item.id === e.target.value)); setViewingHistory(true); setPreparationPending(false); setError(''); }}><option value="" disabled>选择任务</option>{tickets.map((item) => <option key={item.id} value={item.id}>{item.manifest.name} · {new Date(item.createdAt).toLocaleString()} · {statusText[item.status]}</option>)}</select></label>}
        {ticket && (!['ready', 'preparing'].includes(ticket.status) || legacyCode) && <div className={`ipad-pairing is-${ticket.status}`} data-ipad-status={ticket.status}>
          <div><span>{statusText[ticket.status]}</span>{ticket.status === 'ready' && <p>此任务使用旧版配对码，请点击「{refreshPairingLabel}」生成 4 位码。</p>}
            {ticket.status === 'paired' && <p>{ticket.deviceName} 已配对；{vision ? '示教完成后在设备端同步，再点击「检查完成状态」。' : '示教完成后可扫描上方二维码同步结果。'}若要更换采集设备，请点击「新建传输」。</p>}
            {['completed', 'imported'].includes(ticket.status) && <p>{receivedCapture?.samples.length ?? ticket.receivedSampleCount ?? ticket.sampleCount} 个 Pose · {ticket.status === 'imported' ? '已经加入示教数据，可在三维场景查看 Pose。' : '接收后保存为独立的设备示教任务。'}</p>}
            <small>{ticket.manifest.vertices.toLocaleString()} 个顶点{ticket.manifest.indices > 0 ? ` · ${(ticket.manifest.indices / 3).toLocaleString()} 个三角面` : ''} · {(ticket.manifest.byteLength / 1048576).toFixed(1)} MiB{ticket.manifest.sampled ? ' · 旧版抽样点云；新建传输可携带完整网格' : ' · 设备可在本机调节点云密度与 Mesh 质量'}</small>
          </div>
        </div>}
        </>}
        {error && <p role="alert" className="ipad-error">{error}</p>}
      </div>
      <footer><span role="status">{busy}</span><div>
        {lanVisible ? <>
        {ticket && <button disabled={!!busy} onClick={refresh}><RefreshCw size={14}/>检查完成状态</button>}
        {pairable && <button disabled={!!busy} onClick={renew}><RefreshCw size={14}/>{refreshPairingLabel}</button>}
        {['completed', 'imported'].includes(ticket?.status) ? <button className="ipad-primary" disabled={!!busy} onClick={receive}><ArrowDownToLine size={15}/>{ticket.status === 'imported' ? '再次接收（去重）' : '接收示教结果'}</button> : null}
        {preparationPending && <button className="ipad-primary" disabled={!!busy} onClick={() => prepare()}><RefreshCw size={15}/>{vision ? busy ? '正在准备配对信息…' : '重试准备配对信息' : busy ? '正在准备二维码…' : '重试生成二维码'}</button>}
        {ticket && <button className="ipad-primary" disabled={!!busy} onClick={() => prepare(true)}><DeviceIcon size={15}/>新建传输</button>}
        </> : <button disabled={!!busy} onClick={() => { setLanVisible(true); prepare(); }}><Wifi size={14}/>局域网同步</button>}
      </div></footer>
    </section>
    {modelMismatch && <div className="ipad-model-mismatch-backdrop">
      <section className="ipad-dialog ipad-model-mismatch-dialog" role="alertdialog" aria-modal="true"
        aria-labelledby="ipad-model-mismatch-title" aria-describedby="ipad-model-mismatch-message ipad-model-mismatch-hint">
        <header><span className="ipad-mark"><ShieldAlert size={25} aria-hidden="true" /></span>
          <h2 id="ipad-model-mismatch-title">独立示教地图不一致</h2></header>
        <div className="ipad-dialog__body">
          <p id="ipad-model-mismatch-message">{modelMismatch.message}</p>
          <dl className="ipad-model-comparison">
            <div><dt>Mac 当前地图</dt><dd>{modelMismatch.currentModelName}</dd></div>
            <div><dt>{modelMismatch.deviceLabel} 示教地图</dt><dd>{modelMismatch.incomingModelName}</dd></div>
          </dl>
          <p id="ipad-model-mismatch-hint">请在 Mac 打开对应地图后重试。两端已有的示教数据均保留。</p>
        </div>
        <footer><button className="ipad-primary" ref={mismatchConfirm} onClick={dismissMismatch}>知道了</button></footer>
      </section>
    </div>}
  </div>;
}
