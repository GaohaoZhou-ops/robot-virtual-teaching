import { Eye, EyeOff, PersonStanding } from 'lucide-react';
import './RobotTwinPedestriansSettings.css';

export default function RobotTwinPedestriansSettings({ twin }) {
  const state = twin.pedestrians;
  const enabled = Boolean(state?.enabled);
  const disabled = !twin.active || twin.phase === 'connecting' || !twin.setPedestriansEnabled;
  const error = ['error', 'unavailable'].includes(state?.phase) ? state.message : '';
  return <section className="robot-twin-pedestrians-settings" aria-label="行人感知" data-pedestrians-phase={state?.phase || 'idle'}>
    <div className="viewer-display-settings__robot">
      <span><PersonStanding size={13} /> 行人感知</span>
      <button type="button" role="switch" aria-label="显示行人感知" aria-checked={enabled}
        disabled={disabled} className="viewer-display-settings__toggle"
        title={error || (!twin.active ? '连接真机孪生后自动开启' : enabled ? '关闭行人显示并停止读取' : '读取当前机器人的检测结果并显示在三维地图中')}
        onClick={() => twin.setPedestriansEnabled?.(!enabled)}>
        {enabled ? <Eye size={12} /> : <EyeOff size={12} />}<span>{enabled ? '开启' : '关闭'}</span>
      </button>
    </div>
    {twin.active && <p className="robot-twin-pedestrians-settings__robot">当前监控：{twin.selectedRobot?.name || '机器人'}</p>}
    <p className="viewer-display-settings__hint">连接后默认开启，可随时关闭显示。</p>
  </section>;
}
