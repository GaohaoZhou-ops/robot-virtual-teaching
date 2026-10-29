import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp, X } from 'lucide-react';
import { POLYLINE_ALGORITHM_DEFAULTS, POLYLINE_ALGORITHM_GROUPS, POLYLINE_CONSTRAINT_HELP,
  polylineParameterValue } from "../model/polylineTeachingParameters.js";
import "./PolylineSearchExplanationDialog.css";
import "./PolylineAlgorithmHelpDialog.css";

export default function PolylineAlgorithmHelpDialog({ path, onClose }) {
  const dialogRef = useRef(null);
  const settings = { ...POLYLINE_ALGORITHM_DEFAULTS, ...path.settings };
  useEffect(() => {
    const previous = document.activeElement, dialog = dialogRef.current;
    dialog.showModal();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus?.(); };
  }, []);

  return createPortal(<dialog ref={dialogRef} className="polyline-search-explanation polyline-algorithm-help" role="dialog" aria-modal="true"
    aria-labelledby="polyline-algorithm-help-title" aria-describedby="polyline-algorithm-help-summary"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
    <header><CircleHelp size={21} /><div><span>算法约束</span><h2 id="polyline-algorithm-help-title">算法约束与参数说明</h2></div>
      <button type="button" autoFocus aria-label="关闭算法约束说明" onClick={onClose}><X size={18} /></button></header>
    <div className="polyline-search-explanation__body">
      <p id="polyline-algorithm-help-summary">勾选项决定参与规划的自由度与划线方式；高级参数调整精度、运动和搜索预算。修改参数后需重新检查路径。</p>
      <section aria-labelledby="polyline-algorithm-options-title">
        <h3 id="polyline-algorithm-options-title">勾选项与底盘参数</h3>
        <dl className="polyline-algorithm-help__options">{POLYLINE_CONSTRAINT_HELP.map(([label, description]) => <div key={label}>
          <dt>{label}</dt><dd>{description}</dd>
        </div>)}</dl>
      </section>
      {POLYLINE_ALGORITHM_GROUPS.map((group) => <details key={group.key}>
        <summary>{group.label}<span>{group.fields.length} 项参数</span></summary>
        {group.fixedBaseOnly && <p className="polyline-algorithm-help__note">本组仅在底盘静止时生效；使用移动或自搜索时保留配置，暂不应用。</p>}
        <dl className="polyline-algorithm-help__parameters">{group.fields.map((field) => <div key={field.key}>
          <dt>{field.label}<b>当前 {polylineParameterValue(field, settings[field.key])} {field.unit}</b></dt>
          <dd><small>默认 {polylineParameterValue(field, field.default)} {field.unit} · 范围 {polylineParameterValue(field, field.min)}–{polylineParameterValue(field, field.max)} {field.unit}</small>
            <p>{field.description}</p></dd>
        </div>)}</dl>
      </details>)}
      <details><summary>搜索、碰撞检查与参数记忆</summary>
        <p>快速搜索参考本次会话的成功轨迹、已保存折线和通用接近方案；实际数量受可用参考和候选生成影响。深入搜索再尝试不同方向与距离的绕行。局部姿态重试会回退到已检查采样点，重新验证连续运动；固定工具碰撞仍需要改变接近路线。</p>
        <p>增加时间或次数只能扩大本轮尝试范围，不能保证有解。深入搜索因时限或数量上限结束时，只保留已完成验证的结果，未检查完的路线不能执行。</p>
        <p>整机碰撞、关节限位、耦合及当前参与规划的关节权限始终参与检查；工件碰撞仍使用 8 mm 预留区。显示或隐藏机器人不会影响检查。</p>
        <p>参数记住上次配置，并随折线保存；新建折线沿用当前参数，打开旧折线采用该记录的参数。“恢复高级参数默认值”只重置这 8 项，不改变点位、速度上限、工具偏移或勾选状态。成功轨迹参考仅保留在本次页面会话，刷新后清空。</p>
      </details>
    </div>
    <footer><small>查看说明不会修改配置或当前检查结果。</small><button type="button" onClick={onClose}>返回示教</button></footer>
  </dialog>, document.body);
}
