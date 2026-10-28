import { useEffect, useId, useRef, useState } from 'react';
import { Bot, Check, Pencil, Plus, Radio, Trash2, Undo2 } from 'lucide-react';
import { DEFAULT_ROBOT_TWIN_ADDRESS } from '../lib/robotTwin.js';
import { loadRobotTwinProfiles, normalizeRobotProfileAddress, robotProfileAddressLabel, saveRobotTwinProfiles } from '../lib/robotTwinProfiles.js';
import { forgetRobotTwinCredential, loadRobotTwinCredentials, rememberRobotTwinCredential } from '../lib/robotTwinCredentials.js';

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
  const connecting = useRef(false);
  const passwordInput = useRef(null);
  const active = Boolean(twin?.active);
  const selected = saved.profiles.find((item) => item.id === saved.selectedId);
  const credentials = loadRobotTwinCredentials();
  const credentialFor = (profile) => profile && !(twin?.authFailed && twin.profileId === profile.id)
    ? credentials.find((item) => item.id === profile.id && item.address === profile.address) : null;
  const selectedCredential = credentialFor(selected);
  const connected = requested && open && twin?.phase === 'live';
  const pose = twin?.pose;
  const showConnection = active || submittedProfile === selected?.id || (twin?.authFailed && twin.profileId === selected?.id);
  const phaseKey = showConnection ? twin?.phase || 'idle' : 'idle';
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
  useEffect(() => {
    if (!open || !twin?.authFailed || twin.profileId !== saved.selectedId) return undefined;
    // The parent opens the native dialog in its effect. Focus after showModal,
    // otherwise the browser moves focus back to the first dialog button.
    const frame = window.requestAnimationFrame(() => passwordInput.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, twin?.authFailed, twin?.profileId, saved.selectedId]);
  const connectProfile = async (profile, secret) => {
    if (!twin || active || connecting.current || twin.disabledReason || !profile || editor) return;
    connecting.current = true;
    setPassword(''); setRequested(true); setSubmittedProfile(profile.id); setRemoved(null);
    try { await twin.connect(profile.address, secret, profile.id); }
    finally { connecting.current = false; }
  };
  const connect = (event) => {
    event.preventDefault();
    void connectProfile(selected, selectedCredential?.password ?? password);
  };
  const persist = (next) => {
    setSaved(next);
    setStorageError(saveRobotTwinProfiles(next) ? '' : '浏览器未能保存机器人列表，本次仍可使用。');
  };
  const select = (profile) => {
    if (active || editor) return;
    persist({ ...saved, selectedId: profile.id });
    setPassword(''); setSubmittedProfile(null); setRemoved(null);
    const credential = credentialFor(profile);
    if (credential) void connectProfile(profile, credential.password);
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
      const previous = saved.profiles.find((item) => item.id === profile.id);
      if (previous && previous.address !== address) forgetRobotTwinCredential(previous);
      persist({ profiles: editor.id ? saved.profiles.map((item) => item.id === profile.id ? profile : item)
        : [...saved.profiles, profile], selectedId: profile.id });
      setEditor(null); setEditorError('');
    } catch (error) { setEditorError(error.message); }
  };
  const remove = (profile) => {
    if (active || editor) return;
    setRemoved({ profile, index: saved.profiles.indexOf(profile), selectedId: saved.selectedId, credential: credentialFor(profile) });
    forgetRobotTwinCredential(profile);
    const profiles = saved.profiles.filter((item) => item.id !== profile.id);
    persist({ profiles, selectedId: saved.selectedId === profile.id ? profiles[0]?.id || '' : saved.selectedId });
    if (saved.selectedId === profile.id) { setPassword(''); setSubmittedProfile(null); }
  };
  const undoRemove = () => {
    if (!removed || active) return;
    const profiles = [...saved.profiles]; profiles.splice(removed.index, 0, removed.profile);
    if (removed.credential) rememberRobotTwinCredential(removed.profile, removed.credential.password);
    persist({ profiles, selectedId: removed.selectedId }); setRemoved(null);
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
    <fieldset className="robot-twin-robots" aria-label="机器人卡片" disabled={active || Boolean(editor)}>
      <div className="robot-twin-cards">
        {saved.profiles.map((profile, index) => <div key={profile.id} className={`robot-twin-card ${profile.id === saved.selectedId ? 'is-selected' : ''}`}>
          <label className="robot-twin-card__select" title={credentialFor(profile) ? '点击连接此机器人' : undefined}>
          <input type="radio" name={radioName} value={profile.id} checked={profile.id === saved.selectedId}
            ref={profile.id === saved.selectedId ? selectedInput : undefined}
            aria-label={`${profile.name} ${robotProfileAddressLabel(profile.address)}`} onChange={() => select(profile)}
            onClick={() => { if (profile.id === saved.selectedId) select(profile); }} />
          <span className="robot-twin-card__top"><Bot size={20} /><small>ROBOT / {String(index + 1).padStart(2, '0')}</small>
            <span className="robot-twin-card__check">{profile.id === saved.selectedId && <Check size={12} />}</span></span>
          <strong title={profile.name}>{profile.name}</strong>
          <code>{robotProfileAddressLabel(profile.address)}</code>
          </label>
          <div className="robot-twin-card__actions">
            {credentialFor(profile) && <span><Check size={11} />可直接连接</span>}
            <button type="button" onClick={() => edit(profile)} aria-label={`编辑机器人 ${profile.name}`}><Pencil size={12} />编辑</button>
            <button type="button" className="is-delete" onClick={() => remove(profile)} aria-label={`删除机器人 ${profile.name}`}><Trash2 size={12} />删除</button>
          </div>
        </div>)}
        <button type="button" className="robot-twin-card robot-twin-card--add" onClick={() => edit()} aria-label="添加机器人">
          <Plus size={22} /><strong>添加机器人</strong><span>保存新的连接地址</span>
        </button>
      </div>
    </fieldset>
    {removed && !editor && <div className="robot-twin-robots__undo" role="status"><span>已删除“{removed.profile.name}”</span>
      <button type="button" disabled={active} onClick={undoRemove}><Undo2 size={12} />撤销删除</button></div>}
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
    {!selectedCredential && <label className="robot-twin-field">管理员密码<input ref={passwordInput} type="password" value={password} onChange={(event) => setPassword(event.target.value)}
      disabled={active || !selected} autoComplete="off" placeholder={twin?.authFailed && twin.profileId === selected?.id ? '请重新输入管理员密码' : '需要鉴权时填写'} /></label>}
    <div className={`robot-twin-panel__state is-${phaseKey}`} role="status">
      <Radio size={15} /><strong>{phase}</strong><span>{active ? '约 2 Hz' : 'SLAM · 20 个关节'}</span>
    </div>
    {pose && <dl className="robot-twin-panel__readings" aria-label="真机实时读数">
      <div><dt>X</dt><dd>{pose.x.toFixed(3)} m</dd></div>
      <div><dt>Y</dt><dd>{pose.y.toFixed(3)} m</dd></div>
      <div><dt>航向</dt><dd>{pose.yaw.toFixed(2)}°</dd></div>
      <div><dt>关节有效反馈</dt><dd>{twin.snapshot?.jointCount || 0} / 20</dd></div>
    </dl>}
    {twin?.error && showConnection && <p className="work-sync-dialog__error" role="alert">{twin.error}</p>}
    {twin?.credentialError && showConnection && <p className="work-sync-dialog__error" role="status">{twin.credentialError}</p>}
    {twin?.disabledReason && !active && <p className="work-sync-dialog__note">{twin.disabledReason}</p>}
    <div className="work-sync-dialog__actions">
      {active ? <button key="disconnect" type="button" onClick={(event) => { event.preventDefault(); twin.disconnect(); }}>{twin.phase === 'connecting' ? '取消连接' : '停止同步'}</button>
        : <button key="connect" className="is-primary" type="submit" disabled={!selected || !twin || Boolean(twin.disabledReason)}>连接并同步</button>}
    </div>
    </form>}
  </div>;
}
