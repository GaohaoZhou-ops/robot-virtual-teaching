import { useEffect, useRef, useState } from 'react';
import { Glasses, X } from 'lucide-react';
import { buildVisionScenePackage } from '../lib/visionScenePackage.js';
import { applyRobotJointValues, configureRobotArmSoftLimits, disposeRobotModel, loadRobotModel } from '../lib/robotLoader.js';
import { configureRobotJointCoupling } from '../lib/robotJointCoupling.js';
import './IPadTeaching.css';

export default function VisionSceneShareDialog({ mapData, robot, robotPose, robotJointValues, tasks, waypoints, edges, mode,
  pointColorMode, placedObjectColorMode, workspaceTransfer, softLimitRatio, softLimitOverrides, jointCoupling, onClose }) {
  const [status, setStatus] = useState('正在准备完整空间工程…');
  const [scene, setScene] = useState(null), [error, setError] = useState('');
  const closeButton = useRef(null);
  useEffect(() => {
    const previous = document.activeElement; closeButton.current?.focus();
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    const controller = new AbortController(); let ticket, model, heartbeat;
    const snapshot = structuredClone({ robotPose, robotJointValues, tasks, waypoints, edges, pointColorMode, placedObjectColorMode, workspaceTransfer });
    const revoke = () => {
      if (ticket) fetch(`/__atlas/vision-scenes/${ticket.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ticket.ownerToken}` }, keepalive: true }).catch(() => {});
    };
    async function request(path, options = {}) {
      const response = await fetch(`/__atlas/vision-scenes${path}`, { signal: controller.signal, ...options,
        headers: { ...options.headers, ...(ticket ? { Authorization: `Bearer ${ticket.ownerToken}` } : {}) } });
      const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
    }
    (async () => {
      try {
        // Finish allocation even if the dialog unmounts so that its credentials
        // are available for revocation (including React StrictMode remounts).
        ticket = await request('', { method: 'POST', signal: null });
        if (controller.signal.aborted) { revoke(); return; }
        heartbeat = setInterval(() => { request(`/${ticket.id}/heartbeat`, { method: 'POST' }).catch(() => {
          if (!controller.signal.aborted) setError('共享连接已中断，请关闭后重新打开此窗口。');
        }); }, 45000);
        if (robot) {
          setStatus('正在装配完整机器人…');
          model = await loadRobotModel(robot, { signal: controller.signal });
          configureRobotJointCoupling(model, jointCoupling);
          configureRobotArmSoftLimits(model, softLimitRatio, softLimitOverrides);
          applyRobotJointValues(model, snapshot.robotJointValues);
        }
        const manifest = await buildVisionScenePackage({ mapData, robotModel: model, robotDescriptor: robot, ...snapshot,
          mode, signal: controller.signal, onProgress: setStatus,
          onAsset: async (asset, buffer) => request(`/${ticket.id}/assets/${asset.id}`, { method: 'PUT', body: buffer }) });
        await request(`/${ticket.id}/manifest`, { method: 'PUT', body: JSON.stringify(manifest), headers: { 'Content-Type': 'application/json' } });
        setScene(manifest); setStatus('已准备好，在 Vision Pro 中打开「空间工程」即可接收。');
      } catch (failure) { clearInterval(heartbeat); revoke(); if (!controller.signal.aborted) setError(failure.message); }
      finally { if (model) disposeRobotModel(model); }
    })();
    return () => {
      controller.abort(); clearInterval(heartbeat);
      revoke();
    };
  }, []); // Publish one frozen snapshot; subsequent desktop edits require reopening.
  return <div className="ipad-modal" onKeyDown={(event) => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'Tab') { event.preventDefault(); closeButton.current?.focus(); }
  }}><section className="ipad-dialog" role="dialog" aria-modal="true" aria-labelledby="vision-scene-title">
    <header><span className="ipad-mark"><Glasses size={24}/></span><div><small>ATLAS / SPATIAL WORKSPACE</small><h2 id="vision-scene-title">在 Vision Pro 查看完整工程</h2></div><button ref={closeButton} aria-label="关闭空间工程共享" onClick={onClose}><X size={18}/></button></header>
    <div className="ipad-dialog__body"><strong>{mapData.name}</strong><p role={error ? 'alert' : 'status'} className={error ? 'ipad-error' : 'ipad-pose-summary'}>{error || status}</p>
      {scene && <p>完整地图 · {scene.robotRoot ? '完整机器人' : '未加载机器人'} · {scene.clips.length} 个可回放任务</p>}
      <p>在头显中捏住沙盘移动和缩放，双击局部进入原大查看，拖动时间轴检查已保存的动作。</p>
      <p>两台设备连接同一局域网，下载期间保持此窗口打开。已下载的工程可离线查看；更新工程后重新打开此窗口同步。</p>
    </div>
  </section></div>;
}
