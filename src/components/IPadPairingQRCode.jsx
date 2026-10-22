import { useEffect, useState } from 'react';
import { Check, Copy, Glasses, QrCode, RefreshCw, Wifi } from 'lucide-react';
import { ipadRequest } from '../lib/ipadTeaching.js';
import { publishVisionPairingOffer } from '../lib/visionPairingOffer.js';

// The parent keys this component by task, address and code so stale QR images
// disappear immediately when any pairing detail changes.
export default function IPadPairingQRCode({ device = 'ipad', mode = 'qr', ticket, address, disabled, copied, onCopy }) {
  const vision = device === 'vision';
  const wifi = !vision && mode === 'wifi';
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [automaticPairingStatus, setAutomaticPairingStatus] = useState('正在准备自动填码…');
  const [expired, setExpired] = useState(() => Date.now() >= ticket.pairingExpiresAt);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), Math.max(0, ticket.pairingExpiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [ticket.pairingExpiresAt]);
  useEffect(() => {
    if (!vision || ticket.status !== 'ready' || expired || !address) return;
    return publishVisionPairingOffer(ticket, setAutomaticPairingStatus);
  }, [vision, ticket.id, ticket.ownerToken, ticket.pairingCode, ticket.status, expired, address]);
  useEffect(() => {
    if (vision || wifi || expired || !address || disabled) return;
    const controller = new AbortController();
    setImage(''); setError('');
    ipadRequest(`/sessions/${ticket.id}/pairing-qr`, { method: 'POST', token: ticket.ownerToken,
      body: { address, code: ticket.pairingCode }, signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setImage(result.image); })
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [ticket.id, ticket.ownerToken, ticket.pairingCode, address, retry, expired, disabled, vision, wifi]);
  if (wifi) return <div className="ipad-wifi-pairing" data-ipad-status={ticket.status}>
    <span className="ipad-sync-illustration"><Wifi size={30} strokeWidth={1.5}/></span>
    <h3>{ticket.status === 'paired' ? '设备已连接，等待同步' : '在设备上输入配对码'}</h3>
    <p>{ticket.status === 'paired' ? '在「同步数据 → Wi-Fi」确认下方地址，然后上传。' : '连接同一 Wi-Fi，在设备首页选择「Wi-Fi」，找到这台 Mac。'}</p>
    <div className={`ipad-wifi-code${expired || disabled ? ' is-unavailable' : ''}`}>
      <strong className="ipad-code" aria-label={`配对码 ${ticket.pairingCode}`}>{ticket.pairingCode.split('').map((character, index) => <span key={index}>{character}</span>)}</strong>
      <button aria-label="复制配对码" disabled={disabled || expired || !address} onClick={onCopy}>{copied ? <Check size={17}/> : <Copy size={17}/>}</button>
    </div>
    <small>{expired ? '配对码已过期，请点击「更新配对码」。' : !address ? '请连接局域网后重试。' : disabled ? '正在更新配对信息…' : `有效期至 ${new Date(ticket.pairingExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · 仅限一台设备`}</small>
    <p className="ipad-wifi-pairing__hint">{ticket.status === 'paired' ? '保持此窗口打开，完成后即可接收 Pose。' : '首次配对接收物体；已配对的示教可直接同步。'}</p>
  </div>;
  return <div className="ipad-qr" data-ipad-status={ticket.status}>
    {vision ? <div className="vision-pairing-mark" aria-hidden="true"><Glasses size={72} strokeWidth={1}/><span>VISION PRO</span></div> : <div className="ipad-qr__image" aria-busy={!image && !error && !expired && !!address}>
      {image && !expired && !disabled ? <img src={image} alt="设备配对二维码" width="248" height="248" />
        : <QrCode size={64} strokeWidth={1} aria-hidden="true" />}
    </div>}
    <div className="ipad-qr__instructions">
      <span className="ipad-qr__eyebrow">{vision ? 'CONNECT VISION PRO' : 'SCAN TO CONNECT'}</span>
      <h3>{vision ? ticket.status === 'paired' ? '在 Vision Pro 完成示教并同步' : '在 Vision Pro 选择这台电脑' : ticket.status === 'paired' ? '扫描二维码，同步示教结果' : '扫码连接这台 Mac'}</h3>
      {vision ? <ol className="vision-pairing-steps">
        <li>打开「Atlas 空间示教」，点击「自动检测局域网服务器」。</li>
        <li>选择这台电脑，配对码自动填入后点击「配对并检查模型」。多个任务时可点选物体名称。</li>
        <li>确认同步模型，预览后进入空间示教。</li>
      </ol> : <><p>在设备中打开「同步数据」→「扫码」，扫描此二维码。</p><p className="ipad-qr__secondary">首次接收物体，可从设备首页扫码。<br/>设备与 Mac 需连接同一 Wi-Fi。</p></>}
      {vision && ticket.status === 'ready' && !expired && <p role="status">{automaticPairingStatus}</p>}
      <div className="ipad-qr__manual"><div><strong className="ipad-code">{ticket.pairingCode}</strong></div>
        <button aria-label="复制配对码" disabled={disabled || expired} onClick={onCopy}>{copied ? <Check size={16} /> : <Copy size={16} />}</button>
      </div>
      <small>有效期至 {new Date(ticket.pairingExpiresAt).toLocaleTimeString()} · {ticket.status === 'paired' ? '仅限已配对设备' : '仅限一台采集设备'}</small>
      <div role="status">{expired ? `配对码已过期，请点击下方「${vision ? '更新配对码' : '刷新二维码'}」。`
        : !address ? '请连接局域网后重试。' : disabled ? '正在更新配对信息…' : !vision && !image && !error ? '正在生成二维码…' : ''}</div>
      {error && <><p className="ipad-error" role="alert">{error}</p><button disabled={disabled} onClick={() => setRetry((value) => value + 1)}><RefreshCw size={14} />重新生成二维码</button></>}
    </div>
  </div>;
}
