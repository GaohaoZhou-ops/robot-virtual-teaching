import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp, X } from 'lucide-react';
import { explainPolylineSearch } from "../model/polylineTeachingExplanation.js";
import "./PolylineSearchExplanationDialog.css";

export default function PolylineSearchExplanationDialog({ plan, path, waistAvailable, onClose }) {
  const dialogRef = useRef(null);
  const explanation = explainPolylineSearch(plan, path, { waistAvailable });
  useEffect(() => {
    const previous = document.activeElement, dialog = dialogRef.current;
    dialog.showModal();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus?.(); };
  }, []);

  return createPortal(<dialog ref={dialogRef} className="polyline-search-explanation" role="dialog" aria-modal="true"
    aria-labelledby="polyline-search-explanation-title" aria-describedby="polyline-search-explanation-summary"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
    <header><CircleHelp size={21} /><div><span>{plan.startToolCheck?.blocked ? '起点工具检查' : '深入搜索结果'}</span><h2 id="polyline-search-explanation-title">路径检查结果说明</h2></div>
      <button type="button" autoFocus aria-label="关闭路径检查结果说明" onClick={onClose}><X size={18} /></button></header>
    <div className="polyline-search-explanation__body">
      <div className="polyline-search-explanation__conclusion">
        <p id="polyline-search-explanation-summary">{explanation.summary}</p><small>{explanation.scope}</small>
      </div>
      <section aria-label="本次搜索统计">
        <dl className="polyline-search-explanation__stats">{explanation.stats.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <p>{explanation.stop}</p><small>{explanation.countNote}</small>
      </section>
      <section aria-labelledby="polyline-search-failure-title">
        <h3 id="polyline-search-failure-title">失败位置与原因</h3>
        <p className="polyline-search-explanation__location">{explanation.location}</p>
        <p className="polyline-search-explanation__cause">{explanation.message}</p>
        {explanation.details.map((text) => <p key={text}>{text}</p>)}
        {explanation.partialNote && <p className="polyline-search-explanation__note">{explanation.partialNote}</p>}
        {explanation.original && <details><summary>查看最初的直线接近记录</summary><p>{explanation.original}</p></details>}
      </section>
      <section aria-labelledby="polyline-search-advice-title">
        <h3 id="polyline-search-advice-title">可以尝试的调整</h3>
        <ol>{explanation.suggestions.map((suggestion) => <li key={suggestion.title}><strong>{suggestion.title}</strong><p>{suggestion.text}</p></li>)}</ol>
      </section>
      <details><summary>本次规划约束</summary>
        <dl className="polyline-search-explanation__constraints">{explanation.constraints.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </details>
      <details><summary>为什么相近折线可能得到不同结果？</summary><p>{explanation.nearby}</p></details>
    </div>
    <footer><small>调整参数后需重新检查路径。</small><button type="button" onClick={onClose}>返回调整</button></footer>
  </dialog>, document.body);
}
