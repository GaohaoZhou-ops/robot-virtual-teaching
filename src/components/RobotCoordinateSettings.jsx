import { ChevronDown } from 'lucide-react';
import { ROBOT_COORDINATE_GROUPS } from '../lib/robotCoordinateAxes.js';
import './RobotCoordinateSettings.css';

export default function RobotCoordinateSettings({ frames, selectedNames, onChange }) {
  const toggle = (names, checked) => {
    const next = new Set(selectedNames);
    names.forEach(name => { if (checked) next.add(name); else next.delete(name); });
    onChange(next);
  };
  const groupCheckbox = (items, label, ariaLabel = label) => {
    const count = items.filter(item => selectedNames.has(item.name)).length;
    return <label className="robot-coordinate-settings__check">
      <input type="checkbox" aria-label={ariaLabel} disabled={!items.length}
        checked={items.length > 0 && count === items.length}
        ref={input => { if (input) input.indeterminate = count > 0 && count < items.length; }}
        onChange={event => toggle(items.map(item => item.name), event.target.checked)} />
      <span>{label}</span><small>{count} / {items.length}</small>
    </label>;
  };
  const groups = ROBOT_COORDINATE_GROUPS.map(group => ({ ...group, frames: frames.filter(frame => frame.group === group.id) }))
    .filter(group => group.frames.length);
  const opticalFrames = frames.filter(frame => frame.opticalSide);
  return <section className="robot-coordinate-settings" aria-label="机器人坐标系显示">
    {groupCheckbox(frames, '全身坐标系', '显示全身坐标系')}
    {groupCheckbox(opticalFrames, 'Zivid 光学坐标系', '显示 Zivid 光学坐标系')}
    {frames.length > 0 ? <details className="robot-coordinate-settings__details">
      <summary><span>选择部位与坐标系</span><ChevronDown size={12} /></summary>
      <div className="robot-coordinate-settings__groups" role="group" aria-label="按部位显示坐标系">
        {groups.map(group => <div key={group.id}>{groupCheckbox(group.frames, group.label, `显示${group.label}坐标系`)}</div>)}
      </div>
      <div className="robot-coordinate-settings__list">
        {groups.map(group => <fieldset key={group.id}><legend>{group.label}</legend>
          {group.frames.map(frame => <label key={frame.name} className="robot-coordinate-settings__check"
            title={frame.jointName ? `${frame.name} · 关节 ${frame.jointName}` : frame.name}>
            <input type="checkbox" aria-label={`显示坐标系 ${frame.name}`} checked={selectedNames.has(frame.name)}
              onChange={event => toggle([frame.name], event.target.checked)} />
            <span>{frame.label || frame.name}</span>
          </label>)}
        </fieldset>)}
      </div>
    </details> : <p>加载机器人后可选择坐标系。</p>}
    <p><i className="robot-coordinate-settings__x">X</i> / <i className="robot-coordinate-settings__y">Y</i> / <i className="robot-coordinate-settings__z">Z</i> 坐标轴随机器人运动，独立于模型显示。Zivid 的 +Z 为拍摄方向。</p>
  </section>;
}
