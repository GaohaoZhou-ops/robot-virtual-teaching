import { useEffect, useRef, useState } from 'react';
import { Bot, Check, Pencil, Plus, Radio, Trash2, Undo2 } from 'lucide-react';
import { MAX_TWIN_ROBOTS } from '../lib/robotTwinFleet.js';
import { robotTwinColor } from '../lib/robotTwinAppearance.js';
import { DEFAULT_ROBOT_TWIN_ADDRESS } from '../lib/robotTwin.js';
import { loadRobotTwinProfiles, normalizeRobotProfileAddress, robotProfileAddressLabel, saveRobotTwinProfiles, ROBOT_TWIN_PROFILES_CHANGED } from '../lib/robotTwinProfiles.js';
import { forgetRobotTwinCredential, loadRobotTwinCredentials, rememberRobotTwinCredential } from '../lib/robotTwinCredentials.js';

export function RobotTwinPanel({ twin, open, onConnected }) {
  const [saved, setSaved] = useState(() => loadRobotTwinProfiles(twin?.address));
  const [editor, setEditor] = useState(null);
  const [editorError, setEditorError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [removed, setRemoved] = useState(null);
  const [passwords, setPasswords] = useState({});
  const [attemptedIds, setAttemptedIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [successShown, setSuccessShown] = useState(false);
  const editorName = useRef(null);
  const connecting = useRef(false);
  const passwordInputs = useRef(new Map());
  const active = Boolean(twin?.active);
  const selected = saved.profiles.filter((item) => saved.selectedIds.includes(item.id));
  const credentials = loadRobotTwinCredentials();
  const stateFor = (profile) => twin?.robots?.find((item) => item.id === profile.id);
  const credentialFor = (profile) => !stateFor(profile)?.authFailed
    ? credentials.find((item) => item.id === profile.id && item.address === profile.address) : null;
  const batchReady = open && !busy && attemptedIds.length > 0
    && attemptedIds.every((id) => twin?.robots?.some((item) => item.id === id && item.phase === 'live'));
  // Success belongs to the whole connection attempt, not to live/stale
  // telemetry updates. Once shown, brief polling gaps cannot remount the mark.
  const connected = open && successShown && attemptedIds.length > 0
    && attemptedIds.every((id) => twin?.robots?.some((item) => item.id === id && item.active && !item.authFailed));
  const pending = selected.filter((profile) => !stateFor(profile)?.active);
  useEffect(() => {
    const restore = () => { setSaved(loadRobotTwinProfiles()); setPasswords({}); setRemoved(null); setEditor(null); };
    window.addEventListener(ROBOT_TWIN_PROFILES_CHANGED, restore);
    return () => window.removeEventListener(ROBOT_TWIN_PROFILES_CHANGED, restore);
  }, []);
  useEffect(() => { if (batchReady) setSuccessShown(true); }, [batchReady]);
  useEffect(() => {
    if (!open) { setPasswords({}); setEditor(null); setEditorError(''); setAttemptedIds([]); setSuccessShown(false); }
  }, [open]);
  useEffect(() => { if (editor) editorName.current?.focus(); }, [Boolean(editor)]);
  useEffect(() => {
    if (!connected) return undefined;
    const timer = window.setTimeout(onConnected, 1100);
    return () => window.clearTimeout(timer);
  }, [connected, onConnected]);
  useEffect(() => {
    if (!open || busy || !twin?.authFailureKey) return undefined;
    const failed = selected.find((profile) => stateFor(profile)?.authFailed);
    const frame = requestAnimationFrame(() => passwordInputs.current.get(failed?.id)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, busy, twin?.authFailureKey]);
  const connect = async (event) => {
    event.preventDefault();
    if (!twin || connecting.current || twin.disabledReason || !selected.length || editor) return;
    connecting.current = true; setBusy(true); setRemoved(null); setSuccessShown(false);
    setAttemptedIds(selected.map((profile) => profile.id));
    try { await twin.connectMany(selected.map((profile) => ({ ...profile,
      password: credentialFor(profile)?.password ?? passwords[profile.id] ?? '' }))); }
    finally { connecting.current = false; setBusy(false); setPasswords({}); }
  };
  const persist = (next) => {
    setSaved(next);
    setStorageError(saveRobotTwinProfiles(next) ? '' : '浏览器未能保存机器人列表，本次仍可使用。');
  };
  const select = (profile) => {
    if (busy || editor) return;
    const selectedIds = saved.selectedIds.includes(profile.id) ? saved.selectedIds.filter((id) => id !== profile.id)
      : [...saved.selectedIds, profile.id];
    persist({ ...saved, selectedIds });
    setAttemptedIds([]); setRemoved(null);
  };
  const edit = (profile = null) => {
    setEditor(profile ? { ...profile, address: robotProfileAddressLabel(profile.address) } : { name: '', address: '' });
    setEditorError(''); setRemoved(null); setPasswords({}); setAttemptedIds([]);
  };
  const save = (event) => {
    event.preventDefault();
    if (busy || !editor) return;
    try {
      const name = editor.name.trim();
      if (!name) throw new Error('请填写机器人名称');
      const address = normalizeRobotProfileAddress(editor.address);
      const duplicate = saved.profiles.find((item) => item.id !== editor.id && item.address === address);
      if (duplicate) throw new Error(`此地址已保存为“${duplicate.name}”，请直接选择该卡片`);
      const profile = { id: editor.id || `robot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, name, address };
      const previous = saved.profiles.find((item) => item.id === profile.id);
      profile.color = previous?.color || robotTwinColor(profile.id, new Set(saved.profiles.map((item) => item.color)));
      if (previous && previous.address !== address) forgetRobotTwinCredential(previous);
      persist({ profiles: editor.id ? saved.profiles.map((item) => item.id === profile.id ? profile : item)
        : [...saved.profiles, profile], selectedIds: saved.selectedIds.includes(profile.id) || saved.selectedIds.length >= MAX_TWIN_ROBOTS
          ? saved.selectedIds : [...saved.selectedIds, profile.id] });
      setEditor(null); setEditorError('');
    } catch (error) { setEditorError(error.message); }
  };
  const remove = (profile) => {
    if (busy || stateFor(profile)?.active || editor) return;
    setRemoved({ profile, index: saved.profiles.indexOf(profile), selectedIds: saved.selectedIds, credential: credentialFor(profile) });
    forgetRobotTwinCredential(profile);
    const profiles = saved.profiles.filter((item) => item.id !== profile.id);
    persist({ profiles, selectedIds: saved.selectedIds.filter((id) => id !== profile.id) });
    setPasswords((value) => { const next = { ...value }; delete next[profile.id]; return next; }); setAttemptedIds([]);
  };
  const undoRemove = () => {
    if (!removed || busy) return;
    const profiles = [...saved.profiles]; profiles.splice(removed.index, 0, removed.profile);
    if (removed.credential) rememberRobotTwinCredential(removed.profile, removed.credential.password);
    persist({ profiles, selectedIds: removed.selectedIds }); setRemoved(null);
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
    <fieldset className="robot-twin-robots" aria-label="机器人卡片" disabled={busy || Boolean(editor)}>
      <div className="robot-twin-cards">
        {saved.profiles.map((profile, index) => <div key={profile.id} className={`robot-twin-card ${saved.selectedIds.includes(profile.id) ? 'is-selected' : ''}`}>
          <label className="robot-twin-card__select">
          <input type="checkbox" value={profile.id} checked={saved.selectedIds.includes(profile.id)}
            disabled={!saved.selectedIds.includes(profile.id) && selected.length >= MAX_TWIN_ROBOTS}
            aria-label={`${profile.name} ${robotProfileAddressLabel(profile.address)}`} onChange={() => select(profile)} />
          <span className="robot-twin-card__top"><Bot size={20} style={{ color: stateFor(profile)?.color || profile.color }} /><small>ROBOT / {String(index + 1).padStart(2, '0')}</small>
            <span className="robot-twin-card__check">{saved.selectedIds.includes(profile.id) && <Check size={12} />}</span></span>
          <strong title={profile.name}>{profile.name}</strong>
          <code>{robotProfileAddressLabel(profile.address)}</code>
          {stateFor(profile) && <span className={`robot-twin-card__status is-${stateFor(profile).phase}`}>
            {{ live: '实时同步中', connecting: '正在连接…', stale: '数据暂不可用', error: '连接失败', idle: '尚未连接' }[stateFor(profile).phase]}</span>}
          {stateFor(profile)?.error && <span className="robot-twin-card__error" role="alert">{stateFor(profile).error}</span>}
          </label>
          <div className="robot-twin-card__actions">
            {credentialFor(profile) && <span><Check size={11} />可直接连接</span>}
            <button type="button" disabled={stateFor(profile)?.active} onClick={() => edit(profile)} aria-label={`编辑机器人 ${profile.name}`}><Pencil size={12} />编辑</button>
            <button type="button" className="is-delete" disabled={stateFor(profile)?.active} onClick={() => remove(profile)} aria-label={`删除机器人 ${profile.name}`}><Trash2 size={12} />删除</button>
          </div>
        </div>)}
        <button type="button" className="robot-twin-card robot-twin-card--add" onClick={() => edit()} aria-label="添加机器人">
          <Plus size={22} /><strong>添加机器人</strong><span>保存新的连接地址</span>
        </button>
      </div>
    </fieldset>
    {removed && !editor && <div className="robot-twin-robots__undo" role="status"><span>已删除“{removed.profile.name}”</span>
      <button type="button" disabled={busy} onClick={undoRemove}><Undo2 size={12} />撤销删除</button></div>}
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
    {pending.filter((profile) => !credentialFor(profile)).map((profile) => <label key={profile.id} className="robot-twin-field">
      {selected.length > 1 ? `${profile.name} · 管理员密码` : '管理员密码'}
      <input ref={(node) => { if (node) passwordInputs.current.set(profile.id, node); else passwordInputs.current.delete(profile.id); }} type="password" value={passwords[profile.id] || ''} onChange={(event) => setPasswords({ ...passwords, [profile.id]: event.target.value })}
        disabled={busy} autoComplete="off" placeholder={stateFor(profile)?.authFailed ? '请重新输入管理员密码' : '需要鉴权时填写'} />
    </label>)}
    <div className={`robot-twin-panel__state ${active ? 'is-live' : ''}`} role="status">
      <Radio size={15} /><strong>{busy ? '正在连接…' : selected.length === 1 ? ({ live: '实时同步中', stale: '数据暂不可用', error: '连接失败' }[stateFor(selected[0])?.phase] || '尚未连接') : active ? `${twin.connectedCount} 台同步中` : '尚未连接'}</strong>
      <span>{selected.length ? `已勾选 ${selected.length} 台` : '请勾选机器人卡片'}</span>
    </div>
    {twin?.transitionError && <p className="work-sync-dialog__error" role="alert">{twin.transitionError}</p>}
    {selected.map((profile) => stateFor(profile)?.credentialError && <p key={profile.id} className="work-sync-dialog__error" role="status">{profile.name}：{stateFor(profile).credentialError}</p>)}
    {twin?.disabledReason && !active && <p className="work-sync-dialog__note">{twin.disabledReason}</p>}
    <div className="work-sync-dialog__actions">
      {active && <button type="button" onClick={() => twin.disconnect()}>{busy ? '取消连接' : '停止同步'}</button>}
      {active && !busy && <button type="button" onClick={onConnected}>进入孪生</button>}
      <button className="is-primary" type="submit" disabled={busy || !selected.length || !twin || Boolean(twin.disabledReason)}>
        {busy ? '正在连接…' : pending.length && active ? '重试并同步所选机器人' : '连接并同步'}</button>
    </div>
    </form>}
  </div>;
}
