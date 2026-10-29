import { useEffect, useMemo, useRef, useState } from 'react';
import { Gauge } from 'lucide-react';
import { collectTeachingVisionCoverageFrames } from "../../cameras/model/visionCoverage.js";
import "./TeachingSurfaceCoverage.css";

export default function TeachingSurfaceCoverage({ geometry, tasks }) {
  const workerRef = useRef(null);
  const requestRef = useRef(0);
  const [state, setState] = useState({ status: 'computing' });
  const records = useMemo(() => collectTeachingVisionCoverageFrames(tasks).map(({ calibration, frame }) => ({
    calibration,
    frame: { opticalPose: frame.opticalPose, pointCloud: frame.pointCloud },
  })), [tasks]);

  useEffect(() => {
    let worker;
    const fail = (message) => setState({ geometry, status: 'error', message });
    try {
      worker = new Worker(new URL("../../cameras/workers/teachingCoverage.worker.js", import.meta.url), { type: 'module' });
      workerRef.current = worker;
      worker.onmessage = ({ data }) => {
        if (workerRef.current !== worker || data.requestId !== requestRef.current) return;
        if (data.type === 'complete') setState({ geometry, ...data.result });
        else if (data.type === 'error') fail(data.message);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        if (workerRef.current !== worker) return;
        worker.terminate();
        workerRef.current = null;
        fail('覆盖率计算暂时不可用，请刷新页面重试');
      };
      worker.onmessageerror = () => fail('覆盖率结果读取失败，请刷新页面重试');
      const source = geometry.getAttribute('position');
      const position = { array: source.array.slice(), count: source.count, itemSize: source.itemSize };
      const sourceIndex = geometry.getIndex();
      const index = sourceIndex ? { array: sourceIndex.array.slice(), count: sourceIndex.count } : null;
      // Transfer copies: rendering and model export retain the original buffers.
      worker.postMessage({ type: 'initialize', position, index }, [
        position.array.buffer, ...(index ? [index.array.buffer] : []),
      ]);
    } catch (error) {
      worker?.terminate();
      workerRef.current = null;
      fail(error.message);
    }
    return () => {
      requestRef.current += 1;
      workerRef.current = null;
      worker?.terminate();
    };
  }, [geometry]);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const requestId = ++requestRef.current;
    setState((current) => ({
      ...(current.geometry === geometry ? current : {}), geometry, status: 'computing',
    }));
    try {
      worker.postMessage({ type: 'measure', requestId, records });
    } catch (error) {
      setState({ geometry, status: 'error', message: error.message });
    }
  }, [geometry, records]);

  const current = state.geometry === geometry ? state : { status: 'computing' };
  const isPointCloud = current.kind === 'points' || (!current.kind && !geometry.getIndex()?.count);
  const label = isPointCloud ? '示教点云覆盖率' : '示教表面覆盖率';
  const percentage = Number.isFinite(current.fraction) ? current.fraction * 100 : null;
  const computing = current.status === 'computing';
  const description = current.status === 'error' ? '统计失败 · 刷新页面重试'
    : current.status === 'unavailable' ? '没有可统计的有效表面或点'
      : computing ? percentage === null ? '正在计算覆盖率…' : '正在更新覆盖率…'
        : isPointCloud ? '按原始点估算 · 重叠只计一次'
          : '按表面积估算 · 重叠只计一次';

  return (
    <aside className="teaching-surface-coverage" aria-label={label} aria-busy={computing}
      data-status={current.status} data-kind={isPointCloud ? 'points' : 'surface'}
      data-fraction={current.fraction ?? ''} data-sample-count={current.sampleCount ?? ''}
      data-total-area={current.totalArea ?? ''} data-frame-count={records.length}
      title={current.message || `统计此模型全部已记录的 Mac 相机 Pose；${isPointCloud ? '按原始点数量' : '按完整模型表面积'}估算，遵循相机有效距离、视野及表面遮挡。重叠区域只计一次，播放进度、显示质量、透明度和投影开关均不影响统计。`}
    >
      <div className="teaching-surface-coverage__heading"><Gauge size={14} /><span>{label}</span></div>
      <output aria-live="polite">{percentage === null ? '—' : `≈ ${percentage.toFixed(1)}%`}</output>
      <progress aria-label={label} max="100" value={percentage ?? 0} />
      <small>{description}</small>
    </aside>
  );
}
