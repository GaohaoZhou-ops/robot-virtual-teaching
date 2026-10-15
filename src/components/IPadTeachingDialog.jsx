import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, FileUp, QrCode, RefreshCw, Tablet, Wifi, X } from 'lucide-react';
import { ipadRequest, packIPadModel, readIPadTickets, rememberIPadTicket } from '../lib/ipadTeaching.js';
import { readIPadResultFile } from '../lib/ipadResultFile.js';
import IPadPairingQRCode from './IPadPairingQRCode.jsx';
import './IPadTeaching.css';

const statusText = { preparing: '准备模型', ready: '等待设备配对', paired: '已配对 · 在设备本机示教', completed: '示教完成 · 可以接收', imported: '已保存到当前工程', cancelled: '任务已结束' };

export default function IPadTeachingDialog({ mapData, onClose, onImport }) {
  const [tickets, setTickets] = useState(readIPadTickets);
  const [ticket, setTicket] = useState(() => readIPadTickets().find((item) => item.manifest.sourceMapId === mapData.mapId) || null);
  const [addresses, setAddresses] = useState([]);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [fileReceipt, setFileReceipt] = useState('');
  const [copied, setCopied] = useState(false);
  const [preparationPending, setPreparationPending] = useState(false);
  const canShowQR = ['ready', 'paired'].includes(ticket?.status);
  const legacyCode = canShowQR && !/^[A-Z0-9]{4}$/.test(ticket.pairingCode || '');
  const dialog = useRef(null), operation = useRef(false), initialized = useRef(false);
  const resultInput = useRef(null);
  const update = (next) => { rememberIPadTicket(next); setTicket(next); setTickets(readIPadTickets()); setCopied(false); };
  useEffect(() => {
    const focus = document.activeElement; dialog.current?.focus();
    return () => focus?.focus?.();
  }, []);
  useEffect(() => {
    if (!['ready', 'paired'].includes(ticket?.status)) return;
    const controller = new AbortController();
    let checking = false;
    const timer = setInterval(async () => {
      if (operation.current || checking) return;
      checking = true;
      try {
        const next = await ipadRequest(`/sessions/${ticket.id}`, { token: ticket.ownerToken, signal: controller.signal });
        if (!controller.signal.aborted && !operation.current && next.status !== ticket.status) update({ ...ticket, ...next });
      } catch { /* The manual status check remains available after a network interruption. */ }
      finally { checking = false; }
    }, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [ticket]);
  const perform = async (message, run) => {
    if (operation.current) return;
    operation.current = true; setBusy(message); setError('');
    try { await run(); } catch (e) { setError(e.message); }
    finally { operation.current = false; setBusy(''); }
  };
  const prepare = (newTransfer = false) => perform('正在准备配对二维码…', async () => {
    setPreparationPending(true);
    const info = await ipadRequest('/info');
    setAddresses(info.addresses); setAddress(info.addresses.includes(address) ? address : info.addresses[0] || '');
    let next = newTransfer ? null : ticket;
    if (next) {
      next = { ...next, ...await ipadRequest(`/sessions/${next.id}`, { token: next.ownerToken }) };
      update(next);
    }
    if (!next || next.status === 'cancelled' || next.status === 'preparing') {
      setBusy('正在准备物体…');
      const { buffer, manifest } = await packIPadModel(mapData);
      if (next?.status === 'preparing') {
        if (next.manifest.modelHash !== manifest.modelHash || next.manifest.byteLength !== manifest.byteLength) {
          throw new Error('当前物体已改变，请点击「新建传输」重新生成二维码。');
        }
      } else {
        next = await ipadRequest('/sessions', { method: 'POST', body: { manifest } });
        update(next);
      }
      setBusy('正在准备模型与二维码…');
      next = { ...next, ...await ipadRequest(`/sessions/${next.id}/model`, { token: next.ownerToken, method: 'PUT', body: buffer }) };
      update(next);
    }
    if (['ready', 'paired'].includes(next.status) && (Date.now() >= next.pairingExpiresAt || !/^[A-Z0-9]{4}$/.test(next.pairingCode || ''))) {
      next = { ...next, ...await ipadRequest(`/sessions/${next.id}/renew`, { token: next.ownerToken, method: 'POST' }) };
      update(next);
    }
    setPreparationPending(false);
  });
  useEffect(() => {
    // StrictMode replays effects; preparing a transfer must only start once per opening.
    if (initialized.current) return;
    initialized.current = true;
    prepare();
  }, []);
  const refresh = () => perform('检查完成状态…', async () => {
    const next = await ipadRequest(`/sessions/${ticket.id}`, { token: ticket.ownerToken });
    update({ ...ticket, ...next });
  });
  const receive = () => perform('保存设备示教结果…', async () => {
    const result = await ipadRequest(`/sessions/${ticket.id}/result`, { token: ticket.ownerToken });
    await onImport(result, ticket);
    const next = await ipadRequest(`/sessions/${ticket.id}/imported`, { method: 'POST', token: ticket.ownerToken });
    update({ ...ticket, ...next });
  });
  const renew = () => perform('更新配对码…', async () => {
    const next = await ipadRequest(`/sessions/${ticket.id}/renew`, { token: ticket.ownerToken, method: 'POST' });
    update({ ...ticket, ...next });
  });
  const importFile = (file) => {
    if (!file) return;
    return perform('正在校验模型并导入结果文件…', async () => {
      setFileReceipt('');
      const imported = await readIPadResultFile(file);
      await onImport(imported.result, imported.ticket);
      setFileReceipt(`已接收 ${imported.result.samples.length} 个 Pose，已保存到当前工程。重复导入会自动去重。`);
    });
  };
  const keyDown = (event) => {
    if (event.key === 'Escape' && !operation.current) { event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const elements = [...dialog.current.querySelectorAll('button:not(:disabled), select:not(:disabled), input:not([hidden]):not(:disabled)')];
    if (!elements.length) return;
    const first = elements[0], last = elements.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div className="ipad-modal" onKeyDown={keyDown}>
    <section className="ipad-dialog" role="dialog" aria-modal="true" aria-labelledby="ipad-title" ref={dialog} tabIndex={-1}>
      <header><span className="ipad-mark"><Tablet size={25} /></span><div><small>ATLAS / ON DEVICE</small><h2 id="ipad-title">移动到 iPad 或 Vision Pro 上运行</h2></div><button aria-label="关闭设备示教窗口" disabled={!!busy} onClick={onClose}><X size={18} /></button></header>
      <div className="ipad-dialog__body">
        <div className="ipad-model"><span>独立示教物体</span><strong>{mapData.name}</strong></div>
        <section className="ipad-result-file" aria-label="AirDrop 或文件接收"
          onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onDrop={(event) => {
            event.preventDefault(); event.stopPropagation();
            if (operation.current) return;
            if (event.dataTransfer.files.length !== 1) { setFileReceipt(''); setError('请一次导入一个示教结果文件'); return; }
            importFile(event.dataTransfer.files[0]);
          }}>
          <div className="ipad-result-file__heading"><FileUp size={20} aria-hidden="true"/><div>
            <h3>接收已完成的示教</h3><span>AirDrop / Type-C 文件传输</span>
          </div></div>
          <p>在 iPad 点击「AirDrop / 导出结果」，发送到这台 Mac。将收到的结果文件拖到这里，或点击导入；也可选择从 Finder 拷贝的文件。</p>
          <input ref={resultInput} type="file" hidden disabled={!!busy} accept=".json,application/json" data-ipad-result-input="true"
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; importFile(file); }}/>
          <button className="ipad-primary" disabled={!!busy} onClick={() => resultInput.current?.click()}><FileUp size={15}/>导入结果文件</button>
          <small>无需重新配对；导入时核对当前模型，保留已有示教任务。</small>
          {fileReceipt && <p className="ipad-result-file__receipt" role="status">{fileReceipt}</p>}
        </section>
        {(!ticket || ticket.status === 'preparing') && <div className="ipad-qr" aria-busy={!!busy}>
          <div className="ipad-qr__image"><QrCode size={64} strokeWidth={1} aria-hidden="true" /></div>
          <div className="ipad-qr__instructions"><span className="ipad-qr__eyebrow">SCAN TO CONNECT</span>
            <h3>{error ? '二维码准备失败' : '正在生成配对二维码'}</h3>
            <p>电脑正在准备当前物体，完成后会在这里显示二维码和配对码。</p>
          </div>
        </div>}
        {canShowQR && !legacyCode && <IPadPairingQRCode
          key={`${ticket.id}:${ticket.pairingCode}:${ticket.pairingExpiresAt}:${address}`}
          ticket={ticket} address={address} disabled={!!busy} copied={copied}
          onCopy={() => perform('复制配对码…', async () => { await navigator.clipboard.writeText(ticket.pairingCode); setCopied(true); })} />}
        <div className="ipad-connection"><Wifi size={17}/><div>{addresses.length ? <select id="ipad-lan-address" aria-label="电脑局域网地址" value={address} disabled={!!busy} onChange={(event) => setAddress(event.target.value)}>{addresses.map((item) => <option key={item}>{item}</option>)}</select> : <p>尚未发现局域网地址，请连接 Wi-Fi 或以太网后重新打开。</p>}</div></div>
        {tickets.length > 0 && <label className="ipad-history">传输任务<select disabled={!!busy} value={ticket?.id || ''} onChange={(e) => { setTicket(tickets.find((item) => item.id === e.target.value)); setError(''); }}><option value="" disabled>选择任务</option>{tickets.map((item) => <option key={item.id} value={item.id}>{item.manifest.name} · {new Date(item.createdAt).toLocaleString()} · {statusText[item.status]}</option>)}</select></label>}
        {ticket && (!['ready', 'preparing'].includes(ticket.status) || legacyCode) && <div className={`ipad-pairing is-${ticket.status}`} data-ipad-status={ticket.status}>
          <div><span>{statusText[ticket.status]}</span>{ticket.status === 'ready' && <p>此任务使用旧版配对码，请点击「更新配对码」生成 4 位码。</p>}
            {ticket.status === 'paired' && <p>{ticket.deviceName} 已配对；示教完成后可扫描上方二维码同步结果。</p>}
            {['completed', 'imported'].includes(ticket.status) && <p>{ticket.sampleCount} 个 Pose · {ticket.status === 'imported' ? '已经加入示教数据，可在三维场景查看 Pose。' : '接收后保存为独立的设备示教任务。'}</p>}
            <small>{ticket.manifest.vertices.toLocaleString()} 个顶点{ticket.manifest.indices > 0 ? ` · ${(ticket.manifest.indices / 3).toLocaleString()} 个三角面` : ''} · {(ticket.manifest.byteLength / 1048576).toFixed(1)} MiB{ticket.manifest.sampled ? ' · 旧版抽样点云；新建传输可携带完整网格' : ' · 设备可在本机调节点云密度与 Mesh 质量'}</small>
          </div>
        </div>}
        {error && <p role="alert" className="ipad-error">{error}</p>}
      </div>
      <footer><span role="status">{busy}</span><div>
        {ticket && <button disabled={!!busy} onClick={refresh}><RefreshCw size={14}/>检查完成状态</button>}
        {canShowQR && <button disabled={!!busy} onClick={renew}>更新配对码</button>}
        {['completed', 'imported'].includes(ticket?.status) ? <button className="ipad-primary" disabled={!!busy} onClick={receive}><ArrowDownToLine size={15}/>{ticket.status === 'imported' ? '再次接收（去重）' : '接收示教结果'}</button> : null}
        {preparationPending && <button className="ipad-primary" disabled={!!busy} onClick={() => prepare()}><RefreshCw size={15}/>{busy ? '正在准备二维码…' : '重试生成二维码'}</button>}
        {ticket && <button className="ipad-primary" disabled={!!busy} onClick={() => prepare(true)}><Tablet size={15}/>新建传输</button>}
      </div></footer>
    </section>
  </div>;
}
