import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Check, Download, Play, Save, X } from 'lucide-react';
import { DEFAULT_MOBILE_SOLVE_OPTIONS, MOBILE_SOLVE_VERSION, mobileReportSolveOptions, validateMobileSolveOptions } from '../lib/mobileTeachingSolver.js';
import { mobileSolutionMapPose } from '../lib/mobileTeachingParking.js';
import { downloadJson } from '../lib/io.js';
import './MobileTeachingSolveDialog.css';

const sideName = (side) => side === 'left' ? '左臂' : '右臂';
const groups = [['positionTolerance', ['x', 'y', 'z'], '位置容差', 'cm', 100], ['rotationTolerance', ['roll', 'pitch', 'yaw'], '角度容差', '°', 1]];
const format = (value, scale = 1) => Number.isFinite(value) ? (value * scale).toFixed(2) : '—';

export default function MobileTeachingSolveDialog({ task, robot, robotPose, ready, initialOptions, initialSampleId, running, computationStatus, computationError, onClose, onCalculate, onApply, onSave }) {
  const [options, setOptions] = useState(() => {
    const initial = { ...DEFAULT_MOBILE_SOLVE_OPTIONS, ...(initialOptions || task.mobileSolve?.options),
      ...(!initialOptions && task.mobileSolve?.version === 1 ? { parkingMode: 'auto', checkCollisions: true } : {}),
      ...(!initialOptions && task.mobileSolve?.version < MOBILE_SOLVE_VERSION ? { allowTorsoHeight: true } : {}) };
    if (initial.allowTorsoHeight) initial.lockChestVertical = true;
    return structuredClone(initial);
  });
  const report = task.mobileSolve || null;
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(0);
  const [page, setPage] = useState(0);
  const panel = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    return () => { previous?.focus?.(); };
  }, []);
  useEffect(() => {
    const index = Math.max(0, report?.rows.findIndex((item) => item.sampleId === initialSampleId) ?? 0);
    setSelected(index); setPage(Math.floor(index / 50));
  }, [report?.computedAt, initialSampleId]);
  let validation = '';
  try { validateMobileSolveOptions(options); } catch (cause) { validation = cause.message; }
  const update = (patch) => { setOptions((current) => ({ ...current, ...patch })); setDirty(true); setError(''); };
  const calculate = (event) => {
    event.preventDefault();
    if (validation || !ready) return;
    setError('');
    try { onCalculate(task.id, options); } catch (cause) { setError(cause.message); }
  };
  const act = async (callback) => {
    setError('');
    try { await callback(); } catch (cause) { setError(cause.message); }
  };
  const row = report?.rows[selected];
  const storedOptions = report && mobileReportSolveOptions(report);
  const optionsChanged = dirty || (report && (validation || JSON.stringify(validateMobileSolveOptions(options)) !== JSON.stringify(validateMobileSolveOptions(storedOptions))));
  const usable = report && !running && !optionsChanged && ready;
  const exportReport = () => downloadJson({
    format: 'atlas-mobile-solve-report/1', exportedAt: new Date().toISOString(), report,
    task: { id: task.id, name: task.name, coordinateFrame: task.coordinateFrame, map: task.map,
      mobileTransform: task.mobileTransform, mobileCapture: task.mobileCapture },
    robot, currentRobotPose: robotPose,
  }, `mobile-solve-${task.id}.json`);
  const sampleCount = task.mobileCapture.samples.filter((sample) => !options.keyframesOnly || sample.kind === 'keyframe').length;
  return createPortal(<div className="mobile-solve-modal" role="dialog" aria-modal="true" aria-labelledby="mobile-solve-title">
    <section className="mobile-solve-dialog" ref={panel} tabIndex={-1} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === 'Tab') {
        const items = [...panel.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')].filter((el) => el.getClientRects().length);
        if (event.shiftKey && [panel.current, items[0]].includes(document.activeElement)) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      }
    }}>
      <header className="mobile-solve-header"><span className="mobile-solve-icon"><Bot size={23} /></span>
        <div><small>DEVICE POSE → ROBOT</small><h2 id="mobile-solve-title">计算机器人姿态</h2><p>{task.name} · {task.mobileCapture.samples.length} 个采样点</p></div>
        <button type="button" aria-label="关闭姿态计算" onClick={onClose}><X size={19} /></button>
      </header>
      <form onSubmit={calculate}>
        <div className="mobile-solve-body">
          <fieldset className="mobile-solve-settings">
            <legend>计算配置</legend>
            <div className="mobile-solve-model"><span>当前机器人</span><strong>{robot?.name || '尚未加载'}</strong><small>搜索参考位置 · 底盘高度保持当前值</small><small>XYZ {['x', 'y', 'z'].map((axis) => format(robotPose?.position?.[axis])).join(' / ')} m</small><small>底盘 RPY {['roll', 'pitch', 'yaw'].map((axis) => format(robotPose?.rpy?.[axis])).join(' / ')}°</small></div>
            <label className="mobile-solve-select">停车点策略<select aria-label="停车点策略" value={options.parkingMode} onChange={(event) => update({ parkingMode: event.target.value })}>
              <option value="auto">自动搜索 · 优先复用停车点</option><option value="per-pose">每个 Pose 独立停车</option><option value="fixed">固定当前停车点</option>
            </select></label>
            <p className="mobile-solve-help">自动搜索底盘平面位置与朝向，必要时每个 Pose 使用一个停车点；优先保持关节姿态和机械臂选择连续。</p>
            <div className="mobile-solve-checks">
              <label><input type="checkbox" checked={options.allowTorsoHeight} onChange={(event) => update({ allowTorsoHeight: event.target.checked, ...(event.target.checked ? { lockChestVertical: true } : {}) })} /><span>自动调节胸部高度<small>踝、膝、腰俯仰协同升降并扶正胸甲，覆盖这三个关节的锁定</small></span></label>
              <label><input type="checkbox" checked={options.lockChestVertical} disabled={options.allowTorsoHeight} onChange={(event) => update({ lockChestVertical: event.target.checked })} /><span>前胸垂直锁定<small>前胸向上轴保持竖直，允许偏航 · ≤ 0.25°</small></span></label>
            </div>
            {groups.map(([key, axes, label, unit, scale]) => <section className="mobile-solve-tolerances" key={key} aria-label={label}>
              <h3>{label}<small>逐轴 ±{unit}</small></h3>
              <div>{axes.map((axis) => <label key={axis}><span>{axis.toUpperCase()}</span><input aria-label={`${axis.toUpperCase()} ${label} (${unit})`}
                type="number" min="0.01" max={key === 'positionTolerance' ? 100 : 180} step="any" required
                value={options[key][axis] === '' ? '' : Number((options[key][axis] * scale).toFixed(8))}
                onChange={(event) => update({ [key]: { ...options[key], [axis]: event.target.value === '' ? '' : Number(event.target.value) / scale } })} /></label>)}</div>
            </section>)}
            <label className="mobile-solve-select">应用坐标系<select aria-label="应用坐标系" value={options.targetFrame} onChange={(event) => update({ targetFrame: event.target.value })}>
              <option value="optical">末端相机 · 光学坐标系</option><option value="tool">工具末端 · tool 坐标系</option>
            </select></label>
            <p className="mobile-solve-help">相机模式对齐拍摄位置与方向；工具模式将同一位姿直接赋给工具坐标系。</p>
            <label className="mobile-solve-select">参与求解<select aria-label="参与求解机械臂" value={options.armMode} onChange={(event) => update({ armMode: event.target.value })}>
              <option value="both">左右臂分别求解</option><option value="left">仅左臂</option><option value="right">仅右臂</option>
            </select></label>
            <div className="mobile-solve-checks">
              <label><input type="checkbox" checked={options.checkCollisions} onChange={(event) => update({ checkCollisions: event.target.checked })} /><span>碰撞筛选<small>检查机器人自身、底盘与工件干涉，保守排除碰撞姿态</small></span></label>
              <label><input type="checkbox" checked={options.allowSingleArm} disabled={options.armMode !== 'both'} onChange={(event) => update({ allowSingleArm: event.target.checked })} /><span>允许仅单臂可达<small>关闭时须左右臂分别可达，每次应用一个解</small></span></label>
              <label><input type="checkbox" checked={options.respectJointLocks} onChange={(event) => update({ respectJointLocks: event.target.checked })} /><span>遵守当前关节锁定<small>{options.allowTorsoHeight ? '升降使用的三个俯仰关节除外，其余关节仍遵守锁定' : '关闭后允许躯干与机械臂在关节限位内协同'}</small></span></label>
              <label><input type="checkbox" checked={options.keyframesOnly} onChange={(event) => update({ keyframesOnly: event.target.checked })} /><span>仅计算手动记录点<small>关闭后包含轨迹采样点</small></span></label>
            </div>
            <p className="mobile-solve-help">XYZ 误差按工程坐标计算；RPY 为目标局部坐标系中的相对旋转（ZYX）。未找到解时，可检查底盘高度、关节锁定和干涉原因。</p>
          </fieldset>
          <section className="mobile-solve-results" aria-label="姿态计算结果">
            <div className="mobile-solve-results-heading"><h3>{report?.version < MOBILE_SOLVE_VERSION ? '旧版计算结果' : report && (optionsChanged || running || ['error', 'cancelled'].includes(computationStatus)) ? '上次计算结果' : '计算结果'}</h3>{report && <span>{report.feasibleCount} / {report.rows.length} 可达 · {report.parkingCount ?? (report.feasibleCount ? 1 : 0)} 个停车点</span>}</div>
            {report && <p className="mobile-solve-help">计算于 {Number.isFinite(Date.parse(report.computedAt)) ? new Date(report.computedAt).toLocaleString('zh-CN', { hour12: false }) : '时间未记录'} · 本报告自动升降{storedOptions.allowTorsoHeight ? '已开启' : '未开启'}</p>}
            {running && <p className="mobile-solve-notice">后台计算尚未结束，可关闭此窗口查看进度和虚影。重新计算会替换当前计算；已有报告在本轮完成后更新。</p>}
            {computationStatus === 'error' && <p className="mobile-solve-notice" role="alert">本次计算未完成：{computationError || '后台计算发生错误'}。{report ? '下方保留上次报告，不是本次结果。' : '尚未生成计算报告。'}</p>}
            {computationStatus === 'cancelled' && report && <p className="mobile-solve-notice">本次计算已取消，下方为上次完成的报告。</p>}
            {optionsChanged && report && <p className="mobile-solve-notice">配置已修改，请重新计算后应用或保存。</p>}
            {report?.version === 1 && <p className="mobile-solve-notice">已有报告采用固定停车点且未筛选碰撞，重新计算将使用新的停车点策略。</p>}
            {report && report.version < MOBILE_SOLVE_VERSION && <p className="mobile-solve-notice">已有报告未使用自动胸部升降。重新计算可在保持胸甲竖直的同时调整高度。</p>}
            {!report ? <div className="mobile-solve-empty"><Bot size={40} /><strong>将空间采样转换为机器人姿态</strong><p>开始后自动收起窗口，后台计算并逐点显示姿态虚影。可在 3D 窗口暂停、取消或重新计算。</p></div> : <>
              <div className="mobile-solve-table"><table><thead><tr><th>采样点</th><th>停车点</th><th>左臂</th><th>右臂</th><th>结果</th></tr></thead><tbody>
                {report.rows.slice(page * 50, (page + 1) * 50).map((item, i) => <tr key={item.sampleId} className={selected === page * 50 + i ? 'is-selected' : ''}>
                  <td><button type="button" aria-pressed={selected === page * 50 + i} onClick={() => setSelected(page * 50 + i)}>{item.name}</button></td>
                  <td>{item.feasible ? item.parkingId?.replace('parking-', 'P') || 'P1' : '—'}</td>
                  {['left', 'right'].map((side) => <td key={side} className={item.solutions[side]?.feasible ? 'is-pass' : ''}>{!item.solutions[side] ? '—' : item.solutions[side].feasible ? '可达' : '未找到解'}</td>)}
                  <td><span className={`mobile-solve-badge ${item.feasible ? 'is-pass' : ''}`}>{item.feasible ? '通过' : '未通过'}</span></td>
                </tr>)}
              </tbody></table></div>
              {report.rows.length > 50 && <nav className="mobile-solve-pages" aria-label="计算结果分页"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {Math.ceil(report.rows.length / 50)}</span><button type="button" disabled={(page + 1) * 50 >= report.rows.length} onClick={() => setPage(page + 1)}>下一页</button></nav>}
              {row && <div className="mobile-solve-detail"><h4>{row.name}<span>实际误差 · 带符号</span></h4>
                {!row.feasible && <p className="mobile-solve-notice">{row.reason}</p>}
                {Object.entries(row.solutions).map(([side, solution]) => <article key={side}>
                  <header><strong>{sideName(side)}</strong><span>{solution.frameName || '无对应末端'}</span>{solution.feasible && <Check size={14} />}</header>
                  <p className="mobile-solve-parking-pose">停车位置 XYZ {['x', 'y', 'z'].map((axis) => format(mobileSolutionMapPose(report, row, side).position[axis])).join(' / ')} m · 底盘 RPY {['roll', 'pitch', 'yaw'].map((axis) => format(mobileSolutionMapPose(report, row, side).rpy[axis])).join(' / ')}°</p>
                  {Number.isFinite(solution.chestHeight) && <p className="mobile-solve-parking-pose">胸部坐标系距支撑平面 {format(solution.chestHeight)} m</p>}
                  {solution.feasible && <p className={solution.collision?.checked ? 'mobile-solve-collision-pass' : ''}>{solution.collision?.checked ? '已通过静态碰撞筛选' : '未进行碰撞筛选'}</p>}
                  {solution.positionError && <div className="mobile-solve-error-grid">{groups.flatMap(([key, axes, , unit, scale]) => axes.map((axis) => {
                    const value = solution[key === 'positionTolerance' ? 'positionError' : 'rotationError'][axis];
                    return <div key={axis} className={Math.abs(value) > report.options[key][axis] + 1e-7 ? 'is-exceeded' : ''}><small>{axis.toUpperCase()}</small><b>{format(value, scale)}</b><span>{unit}</span></div>;
                  }))}</div>}
                  {!solution.feasible && <p>{solution.reason}</p>}
                  {solution.collision?.checked && !solution.collision.clear && <p>干涉部件：{[...solution.collision.selfPairs.map((pair) => pair.join(' ↔ ')), ...solution.collision.environmentLinks, ...solution.collision.groundLinks].slice(0, 4).join('；')}</p>}
                  <footer>{report.options.lockChestVertical && Number.isFinite(solution.chestTilt) && <small>前胸倾角 {format(solution.chestTilt)}°</small>}<button type="button" disabled={!usable || !row.feasible || !solution.feasible} onClick={() => act(() => onApply(task.id, report, row.sampleId, side))}><Play size={12} />应用{sideName(side)}解</button></footer>
                </article>)}
              </div>}
            </>}
          </section>
        </div>
        <footer className="mobile-solve-footer">
          <div><p>静态姿态筛选 · {options.checkCollisions ? '保守包围盒碰撞检查' : '未启用碰撞筛选'} · 停车点间路径与连续运动尚未校验</p>{!ready && <p className="mobile-solve-notice">请先在工作台加载机器人，等待模型就绪。</p>}{(error || validation) && <p role="alert">{error || validation}</p>}</div>
          <div className="mobile-solve-actions">
            <button type="button" disabled={!report} onClick={() => act(exportReport)}><Download size={14} />导出计算报告</button>
            <button type="button" disabled={!usable || !report?.feasibleCount} onClick={() => act(() => onSave(task.id, report))}><Save size={14} />{report?.savedTaskId ? '查看已保存任务' : '保存可达姿态'}</button>
            <button className="is-primary" type="submit" disabled={!ready || !!validation || !sampleCount}><Bot size={15} />{report || running ? '重新计算' : '开始计算'}</button>
          </div>
        </footer>
      </form>
    </section>
  </div>, document.body);
}
