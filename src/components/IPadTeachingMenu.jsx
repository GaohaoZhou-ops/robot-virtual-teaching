import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine, ArrowLeftRight, Bot, Check, ChevronDown, ChevronRight, FileUp, Glasses, History, Plus, QrCode, RefreshCw, Tablet, Wifi } from 'lucide-react';
import { ipadRequest, readDeviceTickets, rememberIPadTicket } from '../lib/ipadTeaching.js';
import './IPadTeachingMenu.css';

const transferStatus = { preparing: '准备模型', ready: '等待配对', paired: '设备示教中', completed: '待接收', imported: '已接收', cancelled: '已结束' };
export default function IPadTeachingMenu({ device = 'ipad', mapData, source, desktopCount, deviceCount, disabled, onSourceChange, onOpenSync, isActive = true, menuAnchorRef }) {
  const vision = device === 'vision';
  const deviceLabel = vision ? 'Vision Pro' : 'iPad';
  const DeviceIcon = vision ? Glasses : Tablet;
  const savedTickets = () => readDeviceTickets(device);
  const menuId = useId();
  const triggerRef = useRef(null), menuRef = useRef(null), submenuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState(null);
  const [tickets, setTickets] = useState(savedTickets);
  const [position, setPosition] = useState({});
  const [submenuPosition, setSubmenuPosition] = useState({});
  const currentTicket = tickets.find((item) => item.manifest.sourceMapId === mapData?.mapId)
    || tickets.find((item) => mapData?.sourceHash && item.manifest.sourceHash === mapData.sourceHash);
  const canReceive = ['completed', 'imported'].includes(currentTicket?.status);
  const canRenew = ['ready', 'paired'].includes(currentTicket?.status);
  const currentSourceLabel = `${deviceCount} 个 ${deviceLabel} 任务${source === device ? ' · 当前显示' : ''}`;

  const close = (focus = false) => {
    setOpen(false); setSection(null);
    if (focus) (menuAnchorRef?.current || triggerRef.current)?.focus();
  };
  const run = (action) => { close(true); action(); };
  const sync = (action, ticketId = currentTicket?.id) => run(() => onOpenSync({ action, ticketId, device }));
  const sections = [
    { id: 'source', label: '示教来源', detail: currentSourceLabel, icon: Bot },
    { id: 'sync', label: '同步与接收', detail: currentTicket ? transferStatus[currentTicket.status] : vision ? '配对码 / 局域网' : '扫码 / 文件', icon: ArrowLeftRight },
    { id: 'history', label: '传输任务', detail: `${tickets.length} 个任务`, icon: History },
  ];

  useEffect(() => { if (!isActive || disabled) { setOpen(false); setSection(null); } }, [isActive, disabled]);
  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    let checking = false;
    const refresh = async () => {
      if (checking) return;
      checking = true;
      const stored = savedTickets();
      setTickets(stored);
      try {
        const results = await Promise.allSettled(stored.filter((item) => ['ready', 'paired'].includes(item.status)).map(async (item) => {
          const next = await ipadRequest(`/sessions/${item.id}`, { token: item.ownerToken, signal: controller.signal });
          return next.status !== item.status || next.deviceName !== item.deviceName ? { ...item, ...next } : null;
        }));
        if (controller.signal.aborted) return;
        results.forEach((result) => { if (result.status === 'fulfilled' && result.value) rememberIPadTicket(result.value); });
        setTickets(savedTickets());
      } finally { checking = false; }
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    const outside = (event) => {
      if (!triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('storage', refresh);
    menuRef.current?.focus();
    return () => {
      controller.abort(); clearInterval(timer);
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('storage', refresh);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const update = () => {
      const trigger = (menuAnchorRef?.current || triggerRef.current)?.getBoundingClientRect(), menu = menuRef.current;
      if (!trigger || !menu) return;
      const padding = 8, gap = 4;
      const left = Math.max(padding, Math.min(trigger.right - menu.offsetWidth, innerWidth - menu.offsetWidth - padding));
      const top = trigger.bottom + 8;
      setPosition({ left, top });
      const parent = menu.querySelector(`[data-section="${section}"]`);
      if (!parent || !submenuRef.current) return;
      const width = submenuRef.current.offsetWidth;
      const fitsRight = left + menu.offsetWidth + gap + width <= innerWidth - padding;
      const childLeft = fitsRight ? left + menu.offsetWidth + gap : Math.max(padding, left - width - gap);
      const childTop = Math.max(padding, Math.min(top + parent.offsetTop, innerHeight - Math.min(submenuRef.current.scrollHeight, innerHeight - padding * 2) - padding));
      setSubmenuPosition({ left: childLeft - left - menu.clientLeft, top: childTop - top - menu.clientTop, maxHeight: innerHeight - childTop - padding });
    };
    update();
    const observer = new ResizeObserver(update);
    if (submenuRef.current) observer.observe(submenuRef.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [open, section, menuAnchorRef]);

  const focusChild = (id) => {
    setSection(id);
    requestAnimationFrame(() => submenuRef.current?.querySelector('button:not(:disabled)')?.focus());
  };
  const keyDown = (event) => {
    event.stopPropagation();
    const child = submenuRef.current?.contains(event.target);
    const parent = menuRef.current?.querySelector(`[data-section="${section}"]`);
    if (event.key === 'Escape' || (child && event.key === 'ArrowLeft')) {
      event.preventDefault();
      if (child) { parent?.focus(); setSection(null); } else close(true);
    } else if (event.key === 'Tab') {
      close(true);
    } else if (event.key === 'ArrowRight' && event.target.dataset.section) {
      event.preventDefault(); focusChild(event.target.dataset.section);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const container = child ? submenuRef.current : menuRef.current;
      const buttons = [...container.querySelectorAll(child ? 'button:not(:disabled)' : ':scope > button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };

  return <div className="ipad-teaching-menu" onBlur={(event) => {
    if (!triggerRef.current?.contains(event.relatedTarget) && !menuRef.current?.contains(event.relatedTarget)) close();
  }}>
    <button type="button" className="action-button ipad-teaching-action" ref={triggerRef}
      aria-label={deviceLabel} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      disabled={disabled} onClick={() => { if (open) close(); else setOpen(true); }}
      onKeyDown={(event) => { if (event.key === 'ArrowDown' && !menuAnchorRef) { event.preventDefault(); setOpen(true); } }}>
      <DeviceIcon size={15}/><span><strong>{deviceLabel}</strong><small>{vision ? '配对码连接 · 空间示教' : '扫码连接 · AR 示教'}</small></span><ChevronDown size={12}/>
    </button>
    {open && createPortal(<div className="ipad-nav-menu" id={menuId} ref={menuRef} role="menu" aria-label={deviceLabel} tabIndex={-1} style={position} onKeyDown={keyDown}>
      <p className="ipad-nav-title"><DeviceIcon size={14}/>{deviceLabel}</p>
      {sections.map(({ id, label, detail, icon: Icon }) => <button key={id} type="button" role="menuitem" data-section={id}
        aria-label={label} aria-haspopup="menu" aria-expanded={section === id} aria-controls={section === id ? `${menuId}-${id}` : undefined}
        onPointerMove={(event) => { if (event.pointerType === 'mouse') setSection(id); }} onClick={() => focusChild(id)}>
        <Icon size={14}/><span><strong>{label}</strong><small>{detail}</small></span><ChevronRight size={13}/>
      </button>)}
      {section && <div className="ipad-nav-submenu" ref={submenuRef} id={`${menuId}-${section}`} role="menu"
        aria-label={sections.find((item) => item.id === section).label} style={submenuPosition}>
        {section === 'source' && <>
          <button type="button" role="menuitemradio" aria-label="查看独立示教" aria-checked={source === 'desktop'} onClick={() => run(() => onSourceChange('desktop'))}>
            <Bot size={14}/><span><strong>独立示教</strong><small>{desktopCount} 个任务</small></span>{source === 'desktop' && <Check size={14}/>}
          </button>
          {deviceCount > 0 ? <button type="button" role="menuitemradio" aria-label={`查看 ${deviceLabel} 示教`} aria-checked={source === device} onClick={() => run(() => onSourceChange(device))}>
            <DeviceIcon size={14}/><span><strong>{deviceLabel} 示教</strong><small>{deviceCount} 个任务</small></span>{source === device && <Check size={14}/>}
          </button> : <p className="ipad-nav-empty">暂无 {deviceLabel} 示教，接收该设备的示教结果后可在这里切换</p>}
        </>}
        {section === 'sync' && <>
          <button type="button" role="menuitem" aria-label={vision ? '配对 Vision Pro' : '扫码配对'} onClick={() => sync('pairing')}>
            {vision ? <Wifi size={14}/> : <QrCode size={14}/>}<span><strong>{vision ? '配对 Vision Pro' : '扫码配对'}</strong><small>{vision ? '搜索电脑后输入 4 位配对码' : '二维码 / 配对码'}</small></span>
          </button>
          {!vision && <button type="button" role="menuitem" aria-label="导入结果文件" onClick={() => sync('file')}><FileUp size={14}/><span><strong>导入结果文件</strong><small>AirDrop / Type-C</small></span></button>}
          {currentTicket && <button type="button" role="menuitem" aria-label={canReceive ? currentTicket.status === 'imported' ? '再次接收（去重）' : '接收示教结果' : '检查完成状态'} onClick={() => sync(canReceive ? 'receive' : 'status')}>
            {canReceive ? <ArrowDownToLine size={14}/> : <RefreshCw size={14}/>}<span><strong>{canReceive ? currentTicket.status === 'imported' ? '再次接收（去重）' : '接收示教结果' : '检查完成状态'}</strong>
              <small>{currentTicket.manifest.name}</small></span>
          </button>}
          {canRenew && <button type="button" role="menuitem" aria-label="更新配对码" onClick={() => sync('renew')}><RefreshCw size={14}/><span><strong>更新配对码</strong></span></button>}
          <button type="button" role="menuitem" aria-label="新建传输" onClick={() => sync('new')}><Plus size={14}/><span><strong>新建传输</strong></span></button>
        </>}
        {section === 'history' && (tickets.length ? tickets.map((item) => <button key={item.id} type="button" role="menuitem"
          data-transfer-id={item.id} onClick={() => sync('history', item.id)} title={item.manifest.name}>
          <History size={14}/><span><strong>{item.manifest.name}</strong><small>{transferStatus[item.status] || item.status} · {new Date(item.createdAt).toLocaleString()}</small></span>
          {item.status === 'completed' && <span className="ipad-nav-pending" aria-label="待接收"/>}
        </button>) : <p className="ipad-nav-empty">暂无传输任务</p>)}
      </div>}
    </div>, document.body)}
  </div>;
}
