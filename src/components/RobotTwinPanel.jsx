import { useEffect, useState } from 'react';
import { Radio, ShieldCheck } from 'lucide-react';
import { DEFAULT_ROBOT_TWIN_ADDRESS } from '../lib/robotTwin.js';

export function RobotTwinPanel({ twin, open, onConnected }) {
  const [address, setAddress] = useState(twin?.address || DEFAULT_ROBOT_TWIN_ADDRESS);
  const [password, setPassword] = useState('');
  const [requested, setRequested] = useState(false);
  const active = Boolean(twin?.active);
  const connected = requested && open && twin?.phase === 'live';
  const pose = twin?.pose;
  const phase = { idle: '尚未连接', connecting: '正在连接…', live: '实时同步中', stale: '数据暂不可用', error: '连接失败' }[twin?.phase || 'idle'];
  useEffect(() => {
    if (!open || !active) setRequested(false);
  }, [open, active]);
  useEffect(() => {
    if (!connected) return undefined;
    const timer = window.setTimeout(onConnected, 1100);
    return () => window.clearTimeout(timer);
  }, [connected, onConnected]);
  const connect = async (event) => {
    event.preventDefault();
    if (!twin || active || twin.disabledReason) return;
    const secret = password; setPassword(''); setRequested(true);
    await twin.connect(address.trim(), secret);
  };
  if (connected) return <div className="robot-twin-success" role="status" aria-live="polite">
    <svg className="robot-twin-success__mark" viewBox="0 0 80 80" aria-hidden="true">
      <circle className="robot-twin-success__ring" cx="40" cy="40" r="34" pathLength="1" />
      <path className="robot-twin-success__check" d="M24 40.5 35 51.5 56 29" pathLength="1" />
    </svg>
    <strong>连接成功</strong>
    <span>正在进入真机孪生…</span>
  </div>;
  return <form className="robot-twin-panel" onSubmit={connect}>
    <p className="robot-twin-panel__readonly"><ShieldCheck size={15} />只读连接 · 仅接收定位与关节姿态</p>
    <label>机器人地址<input value={address} onChange={(event) => setAddress(event.target.value)}
      disabled={active} spellCheck={false} autoComplete="off" placeholder={DEFAULT_ROBOT_TWIN_ADDRESS} required /></label>
    <label>管理员密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)}
      disabled={active} autoComplete="off" placeholder="需要鉴权时填写" /></label>
    <div className={`robot-twin-panel__state is-${twin?.phase || 'idle'}`} role="status">
      <Radio size={15} /><strong>{phase}</strong><span>{active ? '约 2 Hz' : 'SLAM · 20 个关节'}</span>
    </div>
    {pose && <dl className="robot-twin-panel__readings" aria-label="真机实时读数">
      <div><dt>X</dt><dd>{pose.x.toFixed(3)} m</dd></div>
      <div><dt>Y</dt><dd>{pose.y.toFixed(3)} m</dd></div>
      <div><dt>航向</dt><dd>{pose.yaw.toFixed(2)}°</dd></div>
      <div><dt>关节有效反馈</dt><dd>{twin.snapshot?.jointCount || 0} / 20</dd></div>
    </dl>}
    <p className="work-sync-dialog__note">使用机器人 SLAM 的 X / Y 和航向，保留虚拟空间中的底盘高度。当前版本直接使用原始坐标，不匹配地图名。断开后恢复离线示教姿态。</p>
    {twin?.error && <p className="work-sync-dialog__error" role="alert">{twin.error}</p>}
    {twin?.disabledReason && !active && <p className="work-sync-dialog__note">{twin.disabledReason}</p>}
    <div className="work-sync-dialog__actions">
      {active ? <button key="disconnect" type="button" onClick={(event) => { event.preventDefault(); twin.disconnect(); }}>{twin.phase === 'connecting' ? '取消连接' : '停止同步'}</button>
        : <button key="connect" className="is-primary" type="submit" disabled={!twin || Boolean(twin.disabledReason)}>连接并同步</button>}
    </div>
  </form>;
}
