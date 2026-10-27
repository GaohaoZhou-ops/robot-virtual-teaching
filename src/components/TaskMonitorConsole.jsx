import { Activity, CheckCheck, CircleDot, Clock3, Code2, ListChecks, PanelRightClose, PanelRightOpen, ScanSearch, ShieldCheck, WifiOff } from 'lucide-react';
import { ALGORITHM_PHASES, CAMERA_NAMES, FINISHED_TASK_PHASES, TASK_PHASES } from '../lib/robotTwinMonitor.js';
import './TaskMonitorConsole.css';

const duration = (milliseconds) => {
  const seconds = Math.floor(milliseconds / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, '0')).join(':');
};
const phaseLabel = (task) => task.navigationWaiting && task.phase === 'running' ? '导航停障'
  : TASK_PHASES[task.phase] || task.phase;
const STAGES = { navigation: '底盘导航', sequence: '动作执行', trajectory: '轨迹回放', capture: '图像采集',
  inspection: '算法处理', complete: '执行结束', parallel: '并行动作', 'route-switch': '路网切换',
  'recovery-failed': '恢复失败', joints: '关节动作', wait: '等待中' };

function AlgorithmResult({ item }) {
  const status = item.readError ? '读取失败' : !item.received ? '等待读取' : item.error ? '算法异常'
    : item.state === 'complete' ? (item.detectionCount ? `检测到 ${item.detectionCount} 处异常` : '未检测到异常')
      : ALGORITHM_PHASES[item.state] || (['complete', 'failed', 'cancelled'].includes(item.jobState) ? '无算法结果' : '等待算法结果');
  const tone = item.readError || item.error || item.detectionCount ? 'warning' : item.state === 'complete' ? 'success' : 'muted';
  return (
    <article className="task-monitor__result" data-result-key={item.key}>
      <header><span className="task-monitor__sequence">{String(item.sequence).padStart(2, '0')}</span>
        <strong>{CAMERA_NAMES[item.camera] || item.camera}</strong>{item.demo && <span className="task-monitor__badge">演示结果</span>}</header>
      <p className="task-monitor__context">{[item.taskName, item.parkingName, item.pointName].filter(Boolean).join(' / ') || '任务采集结果'}</p>
      <p className={`task-monitor__result-state is-${tone}`}><CircleDot size={12} />{status}</p>
      {(item.readError || item.error) && <p className="task-monitor__warning">{item.readError || item.error}{item.readError && item.output ? '；显示上次结果' : ''}</p>}
      {item.state === 'complete' && item.labels.length > 0 && <ul className="task-monitor__detections">
        {item.labels.map((label, index) => <li key={index}><span>{String(index + 1).padStart(2, '0')}</span>{label}</li>)}
        {item.detectionCount > item.labels.length && <li>更多检测项请查看原始输出</li>}
      </ul>}
      {item.output && <details className="task-monitor__output"><summary><Code2 size={12} />原始算法输出</summary>
        <pre>{item.output}</pre>{item.outputTruncated && <p>输出较长，仅展示前 32 KB。</p>}
      </details>}
    </article>
  );
}

export default function TaskMonitorConsole({ twin, collapsed, onCollapsedChange }) {
  const monitor = twin.monitor, task = monitor?.task, live = twin.monitorPhase === 'live';
  const finished = task && FINISHED_TASK_PHASES.has(task.phase);
  const taskName = task?.taskName || task?.tasks?.find((item) => item.index === task.taskIndex)?.name || task?.tasks?.[0]?.name || '机器人任务';
  const consumed = task ? Math.min(task.totalPoints, task.completedPoints + task.skippedPoints) : 0;
  const percent = task?.totalPoints ? Math.floor(consumed / task.totalPoints * 100) : 0;
  const algorithmState = task?.algorithmMode === 'skip' ? 'skipped' : task?.algorithmState;
  return (
    <aside className={`inspector-panel task-monitor ${collapsed ? 'is-collapsed' : ''}`}
      aria-label="任务监控台" data-panel-mode="task-monitor" data-collapsed={String(collapsed)} data-monitor-phase={twin.monitorPhase}>
      <div id="task-monitor-content" className="inspector-panel__content task-monitor__content"
        aria-hidden={collapsed} inert={collapsed ? '' : undefined}>
        <div className="inspector-heading"><div><span className="eyebrow">TASK MONITOR</span><h2>任务监控台</h2></div></div>
        <div className="task-monitor__connection">
          <span className={`task-monitor__connection-state ${live ? 'is-live' : ''}`} role="status">
            {live ? <Activity size={13} /> : twin.monitorPhase === 'stale' ? <WifiOff size={13} /> : <CircleDot size={13} />}
            {live ? '实时更新' : twin.monitorPhase === 'stale' ? '更新中断' : '正在读取任务'}
          </span>
          <span className="task-monitor__readonly"><ShieldCheck size={12} />只读监控</span>
          <span className="task-monitor__address" title={twin.address}>{twin.address?.replace(/^https?:\/\//, '')}</span>
          <time>{twin.monitorReceivedAt ? new Date(twin.monitorReceivedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</time>
        </div>
        <div className="task-monitor__scroll">
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
          <section className="task-monitor__section" aria-label="算法结果">
            <div className="task-monitor__section-title"><ScanSearch size={14} /><h3>算法结果</h3>
              {algorithmState && <span className="task-monitor__badge">{ALGORITHM_PHASES[algorithmState] || algorithmState}</span>}
            </div>
            {monitor?.resultsError && <p className="task-monitor__warning" role="status">结果读取失败：{monitor.resultsError}</p>}
            {monitor?.results.length > 0 ? <>
              <p className="task-monitor__result-count">{monitor.resultTotal > monitor.results.length ? `最近 ${monitor.results.length} 条 / 共 ${monitor.resultTotal} 条` : `${monitor.results.length} 条采集记录`} · 最新在前</p>
              {monitor.results.map((item) => <AlgorithmResult key={`${task.id}:${item.key}`} item={item} />)}
            </> : <div className="task-monitor__empty"><CheckCheck size={26} />
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
