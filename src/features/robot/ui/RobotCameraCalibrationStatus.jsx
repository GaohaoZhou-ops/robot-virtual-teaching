import { ScanLine } from 'lucide-react';

export default function RobotCameraCalibrationStatus({ calibration }) {
  if (!calibration || !Object.keys(calibration).length) return null;
  const fallback = Object.values(calibration).some((value) => value.status !== 'loaded');
  const anyLoaded = Object.values(calibration).some((value) => value.status === 'loaded');
  return (
    <aside className={`robot-camera-calibration-status${fallback ? ' has-fallback' : ''}`}
      role="status" aria-label="机器人相机标定" aria-live="polite">
      <header><ScanLine size={14} aria-hidden="true" /><strong>相机标定</strong>
        <span>{fallback ? (anyLoaded ? '部分相机使用默认方案' : '使用默认方案') : '已应用实机标定'}</span></header>
      {['left', 'right'].filter((side) => calibration[side]).map((side) => {
        const state = calibration[side], loaded = state.status === 'loaded';
        return <div key={side} className="robot-camera-calibration-status__side"
          data-side={side} data-calibration-state={state.status}>
          <span>{side === 'left' ? '左' : '右'} Zivid</span>
          <strong>{loaded ? `已加载 · ${state.method}` : state.status === 'missing' ? '文件缺失 · 默认参数'
            : state.status === 'invalid' ? '文件无效 · 默认参数' : '读取失败 · 默认参数'}</strong>
          {!loaded && <small>{state.message} · {state.source?.split('/').at(-1)}</small>}
        </div>;
      })}
    </aside>
  );
}
