import { useRef, useState } from 'react';
import { ChevronDown, RotateCcw, Search } from 'lucide-react';
import { normalizeIgnoredCollisionJoints } from "../model/robotCollisionSettings.js";
import "./RobotCollisionJointSettings.css";

const GROUPS = [{ id: 'left', label: '左臂' }, { id: 'right', label: '右臂' },
  { id: 'torso', label: '躯干' }, { id: 'chassis', label: '底盘' },
  { id: 'head', label: '头部' }, { id: 'other', label: '其他部件' }];

export default function RobotCollisionJointSettings({ options, ignoredJointNames, onChange,
  expanded, onExpandedChange, ready }) {
  const [search, setSearch] = useState('');
  const toggleRef = useRef(null);
  const ignored = new Set(ignoredJointNames);
  const count = options.filter((option) => ignored.has(option.name)).length;
  const groups = GROUPS.map((group) => ({
    ...group, joints: options.filter((joint) => joint.group === group.id),
  }));
  const query = search.trim().toLowerCase();
  const filtered = options.filter((option) => [option.name, ...option.links].some((name) => name.toLowerCase().includes(query)));
  const toggle = (names, checked) => {
    const next = new Set(ignored);
    names.forEach((name) => { if (checked) next.add(name); else next.delete(name); });
    onChange?.(normalizeIgnoredCollisionJoints([...next]));
  };

  return <section className="collision-joint-settings">
    <button ref={toggleRef} type="button" className="collision-joint-settings__toggle" aria-label="设置忽略关节"
      aria-expanded={expanded} onClick={() => onExpandedChange(!expanded)}>
      <span>忽略关节</span><small>{count ? `${count} 个已忽略` : '未设置'}</small><ChevronDown size={12} />
    </button>
    {expanded && <div className="collision-joint-settings__body" role="group" aria-label="忽略碰撞检测的关节">
      {!options.length ? <p>{ready ? '当前模型没有可配置的关节' : '加载机器人后可选择关节'}</p> : <>
        <div className="collision-joint-settings__groups" role="group" aria-label="按分组全选忽略关节">
          {groups.map((group) => {
            const selected = group.joints.filter((joint) => ignored.has(joint.name)).length;
            return <label key={group.id}>
              <input type="checkbox" aria-label={`${group.label}全选`} disabled={!group.joints.length}
                checked={group.joints.length > 0 && selected === group.joints.length}
                ref={(input) => { if (input) input.indeterminate = selected > 0 && selected < group.joints.length; }}
                onChange={(event) => toggle(group.joints.map((joint) => joint.name), event.target.checked)} />
              <span>{group.label}全选</span>
            </label>;
          })}
        </div>
        <label className="collision-joint-settings__search"><Search size={12} />
          <input type="search" aria-label="搜索碰撞检测关节" placeholder="搜索关节或部件"
            value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <div className="collision-joint-settings__list">
          {GROUPS.map((group) => {
            const joints = filtered.filter((joint) => joint.group === group.id);
            return joints.length > 0 && <fieldset key={group.id}><legend>{group.label}</legend>
              {joints.map((joint) => <label key={joint.name} title={`${joint.name} → ${joint.links.join(', ')}`}>
                <input type="checkbox" aria-label={`忽略 ${joint.name}`} checked={ignored.has(joint.name)}
                  onChange={(event) => toggle([joint.name], event.target.checked)} />
                <span><strong>{joint.name}</strong><small>{joint.links.join(', ')}</small></span>
                {joint.type === 'fixed' && <em>固定</em>}
              </label>)}
            </fieldset>;
          })}
          {!filtered.length && <p>没有匹配的关节</p>}
        </div>
      </>}
      <button type="button" className="collision-joint-settings__reset" disabled={!ignored.size}
        onClick={() => { toggleRef.current?.focus(); onChange?.([]); }}><RotateCcw size={12} />恢复全部关节检测</button>
    </div>}
  </section>;
}
