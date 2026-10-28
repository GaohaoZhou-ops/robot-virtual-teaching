import { useLayoutEffect, useRef } from 'react';
import { formatRobotDetectionConfidence, isSuspectedRobotDetection } from '../lib/robotTwinInspection.js';

export default function RobotTwinCaptureImage({ asset, inspection, label }) {
  const overlay = useRef(null);
  const { boxes, imageWidth, imageHeight } = inspection;
  const signature = JSON.stringify(boxes);
  // Preserve the result-list numbering while drawing confirmed regions last.
  const annotations = boxes.map((box, index) => ({ box, index }))
    .sort((a, b) => Number(isSuspectedRobotDetection(b.box)) - Number(isSuspectedRobotDetection(a.box)));
  useLayoutEffect(() => {
    const element = overlay.current;
    if (!element || !imageWidth || !imageHeight) return undefined;
    const positionLabels = () => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      const placed = [];
      const nodes = [...element.querySelectorAll('[data-detection-index]')]
        .sort((a, b) => Number(a.classList.contains('is-suspected')) - Number(b.classList.contains('is-suspected')));
      for (const node of nodes) {
        const box = boxes[Number(node.dataset.detectionIndex)];
        node.style.maxWidth = `${width}px`;
        const bounds = node.getBoundingClientRect();
        const x = box.x / imageWidth * width, y = box.y / imageHeight * height;
        const left = Math.max(0, Math.min(x, width - bounds.width));
        // Prefer above the upper-left corner; top-edge boxes keep text inside.
        const preferred = Math.max(0, Math.min(y >= bounds.height ? y - bounds.height : y + 2, height - bounds.height));
        // Nearby detections should not hide each other's type. Confirmed labels
        // keep the closest anchor, and other labels use the nearest free row.
        const candidates = [preferred, ...placed.flatMap((rect) => [rect.top - bounds.height - 2, rect.bottom + 2])]
          .filter((top) => top >= 0 && top + bounds.height <= height)
          .sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred));
        const top = candidates.find((value) => !placed.some((rect) => left < rect.right + 2 && left + bounds.width > rect.left - 2
          && value < rect.bottom + 2 && value + bounds.height > rect.top - 2)) ?? preferred;
        node.style.left = `${left}px`; node.style.top = `${top}px`;
        placed.push({ left, top, right: left + bounds.width, bottom: top + bounds.height });
      }
      element.style.visibility = 'visible';
    };
    positionLabels();
    const observer = new ResizeObserver(positionLabels); observer.observe(element);
    return () => observer.disconnect();
  }, [signature, imageWidth, imageHeight]);
  return <div className="robot-twin-capture__image">
    <img src={asset.url} alt={`${label}拍摄图像`} onError={asset.invalidImage} />
    {boxes.length > 0 && <div ref={overlay} className="robot-twin-capture__annotations" role="list" aria-label={`${label}图像异常标注`}>
      <svg viewBox={`0 0 ${imageWidth} ${imageHeight}`} preserveAspectRatio="none" aria-hidden="true">
        {annotations.map(({ box, index }) => <rect key={index} className={isSuspectedRobotDetection(box) ? 'is-suspected' : ''}
          x={box.x} y={box.y} width={box.width} height={box.height} vectorEffect="non-scaling-stroke" />)}
      </svg>
      {annotations.map(({ box, index }) => {
        const suspected = isSuspectedRobotDetection(box), score = formatRobotDetectionConfidence(box);
        const type = typeof box.label === 'string' && box.label.trim() ? box.label.trim() : '未标注类型';
        return <span key={index} role="listitem" data-detection-index={index}
          className={`robot-twin-capture__detection-label ${suspected ? 'is-suspected' : ''}`}>
          <span className="robot-twin-capture__detection-number">{index + 1} ·</span>
          <span className="robot-twin-capture__detection-type">{suspected ? '疑似 · ' : ''}{type}</span>
          {score && <span className="robot-twin-capture__detection-score">{score}</span>}
        </span>;
      })}
    </div>}
  </div>;
}
