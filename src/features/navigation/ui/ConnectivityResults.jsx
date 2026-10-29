import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Crosshair, TriangleAlert, X } from 'lucide-react';
import { connectivityCopy } from "../model/graph.js";

export default function ConnectivityResults({ anchorRef, validation, waypoints, edges, onClose, onLocateWaypoint, onLocateEdge }) {
  const panelRef = useRef(null);
  const [position, setPosition] = useState(null);
  const points = new Map(waypoints.map((point) => [point.id, point]));
  const paths = new Map(edges.map((edge) => [edge.id, edge]));
  const networks = (validation.components || []).filter((ids) => ids.length > 1);
  const copy = connectivityCopy(validation);
  const name = (id) => points.get(id)?.name || id;

  useLayoutEffect(() => {
    const update = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(360, window.innerWidth - 24);
      const top = Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - 200));
      setPosition({ width, top, left: Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12)),
        maxHeight: window.innerHeight - top - 12 });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
    const dismiss = (event) => {
      if (!panelRef.current?.contains(event.target) && !anchorRef.current?.contains(event.target)) onClose();
    };
    const escape = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchorRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape, true);
    };
  }, [anchorRef, onClose]);

  const locate = (callback, id) => {
    onClose();
    callback(id);
  };

  return createPortal(
    <section className="connectivity-results" role="dialog" aria-label="路径检测结果" tabIndex={-1}
      ref={panelRef} style={position || { visibility: 'hidden' }}>
      <header>
        <TriangleAlert size={16} />
        <strong>{copy.title}</strong>
        <button type="button" aria-label="关闭路径检测结果" onClick={() => {
          onClose();
          anchorRef.current?.focus({ preventScroll: true });
        }}><X size={16} /></button>
      </header>
      <p>{copy.detail}</p>
      <div className="connectivity-results__list">
        {Boolean(validation.unreachableEdgeIds?.length) && <section aria-label="无法往返的路径">
          <h4>无法往返的路径 · 黄色</h4>
          <ul>{validation.unreachableEdgeIds.map((id) => {
            const edge = paths.get(id);
            if (!edge) return null;
            return <li key={id}>
              <span>{name(edge.from)} → {name(edge.to)}</span>
              <button type="button" aria-label={`定位路径 ${name(edge.from)} → ${name(edge.to)}`}
                onClick={() => locate(onLocateEdge, id)}><Crosshair size={13} />定位</button>
            </li>;
          })}</ul>
        </section>}
        {Boolean(validation.isolatedWaypointIds?.length) && <section aria-label="孤立导航点">
          <h4>孤立导航点 · 未连接其他点</h4>
          <ul>{validation.isolatedWaypointIds.map((id) => <li key={id}>
            <span>{name(id)}{points.get(id)?.teachingTaskName && <small>{points.get(id).teachingTaskName} · 示教停车点</small>}</span>
            <button type="button" aria-label={`定位导航点 ${name(id)}`}
              onClick={() => locate(onLocateWaypoint, id)}><Crosshair size={13} />定位</button>
          </li>)}</ul>
        </section>}
        {networks.length > 1 && <section aria-label="互不相连的路网">
          <h4>互不相连的路网</h4>
          <ul>{networks.map((ids, index) => <li key={ids[0]}>
            <span>路网 {index + 1} · {ids.length} 个导航点<small>{ids.slice(0, 3).map(name).join('、')}{ids.length > 3 ? '…' : ''}</small></span>
            <button type="button" aria-label={`定位路网 ${index + 1}`}
              onClick={() => locate(onLocateWaypoint, ids[0])}><Crosshair size={13} />定位</button>
          </li>)}</ul>
        </section>}
        {Boolean(validation.invalidEdgeIds?.length) && <section aria-label="端点缺失的路径">
          <h4>路径端点缺失 · 无法在地图中绘制</h4>
          <ul>{validation.invalidEdgeIds.map((id) => <li key={id}><span>{id}</span></li>)}</ul>
        </section>}
      </div>
    </section>, document.body,
  );
}
