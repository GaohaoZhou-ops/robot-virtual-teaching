import { useEffect, useRef, useState } from 'react';
import { Link2, Unplug, ShieldCheck, RefreshCw } from 'lucide-react';
import './WorkSyncControl.css';

export function WorkSyncControl({ sync, showIdleStatus = true }) {
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
  const status = sync.error || (preparing ? (sync.progress?.phase || '正在传输工程…')
    : sync.pending ? '等待主机授权 · 可再次申请'
      : connected ? `每 3 秒同步 · 授权剩余 ${countdown}` : sync.reason || (showIdleStatus ? '独立作业' : ''));
  const unavailable = !connected && (sync.role === 'host' || sync.phase === 'starting');
  const title = connected ? '断开后，两端已同步和示教的结果都会保留'
    : sync.role === 'host' ? '其他设备访问本服务后，可在此申请同步；请保持本页面打开'
      : '申请同步主机工程；主机授权前保持独立作业';
  return (
    <div className={`work-sync ${connected ? 'is-connected' : ''}`} data-sync-phase={sync.phase} data-sync-role={sync.role}>
      <div className="work-sync__actions">
        <button type="button" className="work-sync__button" disabled={unavailable}
          title={title} onClick={connected ? () => sync.disconnect() : sync.request}>
          {connected ? <Unplug size={13} /> : <Link2 size={13} />}
          {connected ? '断开链接' : '同步作业'}
        </button>
        {connected && sync.role === 'peer' && <button type="button" className="work-sync__renew"
          title="随时重新申请；主机再次批准后，授权有效期重新计算 5 分钟" onClick={sync.request}>
          <RefreshCw size={11} />重新申请授权
        </button>}
      </div>
      {status && <span className={`work-sync__status ${sync.error ? 'is-error' : ''}`} role="status" title={status}>{status}</span>}
    </div>
  );
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
      {sync.deciding && <p role="status">{sync.progress?.phase || '正在准备同步…'}</p>}
      <div className="work-sync-dialog__actions">
        <button type="button" disabled={sync.deciding} onClick={() => sync.decide(request.id, false)}>拒绝</button>
        <button type="button" className="is-primary" disabled={sync.deciding} onClick={() => sync.decide(request.id, true)}>
          {sync.deciding ? '正在准备…' : '允许同步（5 分钟）'}
        </button>
      </div>
    </dialog>
  );
}
