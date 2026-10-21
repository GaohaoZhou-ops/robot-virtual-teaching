import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Download, LoaderCircle, X } from 'lucide-react';
import { buildAbxTeachingArchive, readAbxRobotPackage } from '../lib/abxTeachingExport.js';
import './AbxTeachingExportDialog.css';

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AbxTeachingExportDialog({ snapshot, onClose }) {
  const panel = useRef(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [downloaded, setDownloaded] = useState(false);
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    const controller = new AbortController();
    (async () => {
      try {
        const needsRobot = snapshot.payload.virtualTeaching?.tasks?.some((task) => !task.abx
          && task.parkingPoints?.some((parking) => parking.poses?.length));
        const robotPackage = needsRobot
          ? await readAbxRobotPackage(snapshot.robot, snapshot.robotPackage, { signal: controller.signal }) : null;
        const archive = await buildAbxTeachingArchive(snapshot.payload, { robotPackage });
        if (!controller.signal.aborted) setResult(archive);
      } catch (reason) { if (!controller.signal.aborted) setError(reason.message); }
    })();
    return () => { controller.abort(); previous?.focus?.(); };
  }, [snapshot]);
  const keyDown = (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const buttons = [...panel.current.querySelectorAll('button:not(:disabled)')];
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const targets = result ? [
    ...result.navigation.tasks.flatMap((task) => task.sequence.filter((step) => step.type === 'route_navigation')
      .map((step) => ({ nodeId: step.nodeId, name: `${task.name} / ${step.stationName || step.nodeId}${step.beforePoseSeq ? ` → Pose ${step.beforePoseSeq}` : ` · 步骤 ${step.seq}`}`, target: step.target }))),
  ] : [];
  const stamp = snapshot.payload.exportedAt.replace(/[:.]/g, '-').slice(0, 19);
  return createPortal(<div className="abx-export-modal" onKeyDown={keyDown}>
    <section className="abx-export-dialog" role="dialog" aria-modal="true" aria-labelledby="abx-export-title" ref={panel} tabIndex={-1}>
      <header><Bot size={24} /><div><small>MAP TEACHING / ABX</small><h2 id="abx-export-title">导出机器人示教</h2></div>
        <button type="button" aria-label="关闭机器人示教导出" onClick={onClose}><X size={18} /></button></header>
      <div className="abx-export-body">
        <p className="abx-export-map">当前地图 <strong>{snapshot.payload.map?.fileName || '未命名地图'}</strong><span>MAP · 米 / 弧度</span></p>
        <div className="abx-export-notice" role="note">
          <strong>机器人示教 · 任务与路网导入包</strong>
          <p>{result?.summary.notice || '正在检查任务和关联路网。已导入工程的路网将随任务打包，在大脑“示教任务 → 导入”中一并导入。'}</p>
        </div>
        {!result && !error && <p className="abx-export-loading" role="status"><LoaderCircle className="is-spinning" size={16} />正在校验机器人姿态与导航坐标…</p>}
        {error && <p className="abx-export-error" role="alert">{error}</p>}
        {result && <>
          <dl className="abx-export-counts"><div><dt>示教任务</dt><dd>{result.summary.taskCount}</dd></div><div><dt>机器人 Pose</dt><dd>{result.summary.poseCount}</dd></div><div><dt>导航目标</dt><dd>{new Set(targets.map((point) => point.nodeId)).size}</dd></div><div><dt>导航步骤</dt><dd>{result.summary.navigationCount}</dd></div></dl>
          <p className="abx-export-description">保留任务、停车点和步骤顺序，关节转换为弧度。已导入路网时，保留完整节点、连线、原始 N 编号、坐标、朝向及定位场景名称；未匹配的停车点会提示修正。{result.summary.routeImportIncluded ? '路网内嵌在任务中，ZIP 同时附带 routes/ 路网副本和 navigation.json 导航清单。' : 'ZIP 附带 navigation.json 导航清单，未提供的路网坐标不作推测。'}</p>
          {result.summary.routeCount > 0 && <p className="abx-export-description" aria-label="随包路网">已携带 {result.summary.routeCount} 个路网 · {result.summary.nodeCount} 个节点 · {result.summary.edgeCount} 条有向边</p>}
          {result.summary.warnings.length > 0 && <ul className="abx-export-description" aria-label="路网导出提示">{result.summary.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
          {targets.length > 0 && <div className="abx-export-targets"><table aria-label="路网导航目标预览"><thead><tr><th>目标</th><th>X / m</th><th>Y / m</th><th>Yaw / rad</th></tr></thead><tbody>{targets.slice(0, 12).map((point, index) => <tr key={index}><td title={point.name}>{point.name}</td>{['x_m', 'y_m', 'yaw_rad'].map((key) => <td key={key}>{point.target?.[key] == null ? '—' : point.target[key].toFixed(6)}</td>)}</tr>)}</tbody></table>{targets.some((point) => !point.target) && <p>“—” 表示原任务仅包含站点编号，未提供对应地图坐标。</p>}{targets.length > 12 && <p>其余 {targets.length - 12} 项保存在完整导航清单中。</p>}</div>}
        </>}
      </div>
      <footer><span role="status">{downloaded ? '已下载 · 在大脑示教任务页面导入 ZIP' : '导出本地文件'}</span><div>
        <button type="button" disabled={!result} onClick={() => download(new Blob([result.navigationBytes], { type: 'application/json' }), `robot-navigation-${stamp}.json`)}>下载导航清单</button>
        <button type="button" className="abx-export-primary" disabled={!result} onClick={() => { download(result.blob, `robot-teaching-${stamp}.zip`); setDownloaded(true); }}><Download size={14} />下载机器人导入包</button>
      </div></footer>
    </section>
  </div>, document.body);
}
