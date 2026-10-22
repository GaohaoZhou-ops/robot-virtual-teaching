import { useMemo, useState } from 'react';
import { Bot, Camera, ChevronLeft, ChevronRight } from 'lucide-react';
import { mobileSamplePosition } from '../lib/ipadCaptureDisplay.js';
import { mobileRobotPoseLinks, mobileSampleStatus } from '../lib/mobileTeachingReview.js';
import { mobileReportSolveOptions } from '../lib/mobileTeachingSolver.js';
import { mobileRowFailureReason } from '../lib/mobileTeachingDiagnostics.js';

const PAGE_SIZE = 50;

export default function MobileTeachingPoseList({ task, robotTasks, selection, onSelect, onOpenRobotPose, onSolve }) {
  const [page, setPage] = useState(0);
  const samples = task.mobileCapture.samples;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(samples.length / PAGE_SIZE) - 1));
  const rows = useMemo(() => new Map((task.mobileSolve?.rows || []).map((row) => [row.sampleId, row])), [task.mobileSolve]);
  const links = useMemo(() => mobileRobotPoseLinks(task, robotTasks), [task, robotTasks]);
  const selected = selection?.taskId === task.id ? samples.find((sample) => sample.id === selection.sampleId) : null;
  const selectedRow = selected && rows.get(selected.id);
  const solveOptions = useMemo(() => task.mobileSolve && mobileReportSolveOptions(task.mobileSolve), [task.mobileSolve]);
  const selectedLink = selected && links.get(selected.id);
  const position = selected && mobileSamplePosition(selected, task);

  return <>
    <div className="teaching-capture-tree__pose-group mobile-pose-list" role="group" aria-label={`${task.name} 的采样 Pose`}>
      {samples.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((sample, index) => {
        const row = rows.get(sample.id), link = links.get(sample.id);
        const isSelected = selected?.id === sample.id;
        return <button type="button" key={sample.id} role="treeitem"
          className={`teaching-capture-tree__pose-item ${isSelected ? 'is-previewed' : ''}`}
          aria-label={`预览采样 Pose ${sample.name || `Pose ${currentPage * PAGE_SIZE + index + 1}`}`}
          aria-selected={isSelected} data-mobile-sample-id={sample.id}
          title={mobileRowFailureReason(row, solveOptions) || '在 3D 中高亮采样位置、光学坐标轴与朝向'}
          onClick={() => onSelect(task.id, sample.id)}>
          <i>{String(currentPage * PAGE_SIZE + index + 1).padStart(3, '0')}</i><Camera size={11} />
          <span>{sample.name || 'Pose'}</span><small>{mobileSampleStatus(row, link)}</small>
        </button>;
      })}
    </div>
    {samples.length > PAGE_SIZE && <nav className="mobile-pose-pages" aria-label={`${task.name} 的 Pose 分页`}>
      <button type="button" aria-label="上一页采样 Pose" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={12} /></button>
      <span>{currentPage + 1} / {Math.ceil(samples.length / PAGE_SIZE)}</span>
      <button type="button" aria-label="下一页采样 Pose" disabled={(currentPage + 1) * PAGE_SIZE >= samples.length} onClick={() => setPage(currentPage + 1)}><ChevronRight size={12} /></button>
    </nav>}
    {selected && <section className="mobile-pose-detail" aria-label="采样 Pose 详情">
      <header><strong>{selected.name || 'Pose'}</strong><span>{mobileSampleStatus(selectedRow, selectedLink)}</span></header>
      <div className="mobile-pose-position">{['x', 'y', 'z'].map((axis) => <span key={axis}>{axis.toUpperCase()} <b>{position[axis].toFixed(3)}</b></span>)}<small>m</small></div>
      {selectedLink ? <>
        <p>{selectedLink.task.name} / {selectedLink.parkingPoint.name}</p>
        <button type="button" onClick={() => onOpenRobotPose(selectedLink.parkingPoint.id, selectedLink.pose.id)}><Bot size={12} />打开机器人姿态</button>
      </> : <>
        <p>{mobileRowFailureReason(selectedRow, solveOptions) || (selectedRow?.feasible ? '此 Pose 已有可达解，保存后可调整机器人关节。' : '先计算机器人姿态，再保存可达解并精修关节。')}</p>
        {selectedRow && <button type="button" onClick={() => onSolve(task.id, selected.id)}>查看此 Pose 的计算结果</button>}
      </>}
    </section>}
  </>;
}
