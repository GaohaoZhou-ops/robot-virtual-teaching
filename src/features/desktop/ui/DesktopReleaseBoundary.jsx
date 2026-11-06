import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Clock3, Download, LockKeyhole } from 'lucide-react';
import { DESKTOP_BUILD } from '../../../shared/runtime/desktop.js';
import './DesktopReleaseBoundary.css';

const ReleaseContext = createContext({ blocked: false, status: 'active', setRecovery: () => {} });
export const useDesktopRelease = () => useContext(ReleaseContext);
const minute = (value) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)).replaceAll('/', '-');

// Register recovery actions outside the inert workbench, so expiry never removes
// the only way to save a model or a complete project. Each owner has its own slot.
export function useDesktopRecovery(owner, action) {
  const { setRecovery } = useDesktopRelease();
  const ref = useRef(action); ref.current = action;
  useEffect(() => {
    if (!DESKTOP_BUILD || !action?.enabled) { setRecovery(owner, null); return; }
    setRecovery(owner, { label: action.label, run: () => ref.current.run() });
    return () => setRecovery(owner, null);
  }, [owner, action?.enabled, action?.label, setRecovery]);
}

export default function DesktopReleaseBoundary({ children }) {
  const [release, setRelease] = useState(DESKTOP_BUILD ? { status: 'checking' } : null);
  const [actions, setActions] = useState({});
  const [busy, setBusy] = useState(''), [message, setMessage] = useState('');
  const dialogRef = useRef(null);
  const blocked = DESKTOP_BUILD && !['active', 'warning'].includes(release?.status);
  const setRecovery = useMemo(() => (owner, action) => setActions((current) => {
    if (!action && !current[owner]) return current;
    const next = { ...current }; if (action) next[owner] = action; else delete next[owner]; return next;
  }), []);
  const context = useMemo(() => ({ blocked, status: release?.status || 'active', setRecovery }), [blocked, release?.status, setRecovery]);
  useEffect(() => {
    if (!DESKTOP_BUILD) return;
    const bridge = window.AtlasDesktop;
    if (!bridge) { setRelease({ status: 'unavailable' }); return; }
    let cancelled = false;
    const update = (value) => { if (!cancelled) setRelease(value); };
    const check = () => bridge.getRelease().then(update).catch(() => update({ status: 'unavailable' }));
    const unsubscribe = bridge.onRelease(update);
    void check();
    window.addEventListener('focus', check);
    return () => { cancelled = true; unsubscribe(); window.removeEventListener('focus', check); };
  }, []);
  useEffect(() => {
    if (!blocked || !dialogRef.current) return;
    const dialog = dialogRef.current;
    dialog.showModal();
    // Existing workbench shortcuts are window listeners; stop them even when a
    // modal has focus. Keyboard activation and Tab still use their native defaults.
    const stopShortcut = (event) => {
      if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey) return;
      if (!event.target.closest?.('.desktop-release__dialog') || event.ctrlKey || event.metaKey || event.key === 'Escape') event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', stopShortcut, true);
    return () => { window.removeEventListener('keydown', stopShortcut, true); dialog.close(); };
  }, [blocked]);
  const backup = async (owner, action) => {
    if (busy) return;
    setBusy(owner); setMessage('正在准备备份，请选择保存位置…');
    try { await action.run(); setMessage('备份操作已结束。请确认文件已保存，再关闭并更新应用。'); }
    catch (error) { setMessage(`备份未完成：${error.message}`); }
    finally { setBusy(''); }
  };
  return <ReleaseContext.Provider value={context}>
    <div className="desktop-workbench" inert={blocked ? '' : undefined} aria-hidden={blocked || undefined}>{children}</div>
    {DESKTOP_BUILD && release?.status === 'warning' && <aside className="desktop-release__notice" role="status">
      <Clock3 size={15} /><span>版本 {release.version} 将于 <strong>{minute(release.expiresAt)}</strong> 到期（北京时间），请联系发布者更新。</span>
    </aside>}
    {blocked && <dialog ref={dialogRef} className="desktop-release__dialog" aria-labelledby="desktop-release-title"
      onCancel={(event) => event.preventDefault()}>
      <div className="desktop-release__eyebrow"><span />ATLAS / RELEASE</div>
      <div className="desktop-release__mark"><LockKeyhole size={27} strokeWidth={1.5} /></div>
      <h1 id="desktop-release-title">{release?.status === 'expired' ? '此版本已到期' : release?.status === 'checking' ? '正在检查版本' : '无法验证此版本'}</h1>
      <p className="desktop-release__lead">{release?.status === 'expired'
        ? '请联系发布者获取新版安装包。当前工作仍保留在本机，你可以先导出备份。'
        : release?.status === 'checking' ? '正在读取发布信息和本机工作区。' : '请重新打开应用；若问题持续，请联系发布者。已有工程不会被删除。'}</p>
      {release?.expiresAt && <dl className="desktop-release__facts">
        <div><dt>当前版本</dt><dd>{release.version}<small>{release.buildId}</small></dd></div>
        <div><dt>统一失效时间 · 北京时间</dt><dd>{minute(release.expiresAt)}</dd></div>
      </dl>}
      <div className="desktop-release__actions">{Object.entries(actions).map(([owner, action]) =>
        <button type="button" key={owner} disabled={!!busy} onClick={() => backup(owner, action)}><Download size={16} />{busy === owner ? '正在备份…' : action.label}</button>)}
        <button type="button" className="desktop-release__quit" disabled={!!busy} onClick={() => window.AtlasDesktop?.quit()}>退出应用</button>
      </div>
      <p className="desktop-release__status" role="status">{message || '替换新版应用会保留工程与自动保存缓存。'}</p>
    </dialog>}
  </ReleaseContext.Provider>;
}
