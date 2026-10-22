import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, Box, Cable, Check, ChevronDown, FileUp, Glasses, LoaderCircle, QrCode, RefreshCw, ShieldAlert, Tablet, Upload, Wifi, X } from 'lucide-react';
import { IPadModelMismatchError, ipadRequest, mobileTicketDevice, readDeviceTickets, rememberIPadTicket } from '../lib/ipadTeaching.js';
import { readIPadResultFile } from '../lib/ipadResultFile.js';
import IPadPairingQRCode from './IPadPairingQRCode.jsx';
import './IPadTeaching.css';
import './IPadSyncDialog.css';
import { prepareIPadTransfer } from '../lib/ipadTransferPreparation.js';

const statusText = { preparing: '准备模型', ready: '等待设备配对', paired: '已配对 · 在设备本机示教', completed: '示教完成 · 可以接收', imported: '已保存到当前工程', cancelled: '任务已结束' };
const emptyNavigation = [];
const syncMethods = [
  { id: 'file', label: '文件导入', icon: FileUp },
  { id: 'qr', label: '扫码', icon: QrCode },
  { id: 'wifi', label: 'Wi-Fi', icon: Wifi },
];

export default function IPadTeachingDialog({ device = 'ipad', mapData, teachingTasks = [], waypoints = emptyNavigation, edges = emptyNavigation, onClose, onImport, initialAction = 'pairing', initialTicketId }) {
  const vision = device === 'vision';
  const DeviceIcon = vision ? Glasses : Tablet;
  const [method, setMethod] = useState(initialAction === 'file' ? 'file' : initialAction === 'wifi' ? 'wifi' : 'qr');
  const lanVisible = vision || method !== 'file';
  const pairingInfo = vision || method === 'wifi' ? '配对信息' : '配对二维码';
  const refreshPairingLabel = vision || method === 'wifi' ? '更新配对码' : '刷新二维码';
  const [tickets, setTickets] = useState(() => readDeviceTickets(device));
  const [ticket, setTicket] = useState(() => {
    const saved = readDeviceTickets(device);
    return saved.find((item) => item.id === initialTicketId)
      || saved.find((item) => item.manifest.sourceMapId === mapData.mapId) || null;
  });
  const [addresses, setAddresses] = useState([]);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [modelMismatch, setModelMismatch] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [usbExpanded, setUSBExpanded] = useState(false);
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
    if (vision || method !== 'file' || !usbExpanded) return;
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
  }, [vision, method, usbExpanded]);
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
  useEffect(() => {
    if (receipt && !busy) dialog.current?.querySelector('[data-sync-view]')?.focus();
  }, [receipt, busy]);
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
    setReceipt(null);
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
    if (!inputsChanged || !lanVisible || receipt || operation.current || modelMismatch
      || (attemptedInputs.current?.mapData === mapData && attemptedInputs.current?.teachingTasks === teachingTasks
        && attemptedInputs.current?.waypoints === waypoints && attemptedInputs.current?.edges === edges)) return;
    prepare();
  }, [mapData, teachingTasks, waypoints, edges, busy, lanVisible, viewingHistory, receipt]);
  const refresh = () => perform('检查完成状态…', async () => {
    const next = await ipadRequest(`/sessions/${ticket.id}`, { token: ticket.ownerToken });
    update({ ...ticket, ...next });
  });
  const receiveTicket = async (selectedTicket) => {
    setBusy('正在校验地图并接收示教结果…');
    setReceipt(null);
    const result = await ipadRequest(`/sessions/${selectedTicket.id}/result`, { token: selectedTicket.ownerToken });
    const task = await onImport(result, selectedTicket);
    let notice = '', acknowledgement;
    try {
      acknowledgement = await ipadRequest(`/sessions/${selectedTicket.id}/imported`, { method: 'POST', token: selectedTicket.ownerToken });
    } catch {
      notice = 'Pose 已保存，接收回执暂未送达。可稍后再次接收，已有数据会自动去重。';
    }
    if (acknowledgement) update({ ...selectedTicket, ...acknowledgement, receivedSampleCount: task.mobileCapture.samples.length });
    setReceipt({ count: task.mobileCapture.samples.length, source: method === 'wifi' || vision ? 'Wi-Fi' : '扫码', notice });
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
      setReceipt(null);
      const imported = await readIPadResultFile(file);
      const task = await onImport(imported.result, imported.ticket);
      setReceipt({ count: task.mobileCapture.samples.length, source: '文件导入', fileName: file.name });
    });
  };
  const changeMethod = (next) => {
    if (operation.current || next === method) return;
    setMethod(next); setReceipt(null); setError(''); setDragging(false); setCopied(false);
    if (next !== 'file' && method === 'file') prepare();
  };
  const copyCode = () => perform('复制配对码…', async () => { await navigator.clipboard.writeText(ticket.pairingCode); setCopied(true); });
  const selectHistory = (event) => {
    setTicket(tickets.find((item) => item.id === event.target.value));
    setViewingHistory(true); setPreparationPending(false); setReceipt(null); setError('');
  };
  const tabKeyDown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = syncMethods.findIndex((item) => item.id === method);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
    changeMethod(syncMethods[next].id);
    dialog.current?.querySelector(`#ipad-sync-tab-${syncMethods[next].id}`)?.focus();
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
    const elements = [...dialog.current.querySelectorAll('button:not(:disabled), select:not(:disabled), input:not([hidden]):not(:disabled), summary')]
      .filter((element) => {
        // Closed details can retain layout boxes until the browser's next paint.
        const closedDetails = element.closest('details:not([open])');
        return element.tabIndex !== -1 && element.getClientRects().length > 0
          && (!closedDetails || element === closedDetails.querySelector(':scope > summary'));
      });
    if (!elements.length) return;
    const first = elements[0], last = elements.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const needsPreparation = !ticket || ticket.status === 'preparing' || preparationPending || inputsChanged;
  const canReceive = ['completed', 'imported'].includes(ticket?.status);
  const history = tickets.length > 0 && <label className="ipad-history">传输任务
    <select disabled={!!busy} value={ticket?.id || ''} onChange={selectHistory}>
      <option value="" disabled>选择任务</option>
      {tickets.map((item) => <option key={item.id} value={item.id}>{item.manifest.name} · {new Date(item.createdAt).toLocaleString()} · {statusText[item.status]}</option>)}
    </select>
  </label>;
  const connection = <div className="ipad-connection"><Wifi size={16} aria-hidden="true"/><div>
    {addresses.length ? <label><span className="ipad-address-label">这台 Mac 的局域网地址</span>
      <select id="ipad-lan-address" aria-label="电脑局域网地址" value={address} disabled={!!busy} onChange={(event) => { setAddress(event.target.value); setCopied(false); }}>
        {addresses.map((item) => <option key={item}>{item}</option>)}
      </select></label> : <p>未发现局域网地址，请连接 Wi-Fi 或以太网后重试。</p>}
  </div></div>;
  const pairing = <>
    {needsPreparation && <div className={`ipad-sync-preparing ${vision ? 'is-vision' : ''}`} aria-busy={!!busy}>
      <span className="ipad-sync-illustration">{busy ? <LoaderCircle size={32} className="ipad-sync-spinner"/> : <RefreshCw size={32}/>}</span>
      <h3>{error ? `${pairingInfo}准备失败` : `正在准备${pairingInfo}`}</h3>
      <p>{error ? '可以重试，或切换其他同步方式。' : '正在准备当前物体与示教参考，请稍候。'}</p>
    </div>}
    {canShowQR && !legacyCode && <IPadPairingQRCode
      key={`${ticket.id}:${ticket.pairingCode}:${ticket.pairingExpiresAt}:${address}:${method}`}
      device={device} mode={method} ticket={ticket} address={address} disabled={!!busy} copied={copied} onCopy={copyCode} />}
    {!needsPreparation && (canReceive || ticket?.status === 'cancelled' || legacyCode) && <div className={`ipad-sync-arrival is-${ticket.status}`} data-ipad-status={ticket.status}>
      <span className="ipad-sync-illustration">{canReceive ? <ArrowDownToLine size={30}/> : <RefreshCw size={30}/>}</span>
      <h3>{ticket.status === 'completed' ? '示教结果已就绪' : statusText[ticket.status]}</h3>
      <p>{canReceive ? `${receivedCapture?.samples.length ?? ticket.receivedSampleCount ?? ticket.sampleCount ?? 0} 个 Pose · ${ticket.deviceName || '采集设备'}`
        : legacyCode ? `请点击「${refreshPairingLabel}」生成新的配对码。` : '新建传输，即可继续同步。'}</p>
      {canReceive && <small>{ticket.status === 'completed' ? '点击下方接收，将 Pose 保存到当前工程。' : '可再次接收，重复 Pose 会自动去重。'}</small>}
    </div>}
  </>;
  return <div className="ipad-modal" onKeyDown={keyDown}>
    <section className={`ipad-dialog${vision ? '' : ' ipad-sync-dialog'}`} role="dialog" aria-modal={modelMismatch ? undefined : true} aria-labelledby="ipad-title" ref={dialog} tabIndex={-1} inert={modelMismatch ? '' : undefined} data-sync-entry={initialAction}>
      <header><span className="ipad-mark"><DeviceIcon size={24} /></span><div><small>{vision ? 'ATLAS / SPATIAL TEACHING' : 'DEVICE SYNC'}</small><h2 id="ipad-title">{vision ? 'Vision Pro 空间示教' : 'iPad / iPhone 示教'}</h2></div><button aria-label="关闭设备示教窗口" disabled={!!busy} onClick={onClose}><X size={18} /></button></header>
      <div className="ipad-dialog__body ipad-dialog__body--transfer">
        <div className="ipad-model"><Box size={14} aria-hidden="true"/><span>当前物体</span><strong title={mapData.name}>{mapData.name}</strong></div>
        {!vision && <div className="ipad-sync-methods" role="tablist" aria-label="同步方式" onKeyDown={tabKeyDown}>
          {syncMethods.map(({ id, label, icon: Icon }) => <button key={id} id={`ipad-sync-tab-${id}`} type="button" role="tab"
            aria-selected={method === id} aria-controls="ipad-sync-panel" tabIndex={method === id ? 0 : -1} disabled={!!busy} onClick={() => changeMethod(id)}>
            <Icon size={17} aria-hidden="true"/>{label}
          </button>)}
        </div>}
        <div id="ipad-sync-panel" role={vision ? undefined : 'tabpanel'} aria-labelledby={vision ? undefined : `ipad-sync-tab-${method}`} aria-busy={!!busy}>
          {receipt ? <div className="ipad-sync-success" key={`${receipt.source}:${receipt.count}`} data-ipad-status="imported" role="status">
            <div className="ipad-sync-success__mark" aria-hidden="true">
              <svg viewBox="0 0 80 80" fill="none"><circle className="ipad-sync-success__ring" cx="40" cy="40" r="34"/><path className="ipad-sync-success__check" d="M24 40.5 35 51 56 29"/></svg>
            </div>
            <span className="ipad-sync-eyebrow">SYNC COMPLETE</span>
            <h3>同步完成</h3>
            <p className="ipad-sync-success__count"><strong>{receipt.count}</strong><span>个 Pose</span></p>
            <p className="ipad-result-file__receipt">已接收 {receipt.count} 个 Pose，已保存到当前工程。</p>
            <small>{receipt.source} · 重复导入自动去重</small>
            {receipt.fileName && <span className="ipad-sync-success__filename" title={receipt.fileName}>{receipt.fileName}</span>}
            {receipt.notice && <p className="ipad-sync-receipt-notice">{receipt.notice}</p>}
          </div> : vision ? pairing : <div className="ipad-sync-method-panel" key={method}>
            {method === 'file' ? <>
              <section className={`ipad-result-file${dragging ? ' is-dragging' : ''}${busy ? ' is-busy' : ''}`} aria-label="AirDrop 或文件接收"
                onDragEnter={(event) => { event.preventDefault(); event.stopPropagation(); if (!operation.current && event.dataTransfer.types.includes('Files')) setDragging(true); }}
                onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = operation.current ? 'none' : 'copy'; }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
                onDrop={(event) => {
                  event.preventDefault(); event.stopPropagation(); setDragging(false);
                  if (operation.current) return;
                  if (event.dataTransfer.files.length !== 1) { setError('请一次导入一个示教结果文件'); return; }
                  importFile(event.dataTransfer.files[0]);
                }}>
                <span className="ipad-sync-illustration">{busy ? <LoaderCircle size={30} className="ipad-sync-spinner"/> : <Upload size={30} strokeWidth={1.5}/>}</span>
                <h3>{dragging ? '松开，导入示教结果' : busy ? '正在导入示教结果' : '将示教结果拖到这里'}</h3>
                <p>或选择已通过 AirDrop / 数据线传到 Mac 的文件</p>
                <input ref={resultInput} type="file" hidden disabled={!!busy} accept=".json,application/json" data-ipad-result-input="true"
                  onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; importFile(file); }}/>
                <button className="ipad-primary" disabled={!!busy} onClick={() => resultInput.current?.click()}><FileUp size={15}/>导入结果文件</button>
                <small>.atlas-teaching.json</small>
              </section>
              <p className="ipad-sync-hint">在 iPad / iPhone 中打开「同步数据」→「AirDrop 导出」。</p>
              <details className="ipad-sync-details" open={usbExpanded} onToggle={(event) => setUSBExpanded(event.currentTarget.open)}>
                <summary><Cable size={14}/>需要先把物体传到设备？<ChevronDown size={14}/></summary>
                <section className="ipad-usb" aria-label="通过数据线发送物体">
                  <p>用数据线连接并解锁设备，发送后在设备首页「方式三 · 数据线连接」接收物体。</p>
                  {usb.devices.length > 0 && <select aria-label="数据线连接的 iPhone / iPad" value={usbDevice} disabled={!!busy} onChange={(event) => setUSBDevice(event.target.value)}>
                    <option value="" disabled>选择接收物体的设备</option>
                    {usb.devices.map((item) => <option key={item.id} value={item.id}>{item.name}{item.ready ? '' : ' · 请解锁并信任电脑'}</option>)}
                  </select>}
                  <p>{usb.devices.find((item) => item.id === usbDevice)?.message || usb.message || (!usb.devices.length ? '请连接设备，并信任此电脑。' : '')}</p>
                  <button disabled={!!busy || !usb.devices.some((item) => item.id === usbDevice && item.ready)} onClick={sendUSB}><Cable size={14}/>通过数据线发送</button>
                  {usbReceipt && <p className="ipad-usb__receipt" role="status">{usbReceipt}</p>}
                </section>
              </details>
            </> : <>
              {pairing}
              {method === 'wifi' && connection}
            </>}
          </div>}
        </div>
        {lanVisible && !receipt && <>
          {vision ? <>{connection}{history}</> : <details className="ipad-sync-details" open={viewingHistory || undefined}>
            <summary><ChevronDown size={14}/>传输详情与历史<span>{!needsPreparation && ticket ? `${ticket.referencePoseCount || 0} 个参考 Pose` : ''}</span></summary>
            <div className="ipad-sync-details__content">
              {method === 'qr' && connection}
              {ticket && !preparationPending && !inputsChanged && <>
                <p className="ipad-pose-summary">本次传输携带 {ticket.referencePoseCount || 0} 个相机 Pose：
                  <span>左臂 {ticket.referenceLeftArmPoseCount || 0} 个（青色）</span> · <span>右臂 {ticket.referenceRightArmPoseCount || 0} 个（金黄色）</span> · 移动端 {ticket.referenceIPadPoseCount || 0} 个。
                </p>
                {ticket.referenceParkingPointCount > 0 && <p className="ipad-navigation-summary">同步参考：{ticket.referenceParkingPointCount} 个停车点、{ticket.referencePathCount || 0} 条路网连接。设备上的停车点仅供参考，不可编辑。</p>}
              </>}
              {history}
              <div className="ipad-sync-detail-actions">
                {ticket && <button disabled={!!busy} onClick={refresh}><RefreshCw size={14}/>检查完成状态</button>}
                <button disabled={!!busy} onClick={() => prepare(true)}><DeviceIcon size={14}/>新建传输</button>
              </div>
            </div>
          </details>}
        </>}
        {error && <p role="alert" className="ipad-error">{error}</p>}
      </div>
      <footer>
        <span className={`ipad-sync-status${receipt ? ' is-success' : ''}`} role="status">
          {busy ? <LoaderCircle size={14} className="ipad-sync-spinner"/> : receipt ? <Check size={14}/> : <i className={lanVisible && pairable ? 'is-waiting' : ''}/>}
          {busy || (receipt ? '已保存到当前工程' : !lanVisible ? '文件直接导入，无需连接设备' : ticket?.status === 'paired' ? `${ticket.deviceName || '设备'} 已连接`
            : ticket?.status === 'completed' ? '示教已完成，等待接收' : ticket?.status === 'imported' ? '已接收示教结果' : error ? '请重试或切换同步方式' : '等待设备连接')}
        </span>
        <div>
          {receipt ? <>
            <button disabled={!!busy} onClick={() => {
              setReceipt(null); setError('');
              requestAnimationFrame(() => dialog.current?.querySelector('[aria-selected="true"]')?.focus());
            }}>继续同步</button>
            <button className="ipad-primary" data-sync-view disabled={!!busy} onClick={onClose}>查看示教<ArrowRight size={15}/></button>
          </> : lanVisible && <>
            {pairable && <button disabled={!!busy} onClick={renew}><RefreshCw size={14}/>{refreshPairingLabel}</button>}
            {canReceive && !preparationPending && <button className="ipad-primary" disabled={!!busy} onClick={receive}><ArrowDownToLine size={15}/>{ticket.status === 'imported' ? '再次接收（去重）' : '接收示教结果'}</button>}
            {preparationPending && !busy && <button className="ipad-primary" onClick={() => prepare()}><RefreshCw size={15}/>{vision || method === 'wifi' ? '重试准备配对信息' : '重试生成二维码'}</button>}
            {!vision && ticket?.status === 'cancelled' && <button className="ipad-primary" disabled={!!busy} onClick={() => prepare(true)}>新建传输</button>}
            {vision && ticket && <><button disabled={!!busy} onClick={refresh}><RefreshCw size={14}/>检查完成状态</button><button disabled={!!busy} onClick={() => prepare(true)}>新建传输</button></>}
          </>}
        </div>
      </footer>
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
