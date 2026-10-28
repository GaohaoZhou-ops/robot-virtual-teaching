import { useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, Bot, Check, CheckCheck, CircleDot, Clock3, ListChecks, PanelRightClose, PanelRightOpen, ScanSearch, ShieldCheck, WifiOff } from 'lucide-react';
import { ALGORITHM_PHASES, CAMERA_NAMES, FINISHED_TASK_PHASES, TASK_PHASES, isRobotDetectionAlarm } from '../lib/robotTwinMonitor.js';
import { formatRobotDetectionConfidence, isSuspectedRobotDetection } from '../lib/robotTwinInspection.js';
import './TaskMonitorConsole.css';
import RobotTwinCameraPanel from './RobotTwinCameraPanel.jsx';
import RobotTwinCapturePanel from './RobotTwinCapturePanel.jsx';
import ViewerSelect from './ViewerSelect.jsx';

const duration = (milliseconds) => {
  const seconds = Math.floor(milliseconds / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, '0')).join(':');
};
const phaseLabel = (task) => task.navigationWaiting && task.phase === 'running' ? '导航停障'
  : TASK_PHASES[task.phase] || task.phase;
const STAGES = { navigation: '底盘导航', sequence: '动作执行', trajectory: '轨迹回放', capture: '图像采集',
  inspection: '算法处理', complete: '执行结束', parallel: '并行动作', 'route-switch': '路网切换',
  'recovery-failed': '恢复失败', joints: '关节动作', wait: '等待中' };

function AlgorithmResult({ item, selected, onSelect }) {
  const alarm = isRobotDetectionAlarm(item);
  const suspected = item.severity === 'suspected';
  const detections = item.detections || (item.labels || []).map((label) => ({ label }));
  const summary = !item.detectionCount ? '正常' : suspected ? `${item.detectionCount} 处疑似异常`
    : `${item.detectionCount} 处异常${item.suspectedCount ? `（含 ${item.suspectedCount} 处疑似）` : ''}`;
  const status = item.readError ? '读取失败' : !item.received ? '等待读取' : item.error ? '算法异常'
    : item.state === 'complete' ? summary
      : ALGORITHM_PHASES[item.state] || (['complete', 'failed', 'cancelled'].includes(item.jobState) ? '无算法结果' : '等待算法结果');
  const tone = alarm ? suspected ? 'suspected' : 'alarm' : item.readError || item.error || item.detectionCount ? 'warning' : item.state === 'complete' ? 'success' : 'muted';
  const context = [item.parkingName, item.pointName].filter(Boolean).join(' / ') || item.taskName || '任务采集结果';
  const detectionText = detections.map((box) => [isSuspectedRobotDetection(box) ? '疑似' : '', box.label,
    formatRobotDetectionConfidence(box)].filter(Boolean).join(' ')).join('；');
  const error = item.readError || item.error;
  const detail = [item.taskName, context, status, item.state === 'complete' ? detectionText : '',
    error ? `${error}${item.readError && item.received ? '；显示上次结果' : ''}` : ''].filter(Boolean).join('\n');
  const Row = onSelect ? 'button' : 'div';
  return (
    <li className={`task-monitor__result ${alarm ? 'is-alarm' : ''} ${alarm && suspected ? 'is-suspected' : ''} ${onSelect ? 'is-selectable' : ''} ${selected ? 'is-selected' : ''}`}
      data-result-key={item.key} data-result-alarm={alarm} data-result-selected={Boolean(selected)} data-severity={alarm ? suspected ? 'suspected' : 'defect' : 'clear'}>
      <Row className="task-monitor__result-row" type={onSelect ? 'button' : undefined} onClick={onSelect}
        aria-pressed={onSelect ? Boolean(selected) : undefined} title={detail}
        aria-label={onSelect ? `查看第 ${item.sequence} 条 ${CAMERA_NAMES[item.camera] || item.camera} 采集结果` : undefined}
        aria-description={onSelect ? detail : undefined}>
        <span className="task-monitor__sequence">{String(item.sequence).padStart(2, '0')}</span>
        <span className="task-monitor__result-body">
          <span className="task-monitor__result-heading"><strong>{CAMERA_NAMES[item.camera] || item.camera}</strong>
            {item.demo && <span className="task-monitor__badge">演示</span>}
            <span className={`task-monitor__result-state is-${tone}`}>{alarm ? <AlertTriangle size={11} /> : <CircleDot size={10} />}<span>{status}</span></span>
          </span>
          <span className="task-monitor__context">{context}</span>
          {error ? <span className="task-monitor__result-error">{error}{item.readError && item.received ? '；显示上次结果' : ''}</span>
            : item.state === 'complete' && detections.length > 0 && <span className="task-monitor__detections">
              {detections.map((box, index) => <span key={index} className={isSuspectedRobotDetection(box) ? 'is-suspected' : ''}>
                {index > 0 ? ' · ' : ''}{isSuspectedRobotDetection(box) ? '疑似 ' : ''}{box.label}
                {formatRobotDetectionConfidence(box) ? ` ${formatRobotDetectionConfidence(box)}` : ''}
              </span>)}
              {item.detectionCount > detections.length && <span> · 另有 {item.detectionCount - detections.length} 处异常</span>}
            </span>}
        </span>
        <span className="task-monitor__selected">{selected && <Check size={13} aria-label="查看中" />}</span>
      </Row>
    </li>
  );
}

export default function TaskMonitorConsole({ twin, collapsed, onCollapsedChange }) {
  const algorithmSection = useRef(null);
  const monitor = twin.monitor, task = monitor?.task, live = twin.monitorPhase === 'live';
  const [selection, setSelection] = useState(null);
  // A manually chosen capture stays on screen while fresh results arrive.
  // Keep its last metadata if it leaves the recent list or the robot goes idle.
  const selected = selection;
  const capture = selected ? twin.captureCache.captures.get(selected.capture.id) || selected.capture
    : monitor?.latestCapture || twin.captureCache.latestReady();
  useEffect(() => {
    if (selected && capture && selected.capture !== capture) setSelection({ ...selected, capture });
  }, [task?.id, selection, capture]);
  const selectResult = (item, detail, reveal = true) => {
    setSelection({ taskId: detail.runId || task?.id, key: item.key, side: item.camera, capture: detail });
    if (reveal) requestAnimationFrame(() => algorithmSection.current?.querySelector('.robot-twin-capture')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };
  const alarms = (monitor?.results || []).filter(isRobotDetectionAlarm);
  const retainedAlarms = Object.entries(monitor?.latestCapture?.sides || {}).filter(([side, info]) => info.abnormal
    && !alarms.some((item) => item.captureId === monitor.latestCapture.id && item.camera === side)).map(([, info]) => info);
  const alarmRecords = [...alarms, ...retainedAlarms], alarmCount = alarmRecords.length;
  const detectionCount = alarmRecords.reduce((sum, item) => sum + item.detectionCount, 0);
  const suspectedCount = alarmRecords.reduce((sum, item) => sum + (item.suspectedCount || 0), 0);
  const onlySuspected = alarmCount > 0 && alarmRecords.every((item) => item.severity === 'suspected');
  const finished = task && FINISHED_TASK_PHASES.has(task.phase);
  const taskName = task?.taskName || task?.tasks?.find((item) => item.index === task.taskIndex)?.name || task?.tasks?.[0]?.name || '机器人任务';
  const consumed = task ? Math.min(task.totalPoints, task.completedPoints + task.skippedPoints) : 0;
  const percent = task?.totalPoints ? Math.floor(consumed / task.totalPoints * 100) : 0;
  const algorithmState = task?.algorithmMode === 'skip' ? 'skipped' : task?.algorithmState;
  return (
    <aside className={`inspector-panel task-monitor ${alarmCount ? 'has-alarm' : ''} ${onlySuspected ? 'is-suspected' : ''} ${collapsed ? 'is-collapsed' : ''}`}
      aria-label="任务监控台" data-panel-mode="task-monitor" data-robot-id={twin.selectedId} data-collapsed={String(collapsed)} data-monitor-phase={twin.monitorPhase}>
      <div id="task-monitor-content" className="inspector-panel__content task-monitor__content"
        aria-hidden={collapsed} inert={collapsed ? '' : undefined}>
        <div className="inspector-heading"><div><span className="eyebrow">TASK MONITOR</span><h2>任务监控台</h2></div></div>
        <div className="task-monitor__robot">
          <i className="task-monitor__robot-color" style={{ backgroundColor: twin.selectedRobot?.color }} aria-hidden="true" />
          <label htmlFor="task-monitor-robot">当前机器人</label>
          <ViewerSelect id="task-monitor-robot" label="当前机器人" ariaLabel="当前监控机器人" icon={Bot}
            value={twin.selectedId || ''} onChange={twin.selectRobot} isActive={!collapsed} placeholder="暂无已连接机器人"
            options={twin.robots.filter((robot) => robot.active).map((robot) => ({ value: robot.id, color: robot.color,
              label: `${robot.name}${robot.phase === 'stale' ? ' · 数据暂不可用' : robot.phase === 'connecting' ? ' · 连接中' : ''}` }))} />
        </div>
        <div className="task-monitor__connection">
          <span className={`task-monitor__connection-state ${live ? 'is-live' : ''}`} role="status">
            {live ? <Activity size={13} /> : twin.monitorPhase === 'stale' ? <WifiOff size={13} /> : <CircleDot size={13} />}
            {live ? '实时更新' : twin.monitorPhase === 'stale' ? '更新中断' : '正在读取任务'}
          </span>
          <span className="task-monitor__readonly"><ShieldCheck size={12} />只读监控</span>
          <span className="task-monitor__address" title={twin.address}>{twin.address?.replace(/^https?:\/\//, '')}</span>
          <time>{twin.monitorReceivedAt ? new Date(twin.monitorReceivedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</time>
        </div>
        <div className="task-monitor__alarm-slot">{alarmCount > 0 && <div className={`task-monitor__alarm ${onlySuspected ? 'is-suspected' : ''}`} role="alert"
          data-severity={onlySuspected ? 'suspected' : 'defect'}>
          <AlertTriangle size={19} /><div><strong>{onlySuspected ? '疑似异常' : '检测异常'} · {detectionCount} 处</strong>
            <span>{alarmCount} 条采集结果需关注{suspectedCount > 0 && !onlySuspected ? ` · 含 ${suspectedCount} 处疑似` : ''}{!live || !monitor.resultsFresh ? ' · 上次读取记录' : ''}</span></div>
          <button type="button" onClick={() => (algorithmSection.current?.querySelector('.task-monitor__result.is-alarm:not(.is-suspected)')
            || algorithmSection.current?.querySelector('.task-monitor__result.is-alarm') || algorithmSection.current)?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>查看</button>
        </div>}</div>
        <div className="task-monitor__scroll">
          <RobotTwinCameraPanel twin={twin} collapsed={collapsed} />
          {twin.monitorError && <p className="task-monitor__warning" role="status">{twin.monitorError}{monitor ? '；以下为上次读取记录。' : ''}</p>}
          <section className="task-monitor__section" aria-label="机器人任务状态">
            <div className="task-monitor__section-title"><ListChecks size={14} /><h3>{finished ? '最近任务' : '当前任务'}</h3>
              {task && <span className={`task-monitor__badge ${finished ? '' : 'is-active'}`}>{phaseLabel(task)}</span>}
            </div>
            {task ? <>
              <h4 className="task-monitor__task-name">{taskName}</h4>
              <p className="task-monitor__run-id" title={task.id}>RUN / {task.id}</p>
              {task.message && <p className="task-monitor__message">{task.message}</p>}
              {task.error && <p className="task-monitor__warning">{task.error}</p>}
              <dl className="task-monitor__details">
                {task.stage && <div><dt>执行阶段</dt><dd>{STAGES[task.stage] || task.stage}</dd></div>}
                <div><dt>停车点</dt><dd>{task.parkingName || '—'}</dd></div>
                <div><dt>当前步骤</dt><dd>{task.pointName || '—'}</dd></div>
              </dl>
              {task.totalPoints > 0 && <div className="task-monitor__progress">
                <div><span>步骤进度</span><strong>{percent}<small>%</small></strong></div>
                <progress aria-label="任务步骤进度" value={consumed} max={task.totalPoints} />
                <p>完成 {task.completedPoints} / {task.totalPoints} 步{task.skippedPoints > 0 ? ` · 跳过 ${task.skippedPoints} 步` : ''}</p>
              </div>}
              <div className="task-monitor__metrics"><span><Clock3 size={12} />{duration(task.elapsedMs)}</span><span><ScanSearch size={12} />{task.completedCaptures} 次采集</span></div>
              {task.tasks.length > 1 && <details className="task-monitor__queue"><summary>本次任务序列 · {task.tasks.length} 项</summary>
                <ol>{task.tasks.map((item) => <li key={item.index} aria-current={!finished && item.index === task.taskIndex ? 'step' : undefined}>
                  <span>{String(item.index + 1).padStart(2, '0')}</span>{item.name}
                </li>)}</ol>
              </details>}
            </> : <div className="task-monitor__empty"><ListChecks size={26} />
              <strong>{monitor ? '当前没有执行中的任务' : twin.monitorPhase === 'stale' ? '任务状态暂不可用' : '正在获取任务状态…'}</strong>
              <p>{monitor?.navigationPhase && monitor.navigationPhase !== 'idle' ? `底盘导航：${TASK_PHASES[monitor.navigationPhase] || monitor.navigationPhase}` : '机器人执行任务后，状态将在这里自动更新。'}</p>
            </div>}
          </section>
          <section ref={algorithmSection} className="task-monitor__section" aria-label="算法结果">
            <div className="task-monitor__section-title"><ScanSearch size={14} /><h3>算法结果</h3>
              {algorithmState && <span className="task-monitor__badge">{ALGORITHM_PHASES[algorithmState] || algorithmState}</span>}
            </div>
            {monitor?.resultsError && <p className="task-monitor__warning" role="status">结果读取失败：{monitor.resultsError}</p>}
            <RobotTwinCapturePanel twin={twin} capture={capture} selectedSide={selected?.side}
              onSelect={(item, detail) => selectResult(item, detail, false)}
              onLatest={selected ? () => setSelection(null) : undefined} collapsed={collapsed} />
            {monitor?.results.length > 0 ? <>
              <p className="task-monitor__result-count">{monitor.resultTotal > monitor.results.length ? `最近 ${monitor.results.length} 条 / 共 ${monitor.resultTotal} 条` : `${monitor.results.length} 条采集记录`} · 最旧在前</p>
              <ul className="task-monitor__results" role="list" aria-label="算法结果列表" tabIndex={0} onKeyDown={(event) => event.stopPropagation()}>
              {[...monitor.results].reverse().map((item) => {
                const detail = !item.demo && ['left', 'right'].includes(item.camera)
                  ? monitor.captures?.find((entry) => entry.id === item.captureId) : null;
                return <AlgorithmResult key={`${task?.id}:${item.key}`} item={item} selected={selected?.key === item.key}
                  onSelect={detail ? () => selectResult(item, detail) : undefined} />;
              })}</ul>
            </> : !capture && <div className="task-monitor__empty"><CheckCheck size={26} />
              <strong>{algorithmState === 'skipped' ? '本次任务未执行算法' : monitor?.resultsError ? '结果暂不可用' : task ? '暂无算法结果' : '等待任务采集'}</strong>
              <p>{algorithmState === 'skipped' ? '机器人已将本次算法设为跳过。' : '采集与算法输出后，将自动显示检测结果。'}</p>
            </div>}
          </section>
        </div>
      </div>
      <button type="button" className="inspector-collapse-toggle" aria-label={`${collapsed ? '展开' : '折叠'}任务监控台`}
        aria-expanded={!collapsed} aria-controls="task-monitor-content" onClick={() => onCollapsedChange?.(!collapsed)}>
        {collapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={13} />}<span>{collapsed ? '展开监控台' : '折叠'}</span>
      </button>
    </aside>
  );
}
