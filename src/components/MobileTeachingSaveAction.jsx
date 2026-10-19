import { Bot, Save } from 'lucide-react';
import './MobileTeachingSaveAction.css';

export default function MobileTeachingSaveAction({ task, tasks, onSave, disabledReason = '' }) {
  const report = task?.mobileSolve;
  if (!onSave || !report?.feasibleCount) return null;
  const saved = tasks.some((item) => item.id === report.savedTaskId);
  return <section className="mobile-teaching-save" aria-label="设备姿态保存">
    <strong>上次计算 · {report.feasibleCount} 个可达姿态</strong>
    <p>{saved ? '已生成停车点和机器人姿态，可在“示教数据”中查看。' : '可达姿态待保存，保存后将生成停车点和对应机器人姿态，加入“示教数据”。'}</p>
    <button type="button" disabled={!!disabledReason} title={disabledReason || undefined} onClick={() => onSave(task.id)}>
      {saved ? <Bot size={13} /> : <Save size={13} />}{saved ? '查看已保存任务' : '保存可达姿态'}
    </button>
    {disabledReason && <small>{disabledReason}</small>}
  </section>;
}
