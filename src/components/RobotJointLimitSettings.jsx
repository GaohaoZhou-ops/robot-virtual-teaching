import { useEffect, useId, useState } from 'react';
import { RotateCcw, SlidersHorizontal } from 'lucide-react';
import { ARM_SOFT_LIMIT_RATIO, MIN_ARM_SOFT_LIMIT_RATIO, armSoftLimitPercent } from '../lib/robotJointLimits.js';
import './RobotJointLimitSettings.css';

export default function RobotJointLimitSettings({ ratio, onChange, disabledReason = '' }) {
  const descriptionId = useId();
  const percent = armSoftLimitPercent(ratio);
  const minimum = MIN_ARM_SOFT_LIMIT_RATIO * 100;
  const [draft, setDraft] = useState(String(percent));
  useEffect(() => { setDraft(String(percent)); }, [percent]);

  const commit = () => {
    if (disabledReason) return;
    const value = draft.trim() ? Number(draft) : NaN;
    const next = Number.isFinite(value) ? Math.max(minimum, Math.min(100, Math.round(value))) : percent;
    setDraft(String(next));
    if (next !== percent) onChange(next / 100);
  };

  return <section className="workbench-menu-section robot-joint-limit-settings" aria-label="关节软限位设置"
    data-workbench-menu-keep-open title={disabledReason || undefined}>
    <div className="robot-joint-limit-settings__heading">
      <span><SlidersHorizontal size={14} />关节软限位</span>
      <button type="button" aria-label="恢复默认软限位 95%" disabled={Boolean(disabledReason) || ratio === ARM_SOFT_LIMIT_RATIO}
        onClick={() => { setDraft('95'); onChange(ARM_SOFT_LIMIT_RATIO); }}>
        <RotateCcw size={11} />恢复 95%
      </button>
    </div>
    <div className="robot-joint-limit-settings__controls">
      <input type="range" min={minimum} max="100" step="1" value={percent}
        aria-label="关节软限位比例滑块" aria-valuetext={`${percent}%`} aria-describedby={descriptionId}
        disabled={Boolean(disabledReason)} onChange={(event) => onChange(Number(event.target.value) / 100)} />
      <label className="robot-joint-limit-settings__value">
        <input type="number" min={minimum} max="100" step="1" value={draft}
          aria-label="关节软限位百分比" aria-describedby={descriptionId} disabled={Boolean(disabledReason)}
          onChange={(event) => setDraft(event.target.value)} onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); commit(); }
            if (event.key === 'Escape') setDraft(String(percent));
          }} />
        <span>%</span>
      </label>
    </div>
    <p id={descriptionId} className="robot-joint-limit-settings__description">
      {disabledReason || `保留双臂硬限位的中间 ${percent}%，两端各预留 ${Number(((100 - percent) / 2).toFixed(2))}%。`}
    </p>
  </section>;
}
