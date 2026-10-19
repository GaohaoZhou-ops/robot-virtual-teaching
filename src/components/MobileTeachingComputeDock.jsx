import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Check, ChevronDown, ChevronLeft, ChevronRight, Crosshair, LoaderCircle, Pause, Play, RotateCcw, Save, Square, X } from 'lucide-react';
import './MobileTeachingComputeDock.css';

const labels = { running: '正在计算', pausing: '正在暂停', paused: '计算已暂停', completed: '计算完成', cancelled: '计算已取消', error: '计算未完成' };

export default function MobileTeachingComputeDock({ computation, inWorkbench, onPause, onResume, onCancel, onRestart,
  onConfigure, onPreview, onFollowLatest, onFocusPreview, onDismiss, onSave, saveDisabledReason = '' }) {
  const [collapsed, setCollapsed] = useState(false);
  if (!computation) return null;
  const { status, completed, total, feasibleCount, previewIndex, previewCount, preview } = computation;
  const active = ['running', 'pausing', 'paused'].includes(status);
  const percent = total ? Math.round(completed / total * 100) : 0;
  const target = inWorkbench ? document.getElementById('panel-body-3d') : document.body;
  if (!target) return null;
  return createPortal(<section className={`mobile-compute-dock is-${status}${collapsed ? ' is-collapsed' : ''}${inWorkbench ? '' : ' is-floating'}`}
    aria-label="设备姿态后台计算" data-compute-status={status} data-compute-run={computation.id}
    data-completed={completed} data-total={total} data-feasible={feasibleCount} data-preview-count={previewCount}>
    <header>
      <span className="mobile-compute-dock__mark">{status === 'running' ? <LoaderCircle className="mobile-compute-spin" size={17} /> : status === 'paused' ? <Pause size={17} /> : status === 'completed' ? <Check size={17} /> : <Bot size={17} />}</span>
      <div><strong aria-live="polite">{labels[status]}</strong><small title={computation.taskName}>{computation.taskName}</small></div>
      <b>{percent}<small>%</small></b>
      <button type="button" className="mobile-compute-icon" aria-label={collapsed ? '展开计算进度' : '收起计算进度'} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}><ChevronDown size={15} /></button>
      {!active && <button type="button" className="mobile-compute-icon" aria-label="关闭计算进度" onClick={onDismiss}><X size={15} /></button>}
    </header>
    <div className="mobile-compute-dock__track" role="progressbar" aria-label="姿态计算进度" aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={completed} aria-valuetext={`${completed} / ${total} 个姿态，${feasibleCount} 个可达`}><span style={{ width: `${percent}%` }} /></div>
    {!collapsed && <div className="mobile-compute-dock__body">
      <div className="mobile-compute-dock__counts"><span>已计算 <b>{completed} / {total}</b></span><span>可达 <b>{feasibleCount}</b></span><span>未通过 <b>{completed - feasibleCount}</b></span></div>
      <p className="mobile-compute-dock__current">{status === 'cancelled' ? '本轮预览已清除，已保存结果保留。'
        : status === 'completed' ? feasibleCount ? '计算完成，可达姿态待保存。点击“保存可达姿态”生成停车点和机器人姿态，加入“示教数据”。' : '未找到可达姿态，可调整停车位置或计算配置。'
          : status === 'error' ? computation.error : `${status === 'paused' ? '停在' : '求解'} ${computation.name || '准备运动学模型'}${computation.side ? ` · ${computation.side === 'left' ? '左臂' : '右臂'}` : ''}`}</p>
      {previewCount > 0 && <div className="mobile-compute-dock__preview">
        <div><span>姿态虚影</span><button type="button" aria-pressed={computation.followLatest} onClick={() => onFollowLatest(!computation.followLatest)}>跟随最新</button><button type="button" className="mobile-compute-icon" aria-label="定位计算姿态虚影" disabled={!preview} onClick={onFocusPreview}><Crosshair size={13} /></button></div>
        <nav aria-label="已计算姿态预览"><button type="button" aria-label="上一个计算姿态" disabled={previewIndex <= 0} onClick={() => onPreview(previewIndex - 1)}><ChevronLeft size={14} /></button>
          <strong title={preview?.poseName}>{preview ? `${preview.poseName} · ${preview.side === 'left' ? '左臂' : '右臂'}` : '虚影已隐藏'}</strong><small>{previewIndex + 1} / {previewCount}</small>
          <button type="button" aria-label="下一个计算姿态" disabled={previewIndex >= previewCount - 1} onClick={() => onPreview(previewIndex + 1)}><ChevronRight size={14} /></button></nav>
      </div>}
      <div className="mobile-compute-dock__controls">
        {status === 'completed' && feasibleCount > 0 && onSave && <button type="button" className="is-primary mobile-compute-dock__save" disabled={!!saveDisabledReason} title={saveDisabledReason || undefined} onClick={() => onSave(computation.taskId)}><Save size={13} />保存可达姿态</button>}
        {active && <button type="button" className="is-primary" disabled={status === 'pausing'} onClick={status === 'paused' ? onResume : onPause} aria-label={status === 'paused' ? '继续姿态计算' : '暂停姿态计算'}>
          {status === 'paused' ? <Play size={13} /> : <Pause size={13} />}{status === 'paused' ? '继续' : status === 'pausing' ? '暂停中' : '暂停'}</button>}
        {active && <button type="button" onClick={onCancel} aria-label="取消姿态计算"><Square size={11} />取消</button>}
        <button type="button" onClick={onRestart} aria-label="重新计算姿态"><RotateCcw size={13} />重新计算</button>
        <button type="button" onClick={onConfigure}>{status === 'completed' ? '查看结果' : '计算配置'}</button>
      </div>
    </div>}
  </section>, target);
}
