import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link2, Unplug, ShieldCheck, RefreshCw, Radio, ArrowLeft, X } from 'lucide-react';
import { RobotTwinPanel } from "../../robot-twin/ui/RobotTwinPanel.jsx";
import "./WorkSyncControl.css";

function WorkSyncProgress({ sync, compact = false }) {
  const value = sync.progress || sync.link?.transfer;
  if (!value || (!sync.link && !sync.deciding)) return null;
  const complete = sync.link?.transfer?.complete === true;
  const error = !complete && sync.error;
  const percent = complete ? 100 : Math.min(99, Math.floor(Math.max(0, value.progress || 0) * 100));
  const phase = complete ? '工程同步完成' : error ? '工程同步暂未完成' : value.phase || '正在同步工程';
  return <div className={`work-sync-progress ${compact ? 'is-compact' : ''} ${complete ? 'is-complete' : ''} ${error ? 'is-error' : ''}`}
    data-transfer-complete={String(complete)}>
    <div className="work-sync-progress__label"><span>{phase}</span><strong>{percent}%</strong></div>
    <progress aria-label="离线工程同步进度" max={100} value={percent} />
    {!compact && <span className="work-sync-progress__detail">{complete ? '可直接切换真机孪生；已同步工程保留在本机。' : error || value.detail || '工程正在同步，请保持两端页面打开。'}</span>}
  </div>;
}

function OfflineWorkSyncControl({ sync }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!sync.link) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sync.link?.id]);
  const connected = Boolean(sync.link);
  const remaining = Math.max(0, Math.ceil(((sync.link?.expiresAt || 0) - now) / 1000));
  const countdown = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  const preparing = ['preparing', 'receiving'].includes(sync.phase) || sync.deciding;
  const status = sync.error || (preparing ? ''
    : sync.pending ? '等待主机授权 · 同意后自动开始'
      : connected ? `每 3 秒同步改动 · 授权剩余 ${countdown}` : sync.reason || '');
  const unavailable = !connected && (sync.role === 'host' || sync.phase === 'starting' || sync.pending || sync.requesting);
  const title = connected ? '断开后，两端已同步和示教的结果都会保留'
    : sync.role === 'host' ? '其他设备访问本服务后，可在此申请同步；请保持本页面打开'
      : '申请同步主机工程；需主机授权后开始同步';
  return (
    <div className={`work-sync-offline ${connected ? 'is-connected' : ''}`}>
      <div className="work-sync__actions">
        <button type="button" className="work-sync__button" disabled={unavailable}
          title={title} onClick={connected ? () => sync.disconnect() : sync.request}>
          {connected ? <Unplug size={13} /> : <Link2 size={13} />}
          {connected ? '断开链接' : sync.pending ? '等待主机授权' : sync.requesting ? '正在申请…' : '申请离线协作'}
        </button>
        {connected && sync.role === 'peer' && <button type="button" className="work-sync__renew" disabled={!sync.link.transfer?.complete || sync.pending || sync.requesting}
          title="工程同步完成后可重新申请；主机再次批准后，授权有效期重新计算 5 分钟" onClick={sync.request}>
          <RefreshCw size={11} />重新申请授权
        </button>}
      </div>
      {status && <span className={`work-sync__status ${sync.error ? 'is-error' : ''}`} role="status" title={status}>{status}</span>}
    </div>
  );
}

export function WorkSyncControl({ sync, twin }) {
  const dialog = useRef(null);
  const titleId = useId();
  const [page, setPage] = useState('choose');
  const [open, setOpen] = useState(false);
  const closeAfterConnect = useCallback(() => setOpen(false), []);
  const stopTwin = () => { twin?.disconnect(); setOpen(false); };
  const transferring = sync.deciding || (sync.link && !sync.link.transfer?.complete);
  const waiting = sync.pending && !sync.link;
  useEffect(() => {
    if (twin?.authFailed) { setPage('twin'); setOpen(true); }
  }, [twin?.authFailureKey]);
  useEffect(() => {
    if (open && !dialog.current.open) dialog.current.showModal();
    else if (!open && dialog.current.open) dialog.current.close();
  }, [open]);
  const status = twin?.active ? ''
    : sync.error || (sync.link ? sync.link.transfer?.complete ? '离线协作 · 工程同步完成' : '离线协作 · 工程同步中' : sync.pending ? '离线协作 · 等待授权' : sync.reason || '');
  return <div className={`work-sync ${twin?.active || sync.link ? 'is-connected' : ''}`} data-twin-phase={twin?.phase || 'idle'}
    data-sync-phase={sync.phase} data-sync-role={sync.role} data-sync-complete={String(Boolean(sync.link?.transfer?.complete))}>
    <div className="work-sync__actions"><button type="button" className="work-sync__button" onClick={twin?.active ? stopTwin : () => { setPage('choose'); setOpen(true); }}>
      {twin?.active ? <Unplug size={13} /> : <Link2 size={13} />}{twin?.active ? '停止同步' : '同步作业'}
    </button>
    {twin?.active && <button type="button" className="work-sync__button work-sync__manage" aria-label="管理同步机器人"
      title="管理同步机器人" onClick={() => { setPage('twin'); setOpen(true); }}><Radio size={13} /></button>}</div>
    {transferring && !twin?.active && !sync.error ? <WorkSyncProgress sync={sync} compact />
      : status && <span className={`work-sync__status ${sync.error ? 'is-error' : ''}`} role="status" title={status}>{status}</span>}
    <dialog ref={dialog} className={`work-sync-dialog work-sync-mode-dialog ${page === 'twin' ? 'is-twin' : ''}`} aria-labelledby={titleId}
      onClose={() => setOpen(false)} onCancel={() => setOpen(false)}
      onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
      <div className="work-sync-dialog__heading">
        {page !== 'choose' && <button type="button" className="work-sync-dialog__icon" aria-label="返回模式选择" onClick={() => setPage('choose')}><ArrowLeft size={18} /></button>}
        <Link2 size={20} /><span>同步作业</span>
        <button type="button" className="work-sync-dialog__icon work-sync-dialog__close" aria-label="关闭同步作业" onClick={() => setOpen(false)}><X size={18} /></button>
      </div>
      <h2 id={titleId}>{page === 'choose' ? '选择同步模式' : page === 'offline' ? '离线协作' : '真机孪生'}</h2>
      {!twin?.active && <WorkSyncProgress sync={sync} />}
      {page === 'choose' ? <div className="work-sync-mode-options">
        <button type="button" onClick={() => setPage('offline')}><Link2 size={23} /><strong>离线协作</strong><span>多设备同步当前工程、示教进度与结果</span><small>{sync.link ? sync.link.transfer?.complete ? '工程同步完成 · 协作中' : '工程同步中' : '沿用现有协作功能'}</small></button>
        <button type="button" disabled={Boolean(transferring || waiting)} onClick={() => setPage('twin')}><Radio size={23} /><strong>真机孪生</strong><span>读取局域网机器人定位与姿态，映射到虚拟空间</span><small>{transferring ? '工程同步完成后可进入' : waiting ? '等待离线协作授权' : twin?.active ? '已启用 · 只读' : '只读 · 不发送运动指令'}</small></button>
      </div> : page === 'offline' ? <>
        <p>共享当前工程，每 3 秒双向同步一次；连接需主机授权。</p>
        {twin?.active ? <p className="work-sync-dialog__note">请先断开真机孪生，再进行离线协作。</p> : <>
          <OfflineWorkSyncControl sync={sync} />
          {sync.role === 'host' && !sync.link && <p className="work-sync-dialog__note">当前设备为主机。其他设备打开本工作台后，在此申请离线协作；请保持主机页面打开以接收授权请求。</p>}
        </>}
      </> : <RobotTwinPanel twin={twin ? { ...twin, disconnect: stopTwin } : twin} open={open} onConnected={closeAfterConnect} />}
    </dialog>
  </div>;
}

export function WorkSyncAuthorization({ sync }) {
  const dialog = useRef(null);
  const request = sync.requests?.[0];
  useEffect(() => {
    const element = dialog.current;
    if (request && element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); };
  }, [request?.id]);
  if (!request) return null;
  return (
    <dialog ref={dialog} className="work-sync-dialog" aria-labelledby="work-sync-title"
      onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}
      onCancel={(event) => { event.preventDefault(); if (!sync.deciding) sync.decide(request.id, false); }}>
      <div className="work-sync-dialog__heading"><ShieldCheck size={22} /><span>局域网协作授权</span></div>
      <h2 id="work-sync-title">{request.renewal ? '重新授权同步作业' : '允许另一台设备同步作业？'}</h2>
      <p><strong>{request.name}</strong>（{request.ip}）申请同步当前工程。</p>
      <dl><div><dt>当前工程</dt><dd>{sync.project?.name || '当前示教工程'}</dd></div>
        <div><dt>授权有效期</dt><dd>批准后 5 分钟</dd></div>
        <div><dt>同步间隔</dt><dd>每 3 秒，双向同步</dd></div></dl>
      <p className="work-sync-dialog__note">共享模型、示教进度和结果；两端可各自操作不同停车点。到期或任意一方断开后，各自的结果都会保留。</p>
      {sync.error && <p role="alert" className="work-sync-dialog__error">{sync.error}</p>}
      {sync.deciding && <WorkSyncProgress sync={sync} />}
      <div className="work-sync-dialog__actions">
        <button type="button" disabled={sync.deciding} onClick={() => sync.decide(request.id, false)}>拒绝</button>
        <button type="button" className="is-primary" disabled={sync.deciding} onClick={() => sync.decide(request.id, true)}>
          {sync.deciding ? '正在准备…' : '允许同步（5 分钟）'}
        </button>
      </div>
    </dialog>
  );
}
