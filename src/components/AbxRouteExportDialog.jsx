import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Route, X } from 'lucide-react';
import { downloadJson } from '../lib/io.js';
import './AbxTeachingExportDialog.css';

export default function AbxRouteExportDialog({ routes, onClose }) {
  const panel = useRef(null);
  const [index, setIndex] = useState(0);
  const route = routes[index];
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    return () => previous?.focus?.();
  }, []);
  const keyDown = (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const controls = [...panel.current.querySelectorAll('button, select')];
    if (event.shiftKey && [panel.current, controls[0]].includes(document.activeElement)) {
      event.preventDefault(); controls.at(-1)?.focus();
    } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
      event.preventDefault(); controls[0]?.focus();
    }
  };
  return createPortal(<div className="abx-export-modal" onKeyDown={keyDown}>
    <section className="abx-export-dialog" role="dialog" aria-modal="true" aria-labelledby="abx-route-title" tabIndex={-1} ref={panel}>
      <header><Route size={24} /><div><small>MAP ROUTE / ABX</small><h2 id="abx-route-title">导出机器人路径</h2></div>
        <button type="button" aria-label="关闭机器人路径导出" onClick={onClose}><X size={18} /></button></header>
      <div className="abx-export-body">
        <p className="abx-export-map"><strong>{route.name}</strong><span>{route.nodes.length} 节点 · {route.edges.length} 有向边</span></p>
        {routes.length > 1 && <label className="abx-export-description">选择路网 <select aria-label="选择导出路网"
          value={index} onChange={(event) => setIndex(Number(event.target.value))}>
          {routes.map((doc, i) => <option key={doc.id} value={i}>{doc.name}</option>)}
        </select></label>}
        <div className="abx-export-notice" role="note"><strong>在机器人“路网管理 → 导入路网”中选择下载的文件</strong>
          <p>文件包含节点、X / Y 米制坐标、弧度朝向和有向连线。逐边速度、加速度、倒车及避障设置不属于机器人路网格式，仍保存在完整工程中。</p>
          <p>定位场景：{route.scene_name || '未绑定，请在机器人端切换使用路网时绑定'}。中间节点的空朝向保留为空。</p></div>
      </div>
      <footer><span>.route.json · schema_version 1</span><button type="button" className="abx-export-primary"
        onClick={() => downloadJson(route, `${route.id}.route.json`, { compact: true })}><Download size={14} />下载机器人路径文件</button></footer>
    </section>
  </div>, document.body);
}
