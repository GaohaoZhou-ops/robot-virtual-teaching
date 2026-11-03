import { ArrowDownToLine, TriangleAlert } from 'lucide-react';
import { ROBOT_AIRBORNE_THRESHOLD } from '../model/robotGroundClearance.js';

export default function RobotGroundClearanceWarning({ warnings, onGround, disabledReason = '', telemetry = false }) {
  if (!warnings.length) return null;
  return (
    <aside className="robot-ground-clearance-warning" role="status" aria-label="机器人底盘悬空提示" aria-live="polite" aria-atomic="true">
      <header>
        <TriangleAlert size={14} aria-hidden="true" />
        <strong>底盘悬空</strong>
        <span>超过 {ROBOT_AIRBORNE_THRESHOLD * 100} cm</span>
      </header>
      <p>底盘最低点高于地面 z=0</p>
      <ul>
        {warnings.map(({ id, name, height }) => (
          <li key={id} data-robot-id={id}>
            <span title={name}>{name}</span>
            <strong>离地 {height} cm</strong>
            <button type="button" onClick={() => onGround(id)} disabled={Boolean(disabledReason)}
              aria-label={warnings.length > 1 ? `${name}底盘着地` : '底盘着地'}
              title={disabledReason || (telemetry ? '将该孪生模型的底盘贴合 z=0 地面' : '将底盘贴合 z=0 地面，保持水平位置与姿态')}>
              <ArrowDownToLine size={12} aria-hidden="true" />底盘着地
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
