import { useEffect, useState } from 'react';
import { Check, Copy, QrCode, RefreshCw } from 'lucide-react';
import { ipadRequest } from '../lib/ipadTeaching.js';

// The parent keys this component by task, address and code so stale QR images
// disappear immediately when any pairing detail changes.
export default function IPadPairingQRCode({ ticket, address, disabled, copied, onCopy }) {
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [expired, setExpired] = useState(() => Date.now() >= ticket.pairingExpiresAt);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), Math.max(0, ticket.pairingExpiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [ticket.pairingExpiresAt]);
  useEffect(() => {
    if (expired || !address || disabled) return;
    const controller = new AbortController();
    setImage(''); setError('');
    ipadRequest(`/sessions/${ticket.id}/pairing-qr`, { method: 'POST', token: ticket.ownerToken,
      body: { address, code: ticket.pairingCode }, signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setImage(result.image); })
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [ticket.id, ticket.ownerToken, ticket.pairingCode, address, retry, expired, disabled]);
  return <div className="ipad-qr" data-ipad-status={ticket.status === 'ready' ? 'ready' : undefined}>
    <div className="ipad-qr__image" aria-busy={!image && !error && !expired && !!address}>
      {image && !expired && !disabled ? <img src={image} alt="设备配对二维码" width="248" height="248" />
        : <QrCode size={64} strokeWidth={1} aria-hidden="true" />}
    </div>
    <div className="ipad-qr__instructions">
      <span className="ipad-qr__eyebrow">SCAN TO CONNECT</span>
      <h3>{ticket.status === 'paired' ? '扫描二维码，同步示教结果' : '扫码接收物体或同步结果'}</h3>
      <p>iPad 首页扫码接收物体；已有示教结果时，点击「扫码同步到电脑」扫描此码。Vision Pro 搜索电脑后输入下方配对码。</p>
      <small>电脑与采集设备需连接同一局域网。</small>
      <div className="ipad-qr__manual"><div><strong className="ipad-code">{ticket.pairingCode}</strong></div>
        <button aria-label="复制配对码" disabled={disabled || expired} onClick={onCopy}>{copied ? <Check size={16} /> : <Copy size={16} />}</button>
      </div>
      <small>有效期至 {new Date(ticket.pairingExpiresAt).toLocaleTimeString()} · {ticket.status === 'paired' ? '仅限已配对设备' : '仅限一台采集设备'}</small>
      <div role="status">{expired ? '二维码已过期，请点击下方「更新配对码」。'
        : !address ? '连接局域网后即可生成二维码。' : disabled ? '正在更新配对信息…' : !image && !error ? '正在生成二维码…' : ''}</div>
      {error && <><p className="ipad-error" role="alert">{error}</p><button disabled={disabled} onClick={() => setRetry((value) => value + 1)}><RefreshCw size={14} />重新生成二维码</button></>}
    </div>
  </div>;
}
