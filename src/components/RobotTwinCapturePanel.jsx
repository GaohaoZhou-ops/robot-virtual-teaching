import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Camera, Check, CheckCheck, Cloud, Image, ListChecks, Maximize2, RefreshCw, X } from 'lucide-react';
import { useRobotTwinCaptureHistory } from '../hooks/useRobotTwinCaptureHistory.js';
import { ALGORITHM_PHASES, TASK_PHASES } from '../lib/robotTwinMonitor.js';
import RobotTwinPointCloud from './RobotTwinPointCloud.jsx';
import RobotTwinCaptureImage from './RobotTwinCaptureImage.jsx';
import './RobotTwinCapturePanel.css';

async function readCaptureAsset(read, id, side, kind, signal) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await read(id, side, kind, signal); }
    catch (error) {
      // Rapid switching can race server-side cancellation of the previous pair.
      // Only retry this bounded, local concurrency response, never authentication.
      if (error.code !== 'ROBOT_CAPTURE_BUSY' || attempt >= 3) throw error;
      await new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const cancel = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 150 * (attempt + 1));
        signal.addEventListener('abort', cancel, { once: true });
      });
    }
  }
}

async function decodeCloud(blob, signal) {
  const buffer = await blob.arrayBuffer(); signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/robotTwinPointCloud.worker.js', import.meta.url), { type: 'module' });
    const finish = (error, data) => {
      clearTimeout(timeout); signal.removeEventListener('abort', cancel); worker.terminate();
      error ? reject(error) : resolve(data);
    };
    const cancel = () => finish(new Error('点云加载已取消'));
    const timeout = setTimeout(() => finish(new Error('点云解析超时，请重试')), 30_000);
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data);
    worker.onerror = () => finish(new Error('点云解析失败，请重试'));
    worker.postMessage(buffer, [buffer]);
  });
}

function useAsset(read, id, side, kind, available, enabled) {
  const key = `${id}/${side}/${kind}`;
  const [state, setState] = useState({ key: '', phase: 'idle' }), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!available) { setState({ key, phase: 'missing' }); return undefined; }
    if (!enabled) {
      if (state.key !== key || state.phase === 'loading') setState({ key, phase: 'idle' });
      return undefined;
    }
    if (state.key === key && ['ready', 'error'].includes(state.phase)) return undefined;
    const controller = new AbortController(); let active = true;
    setState({ key, phase: 'loading' });
    void (async () => {
      try {
        const { blob } = await readCaptureAsset(read, id, side, kind, controller.signal);
        if (!active) return;
        const cloud = kind === 'xyzbin' ? await decodeCloud(blob, controller.signal) : null;
        if (!active) return;
        setState({ key, phase: 'ready', ...(cloud ? { cloud } : { url: URL.createObjectURL(blob) }) });
      } catch (error) { if (active) setState({ key, phase: 'error', error: error.message }); }
    })();
    return () => { active = false; controller.abort(); };
  }, [read, key, available, enabled, attempt]);
  useEffect(() => () => { if (state.url) URL.revokeObjectURL(state.url); }, [state.url]);
  return { ...(state.key === key ? state : { phase: 'idle' }),
    retry: () => { setState({ key, phase: 'idle' }); setAttempt((value) => value + 1); },
    invalidImage: () => setState({ key, phase: 'error', error: '图像解码失败，请重试' }) };
}

function ViewButtons({ mode, setMode }) {
  return <div className="robot-twin-capture__tabs" role="group" aria-label="采集结果显示方式">
    <button type="button" aria-pressed={mode === 'png'} onClick={() => setMode('png')}><Image size={13} />图像</button>
    <button type="button" aria-pressed={mode === 'xyzbin'} onClick={() => setMode('xyzbin')}><Cloud size={13} />点云</button>
  </div>;
}

function CaptureViews({ capture, mode, assets, selectedSide }) {
  return <div className="robot-twin-capture__pair">
    {['left', 'right'].map((side) => {
      const label = `${side === 'left' ? '左' : '右'} Zivid`, info = capture.sides[side], asset = assets[side][mode];
      const suspected = info.severity === 'suspected';
      return <figure key={side} className={`robot-twin-capture__side ${info.abnormal ? 'is-alarm' : ''} ${info.abnormal && suspected ? 'is-suspected' : ''} ${selectedSide === side ? 'is-selected' : ''}`}
        data-capture-side={side} data-severity={info.abnormal ? suspected ? 'suspected' : 'defect' : 'clear'}>
        <figcaption><Camera size={13} /><strong>{label}</strong>{info.abnormal && <span><AlertTriangle size={12} />{suspected ? '疑似异常' : '检测异常'}</span>}</figcaption>
        {asset.phase === 'ready' ? mode === 'png' ? <RobotTwinCaptureImage asset={asset} inspection={info} label={label} />
          : <RobotTwinPointCloud cloud={asset.cloud} inspection={info} label={label} />
          : <div className="robot-twin-capture__empty" role="status">
            {mode === 'png' ? <Image size={23} /> : <Cloud size={23} />}
            <span>{asset.phase === 'error' ? asset.error : asset.phase === 'missing'
              ? info.error || (info.pending ? '等待本次采集文件保存…' : `本次未保存${mode === 'png' ? '图像' : '点云'}`)
              : `正在读取${mode === 'png' ? '拍摄图像' : '点云'}…`}</span>
            {asset.phase === 'error' && <button type="button" onClick={asset.retry}><RefreshCw size={12} />重试</button>}
          </div>}
      </figure>;
    })}
  </div>;
}

function CompletedResults({ history, monitor, capture, selectedSide, onSelect }) {
  const entries = new Map((history.results || []).map((item) => [item.key, item]));
  const captures = new Map((history.captures || []).map((item) => [item.id, item]));
  if (monitor?.task?.id === capture.runId) {
    for (const item of monitor.results || []) if (item.received) entries.set(item.key, item);
    for (const item of monitor.captures || []) {
      if (!captures.has(item.id) || (monitor.results || []).some((result) => result.captureId === item.id && result.received)) captures.set(item.id, item);
    }
  }
  captures.set(capture.id, capture);
  const completed = [...entries.values()].filter((item) => item.received && !item.demo && item.state === 'complete'
    && ['left', 'right'].includes(item.camera) && captures.has(item.captureId)).sort((a, b) => b.sequence - a.sequence || b.key.localeCompare(a.key));
  return <aside className="robot-twin-capture-history" aria-label="已完成算法列表" aria-busy={Boolean(history.loading)}>
    <div className="robot-twin-capture-history__heading"><ListChecks size={15} /><h3>已完成算法</h3><span>{completed.length}</span></div>
    <p className="robot-twin-capture-history__hint">双 Zivid · 最新在前</p>
    <div className="robot-twin-capture-history__scroll">
      <ul>{completed.map((item) => {
        const selected = item.captureId === capture.id && item.camera === (selectedSide || 'right');
        const alarm = item.detectionCount > 0, suspected = item.severity === 'suspected';
        const summary = !alarm ? '未检测到异常' : suspected ? `${item.detectionCount} 处疑似异常`
          : `${item.detectionCount} 处异常${item.suspectedCount ? ` · 含 ${item.suspectedCount} 处疑似` : ''}`;
        const context = [item.parkingName || item.taskName, item.pointName].filter(Boolean).join(' / ') || '任务采集结果';
        return <li key={item.key}><button type="button" className="robot-twin-capture-history__item" aria-pressed={selected}
          aria-label={`查看第 ${item.sequence} 条 ${item.camera === 'left' ? '左' : '右'} Zivid 采集结果`}
          data-history-key={item.key} data-severity={alarm ? suspected ? 'suspected' : 'defect' : 'clear'}
          onClick={() => onSelect(item, captures.get(item.captureId))}>
          <span className="robot-twin-capture-history__title"><span>{String(item.sequence).padStart(2, '0')}</span>
            <strong>{item.camera === 'left' ? '左' : '右'} Zivid</strong>{selected && <Check size={13} aria-label="查看中" />}</span>
          <span className="robot-twin-capture-history__context" title={context}>{context}</span>
          <span className="robot-twin-capture-history__status">{alarm ? <AlertTriangle size={12} /> : <CheckCheck size={12} />}{summary}</span>
          {alarm && <span className="robot-twin-capture-history__labels" title={(item.labels || []).join('、')}>{[...new Set(item.labels || [])].join('、')}</span>}
        </button></li>;
      })}</ul>
      {!completed.length && <p className="robot-twin-capture-history__empty">{history.loading ? '正在读取已完成结果…' : '暂无已完成的 Zivid 算法结果'}</p>}
      {history.loading && completed.length > 0 && <p className="robot-twin-capture-history__hint" role="status">正在读取更早的结果…</p>}
      {history.error && <div className="robot-twin-capture-history__error" role="status"><span>列表未完整读取：{history.error}</span>
        <button type="button" onClick={history.retry}><RefreshCw size={12} />重新读取</button></div>}
    </div>
  </aside>;
}

function CaptureTaskInfo({ twin, capture, selectedSide }) {
  const task = capture.runId && twin.monitor?.task?.id === capture.runId ? twin.monitor.task : null;
  const stale = twin.monitorPhase !== 'live';
  const created = capture.createdAt ? new Date(capture.createdAt) : null;
  const timestamp = created && Number.isFinite(created.getTime())
    ? created.toLocaleString('zh-CN', { hour12: false }) : '未提供采集时间';
  const consumed = task ? Math.min(task.totalPoints, task.completedPoints + task.skippedPoints) : 0;
  const phase = task ? task.navigationWaiting && task.phase === 'running' ? '导航停障'
    : TASK_PHASES[task.phase] || '状态未知' : '历史采集';
  return <section className="robot-twin-capture-info" aria-label="采集任务信息" data-capture-id={capture.id}>
    <div className="robot-twin-capture-info__heading"><span><ListChecks size={14} />采集任务</span>
      {twin.selectedRobot?.name && <span className="robot-twin-capture-info__robot">
        <i style={{ backgroundColor: twin.selectedRobot.color }} aria-hidden="true" />{twin.selectedRobot.name}</span>}</div>
    <div className="robot-twin-capture-info__task"><h3>{capture.taskName || '未提供任务名称'}</h3>
      <span className="robot-twin-capture-info__phase">{task ? `所属作业 · ${phase}` : phase}{task && stale ? ' · 上次读取' : ''}</span></div>
    <dl className="robot-twin-capture-info__fields">
      <div><dt>停车点</dt><dd>{capture.parkingName || '—'}</dd></div>
      <div><dt>采集动作</dt><dd>{capture.pointName || '—'}</dd></div>
      <div><dt>采集时间</dt><dd><time dateTime={created && Number.isFinite(created.getTime()) ? capture.createdAt : undefined}>{timestamp}</time></dd></div>
    </dl>
    {task?.totalPoints > 0 && <div className="robot-twin-capture-info__progress">
      <span>作业当前进度{stale ? ' · 上次读取' : ''}</span>
      <progress aria-label="采集所属任务当前进度" value={consumed} max={task.totalPoints} />
      <span>完成 <strong>{task.completedPoints} / {task.totalPoints}</strong> 步{task.skippedPoints > 0 ? ` · 跳过 ${task.skippedPoints} 步` : ''}</span>
    </div>}
    <div className="robot-twin-capture-info__results">
      {['left', 'right'].map((side) => {
        const info = capture.sides[side], complete = info.state === 'complete';
        const tone = info.abnormal ? info.severity === 'suspected' ? 'suspected' : 'defect'
          : info.error || info.state === 'failed' ? 'warning' : complete ? 'clear' : 'pending';
        const status = info.abnormal ? `${info.detectionCount} 处${tone === 'suspected' ? '疑似' : ''}异常`
          : info.error ? '读取异常' : complete ? '未检测到异常' : ALGORITHM_PHASES[info.state] || '等待算法结果';
        const labels = [...new Set((info.boxes || []).map((box) => box.label).filter(Boolean))];
        const detail = info.error || (complete ? labels.join('、') || '本次采集算法已完成'
          : info.state === 'skipped' ? '本次采集未执行算法' : info.state === 'failed' ? '本次算法未能完成' : '结果就绪后自动更新');
        return <div key={side} className="robot-twin-capture-info__result" data-side={side} data-severity={tone}
          data-selected={selectedSide === side}>
          <div><Camera size={13} /><strong>{side === 'left' ? '左' : '右'} Zivid</strong>
            <span>{info.abnormal ? <AlertTriangle size={12} /> : complete && <CheckCheck size={12} />}{status}</span></div>
          <p>{detail}{info.abnormal && tone === 'defect' && info.suspectedCount > 0 ? ` · 含 ${info.suspectedCount} 处疑似` : ''}</p>
        </div>;
      })}
    </div>
    {capture.error && <p className="robot-twin-capture-info__warning" role="status">采集信息读取失败：{capture.error}</p>}
  </section>;
}

function CaptureDialog({ twin, capture, mode, setMode, assets, selectedSide, onSelect, onLatest, visible, close }) {
  const ref = useRef(null), closeButton = useRef(null), title = useId();
  const history = useRobotTwinCaptureHistory(twin.readCaptureHistory, capture.runId || twin.monitor?.task?.id, visible);
  useEffect(() => {
    const previous = document.activeElement, dialog = ref.current; dialog.showModal(); closeButton.current?.focus();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus?.({ preventScroll: true }); };
  }, []);
  return createPortal(<dialog ref={ref} className="robot-twin-capture-dialog" aria-labelledby={title} data-capture-id={capture.id}
    onCancel={(event) => { event.preventDefault(); close(); }} onKeyDown={(event) => event.stopPropagation()}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    }}>
    <header><Camera size={17} /><h2 id={title}>双 Zivid 采集结果</h2>
      <button ref={closeButton} type="button" className="robot-twin-capture__icon" aria-label="关闭采集结果大窗" onClick={close}><X size={18} /></button></header>
    <div className="robot-twin-capture-dialog__body">
      <CompletedResults history={history} monitor={twin.monitor} capture={capture} selectedSide={selectedSide} onSelect={onSelect} />
      <div className="robot-twin-capture-dialog__viewer">
        <div className="robot-twin-capture-dialog__toolbar"><ViewButtons mode={mode} setMode={setMode} />
          {onLatest && <button type="button" className="robot-twin-capture__latest" onClick={onLatest}><RefreshCw size={12} />回到最新</button>}</div>
        <CaptureViews capture={capture} mode={mode} assets={assets} selectedSide={selectedSide} />
        <CaptureTaskInfo twin={twin} capture={capture} selectedSide={selectedSide} />
      </div>
    </div>
  </dialog>, document.body);
}

export default function RobotTwinCapturePanel({ twin, capture, selectedSide, onSelect, onLatest, collapsed }) {
  const [mode, setMode] = useState('png'), [expanded, setExpanded] = useState(false), [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const changed = () => setVisible(!document.hidden); document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => { if (collapsed || !capture) setExpanded(false); }, [collapsed, capture?.id]);
  const enabled = Boolean(capture && !collapsed && visible);
  const leftImage = useAsset(twin.readCapture, capture?.id, 'left', 'png', capture?.sides.left.image, enabled && mode === 'png');
  const rightImage = useAsset(twin.readCapture, capture?.id, 'right', 'png', capture?.sides.right.image, enabled && mode === 'png');
  const leftCloud = useAsset(twin.readCapture, capture?.id, 'left', 'xyzbin', capture?.sides.left.cloud, enabled && mode === 'xyzbin');
  const rightCloud = useAsset(twin.readCapture, capture?.id, 'right', 'xyzbin', capture?.sides.right.cloud, enabled && mode === 'xyzbin');
  if (!capture) return null;
  const assets = { left: { png: leftImage, xyzbin: leftCloud }, right: { png: rightImage, xyzbin: rightCloud } };
  return <section className="robot-twin-capture" aria-label="Zivid 采集结果" data-capture-id={capture.id}
    data-capture-mode={onLatest ? 'selected' : 'latest'} data-selected-side={selectedSide || ''}>
    <div className="robot-twin-capture__heading"><span>{onLatest ? '正在查看已选采集' : '最近一次 Zivid 采集'}</span>
      <div className="robot-twin-capture__actions">
        {onLatest && <button type="button" className="robot-twin-capture__latest" onClick={onLatest}><RefreshCw size={11} />回到最新</button>}
        <button type="button" className="robot-twin-capture__icon" aria-label="放大双 Zivid 采集结果" onClick={() => setExpanded(true)}><Maximize2 size={13} /></button>
      </div></div>
    <ViewButtons mode={mode} setMode={setMode} />
    <p className="robot-twin-capture__context">{[capture.taskName, capture.parkingName, capture.pointName].filter(Boolean).join(' / ')}</p>
    {capture.error && <p className="task-monitor__warning">{capture.error}</p>}
    {expanded ? <button type="button" className="robot-twin-capture__in-dialog" onClick={() => setExpanded(false)}>正在大窗中查看 · 返回小窗</button>
      : <CaptureViews capture={capture} mode={mode} assets={assets} selectedSide={selectedSide} />}
    {expanded && <CaptureDialog twin={twin} capture={capture} mode={mode} setMode={setMode} assets={assets} selectedSide={selectedSide}
      onSelect={onSelect} onLatest={onLatest} visible={visible} close={() => setExpanded(false)} />}
  </section>;
}
