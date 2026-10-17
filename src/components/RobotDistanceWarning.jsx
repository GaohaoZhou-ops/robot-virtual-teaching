import { ShieldAlert } from 'lucide-react';
import { ROBOT_COLLISION_SAFETY_DISTANCE } from '../lib/robotCollision.js';
import { collisionSideForLink } from '../lib/robotCollisionSettings.js';

const WARNING_GROUPS = [
  { id: 'left', label: '左臂' },
  { id: 'right', label: '右臂' },
  { id: 'body', label: '本体' },
];

export default function RobotDistanceWarning({ status }) {
  if (!status.enabled || !['near', 'collision'].includes(status.state)) return null;

  const collisions = new Set(status.collisionLinks || []);
  const links = [...new Set([...collisions, ...(status.nearLinks || [])])];
  const groups = WARNING_GROUPS.map((group) => {
    const groupLinks = links.filter((link) => collisionSideForLink(link) === group.id);
    return {
      ...group,
      links: groupLinks,
      state: groupLinks.some((link) => collisions.has(link)) ? 'collision' : 'near',
    };
  }).filter((group) => group.links.length);
  const distance = Number.isFinite(status.minimumDistance)
    ? Math.max(0, status.minimumDistance * 1000)
    : null;
  const thresholdCm = (status.threshold ?? ROBOT_COLLISION_SAFETY_DISTANCE) * 100;

  return (
    <aside
      className={`robot-distance-warning is-${status.state}`}
      role="status"
      aria-label="机器人距离警告"
      aria-live="polite"
      aria-atomic="true"
      data-collision-state={status.state}
      data-collision-distance={distance ?? ''}
      data-collision-links={links.join(',')}
    >
      <header>
        <ShieldAlert size={14} aria-hidden="true" />
        <strong>距离警告</strong>
        {distance !== null && <span>最近 <b>{distance.toFixed(0)} mm</b></span>}
      </header>
      <p>{status.state === 'collision' ? '检测到环境干涉' : `距离低于 ${thresholdCm} cm 安全阈值`}</p>
      {groups.length > 0 && (
        <ul>
          {groups.map((group) => (
            <li
              key={group.id}
              className={`is-${group.state}`}
              data-collision-side={group.id}
              data-collision-state={group.state}
              data-collision-links={group.links.join(',')}
            >
              <span>{group.label}</span>
              <strong>{group.state === 'collision' ? '环境干涉' : '距离过近'}</strong>
              <small>{group.links.length} 处</small>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
