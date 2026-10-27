import { useEffect, useId, useRef, useState } from 'react';
import { Bot, Check, Pencil, Plus, Radio, Trash2, Undo2 } from 'lucide-react';
import { DEFAULT_ROBOT_TWIN_ADDRESS } from '../lib/robotTwin.js';
import { loadRobotTwinProfiles, normalizeRobotProfileAddress, robotProfileAddressLabel, saveRobotTwinProfiles } from '../lib/robotTwinProfiles.js';

export function RobotTwinPanel({ twin, open, onConnected }) {
  const [saved, setSaved] = useState(() => loadRobotTwinProfiles(twin?.address));
  const [editor, setEditor] = useState(null);
  const [editorError, setEditorError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [removed, setRemoved] = useState(null);
  const [submittedProfile, setSubmittedProfile] = useState(null);
  const [password, setPassword] = useState('');
  const [requested, setRequested] = useState(false);
  const radioName = useId();
  const editorName = useRef(null);
  const selectedInput = useRef(null);
  const active = Boolean(twin?.active);
  const selected = saved.profiles.find((item) => item.id === saved.selectedId);
  const connected = requested && open && twin?.phase === 'live';
  const pose = twin?.pose;
  const phaseKey = active || submittedProfile === selected?.id ? twin?.phase || 'idle' : 'idle';
  const phase = { idle: '尚未连接', connecting: '正在连接…', live: '实时同步中', stale: '数据暂不可用', error: '连接失败' }[phaseKey];
  useEffect(() => {
    if (!open || !active) setRequested(false);
    if (!open) { setPassword(''); setEditor(null); setEditorError(''); }
  }, [open, active]);
  useEffect(() => {
    if (editor) editorName.current?.focus();
    else if (open) selectedInput.current?.closest('label')?.scrollIntoView({ block: 'nearest' });
  }, [Boolean(editor), saved.selectedId, open]);
  useEffect(() => {
    if (!connected) return undefined;
    const timer = window.setTimeout(onConnected, 1100);
    return () => window.clearTimeout(timer);
  }, [connected, onConnected]);
  const connect = async (event) => {
    event.preventDefault();
    if (!twin || active || twin.disabledReason || !selected || editor) return;
    const secret = password; setPassword(''); setRequested(true); setSubmittedProfile(selected.id);
    await twin.connect(selected.address, secret);
  };
  const persist = (next) => {
    setSaved(next);
    setStorageError(saveRobotTwinProfiles(next) ? '' : '浏览器未能保存机器人列表，本次仍可使用。');
  };
  const select = (id) => {
    if (active || editor) return;
    persist({ ...saved, selectedId: id });
    setPassword(''); setSubmittedProfile(null); setRemoved(null);
  };
  const edit = (profile = null) => {
    setEditor(profile ? { ...profile, address: robotProfileAddressLabel(profile.address) } : { name: '', address: '' });
    setEditorError(''); setRemoved(null); setPassword(''); setSubmittedProfile(null);
  };
  const save = (event) => {
    event.preventDefault();
    if (active || !editor) return;
    try {
      const name = editor.name.trim();
      if (!name) throw new Error('请填写机器人名称');
      const address = normalizeRobotProfileAddress(editor.address);
      const duplicate = saved.profiles.find((item) => item.id !== editor.id && item.address === address);
      if (duplicate) throw new Error(`此地址已保存为“${duplicate.name}”，请直接选择该卡片`);
      const profile = { id: editor.id || `robot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, name, address };
      persist({ profiles: editor.id ? saved.profiles.map((item) => item.id === profile.id ? profile : item)
        : [...saved.profiles, profile], selectedId: profile.id });
      setEditor(null); setEditorError('');
    } catch (error) { setEditorError(error.message); }
  };
  const remove = () => {
    if (!selected || active) return;
    setRemoved({ profile: selected, index: saved.profiles.indexOf(selected) });
    const profiles = saved.profiles.filter((item) => item.id !== selected.id);
    persist({ profiles, selectedId: profiles[0]?.id || '' });
    setPassword(''); setSubmittedProfile(null);
  };
  const undoRemove = () => {
    if (!removed || active) return;
    const profiles = [...saved.profiles]; profiles.splice(removed.index, 0, removed.profile);
    persist({ profiles, selectedId: removed.profile.id }); setRemoved(null);
  };
  if (connected) return <div className="robot-twin-success" role="status" aria-live="polite">
    <svg className="robot-twin-success__mark" viewBox="0 0 80 80" aria-hidden="true">
      <circle className="robot-twin-success__ring" cx="40" cy="40" r="34" pathLength="1" />
      <path className="robot-twin-success__check" d="M24 40.5 35 51.5 56 29" pathLength="1" />
    </svg>
    <strong>连接成功</strong>
    <span>正在进入真机孪生…</span>
  </div>;
  return <div className="robot-twin-panel">
    <fieldset className="robot-twin-robots" disabled={active || Boolean(editor)}>
      <legend>选择机器人 <span>{saved.profiles.length ? `${saved.profiles.length} 台已保存` : '添加一个连接地址开始'}</span></legend>
      <div className="robot-twin-cards">
        {saved.profiles.map((profile, index) => <label key={profile.id} className={`robot-twin-card ${profile.id === saved.selectedId ? 'is-selected' : ''}`}>
          <input type="radio" name={radioName} value={profile.id} checked={profile.id === saved.selectedId}
            ref={profile.id === saved.selectedId ? selectedInput : undefined}
            aria-label={`${profile.name} ${robotProfileAddressLabel(profile.address)}`} onChange={() => select(profile.id)} />
          <span className="robot-twin-card__top"><Bot size={20} /><small>ROBOT / {String(index + 1).padStart(2, '0')}</small>
            <span className="robot-twin-card__check">{profile.id === saved.selectedId && <Check size={12} />}</span></span>
          <strong title={profile.name}>{profile.name}</strong>
          <code>{robotProfileAddressLabel(profile.address)}</code>
        </label>)}
        <button type="button" className="robot-twin-card robot-twin-card--add" onClick={() => edit()} aria-label="添加机器人">
          <Plus size={22} /><strong>添加机器人</strong><span>保存新的连接地址</span>
        </button>
      </div>
    </fieldset>
    {!editor && <div className="robot-twin-robots__tools">
      {!selected && <span>还没有保存的机器人</span>}
      {selected && <><button type="button" disabled={active} onClick={() => edit(selected)} aria-label="编辑已选机器人"><Pencil size={12} />编辑</button>
        <button type="button" disabled={active} onClick={remove} aria-label="移除已选机器人" title="仅移除保存的连接卡片"><Trash2 size={12} />移除</button></>}
    </div>}
    {removed && !editor && <div className="robot-twin-robots__undo" role="status"><span>已移除“{removed.profile.name}”</span>
      <button type="button" disabled={active} onClick={undoRemove}><Undo2 size={12} />撤销移除</button></div>}
    {storageError && <p className="work-sync-dialog__error" role="status">{storageError}</p>}
    {editor ? <form className="robot-twin-editor" aria-label={editor.id ? '编辑机器人' : '添加机器人'} onSubmit={save}>
      <h3>{editor.id ? '编辑机器人' : '添加机器人'}</h3>
      <div className="robot-twin-editor__fields">
        <label className="robot-twin-field">机器人名称<input ref={editorName} value={editor.name} maxLength={64} required autoComplete="off"
          onChange={(event) => setEditor({ ...editor, name: event.target.value })} placeholder="例如：一号巡检机器人" /></label>
        <label className="robot-twin-field">机器人地址<input value={editor.address} maxLength={256} required autoComplete="off" spellCheck={false}
          onChange={(event) => setEditor({ ...editor, address: event.target.value })} placeholder={DEFAULT_ROBOT_TWIN_ADDRESS} /></label>
      </div>
      {editorError && <p className="work-sync-dialog__error" role="alert">{editorError}</p>}
      <div className="work-sync-dialog__actions"><button type="button" onClick={() => { setEditor(null); setEditorError(''); }}>取消编辑</button>
        <button type="submit" className="is-primary">保存机器人</button></div>
    </form> : <form className="robot-twin-connect" onSubmit={connect}>
    <label className="robot-twin-field">管理员密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)}
      disabled={active} autoComplete="off" placeholder="需要鉴权时填写" /></label>
    <div className={`robot-twin-panel__state is-${phaseKey}`} role="status">
      <Radio size={15} /><strong>{phase}</strong><span>{active ? '约 2 Hz' : 'SLAM · 20 个关节'}</span>
    </div>
    {pose && <dl className="robot-twin-panel__readings" aria-label="真机实时读数">
      <div><dt>X</dt><dd>{pose.x.toFixed(3)} m</dd></div>
      <div><dt>Y</dt><dd>{pose.y.toFixed(3)} m</dd></div>
      <div><dt>航向</dt><dd>{pose.yaw.toFixed(2)}°</dd></div>
      <div><dt>关节有效反馈</dt><dd>{twin.snapshot?.jointCount || 0} / 20</dd></div>
    </dl>}
    <p className="work-sync-dialog__note">使用机器人 SLAM 的 X / Y 和航向，保留虚拟空间中的底盘高度。当前版本直接使用原始坐标，不匹配地图名。断开后恢复离线示教姿态。</p>
    {twin?.error && (active || submittedProfile === selected?.id) && <p className="work-sync-dialog__error" role="alert">{twin.error}</p>}
    {twin?.disabledReason && !active && <p className="work-sync-dialog__note">{twin.disabledReason}</p>}
    <div className="work-sync-dialog__actions">
      {active ? <button key="disconnect" type="button" onClick={(event) => { event.preventDefault(); twin.disconnect(); }}>{twin.phase === 'connecting' ? '取消连接' : '停止同步'}</button>
        : <button key="connect" className="is-primary" type="submit" disabled={!selected || !twin || Boolean(twin.disabledReason)}>连接并同步</button>}
    </div>
    </form>}
  </div>;
}
