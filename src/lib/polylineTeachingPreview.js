import { Color, MathUtils } from 'three';
import { polylineVertices } from './polylineTeaching.js';
import { spatialCurveGeometry, spatialPartPoint, sampleSpatialPart } from './polylineTeachingSpatialCurve.js';

export const POLYLINE_EXECUTED_COLOR = 0xffb02e;
const colors = new Map([POLYLINE_EXECUTED_COLOR, 0x72dfb6, 0xff796b, 0x50dce6]
  .map((value) => [value, new Color(value)]));
const edgeCache = new WeakMap();

function previewEdges(path) {
  if (edgeCache.has(path)) return edgeCache.get(path);
  const vertices = polylineVertices(path);
  const edges = path.pathType === 'spline' ? spatialCurveGeometry(path).parts.flatMap((part) => {
    const points = part.arc.map(([t]) => spatialPartPoint(part, t));
    return part.arc.slice(1).map((entry, i) => ({ from: points[i], to: points[i + 1], index: part.index, part,
      begin: part.arc[i][1] / part.length, end: entry[1] / part.length }));
  }) : vertices.slice(1).map((to, index) => ({ from: vertices[index], to, index, begin: 0, end: 1 }));
  edgeCache.set(path, edges); return edges;
}

export const polylinePreviewCapacity = (path) => Math.max(1, previewEdges(path).length + 2);

// Split at the actual time-parameterized playback position, not at a waypoint
// or a nearest point in space (which is ambiguous on closed/retraced paths).
export function polylinePreviewParts(path, plan, playback = null) {
  const parts = [];
  previewEdges(path).forEach(({ from, to, index, part, begin, end: edgeEnd }) => {
    const executableEnd = plan?.partial ? index < plan.stoppedAt.segmentIndex ? 1
      : index === plan.stoppedAt.segmentIndex ? plan.stoppedAt.progress : 0 : 1;
    const completedEnd = playback?.drawing ? Math.min(executableEnd, index < playback.segmentIndex ? 1
      : index === playback.segmentIndex ? MathUtils.clamp(playback.segmentProgress, 0, 1) : 0) : 0;
    // Reserve orange for the completed portion, including within one edge.
    // Advisory surface warnings remain in the panel; coloring the whole edge
    // orange made untouched sections appear already drawn at the start.
    const pendingColor = plan?.partial ? 0x72dfb6 : plan?.issue?.segmentIndex === index ? 0xff796b : 0x50dce6;
    const add = (start, end, color, completed = false) => {
      start = Math.max(start, begin); end = Math.min(end, edgeEnd);
      if (end <= start) return;
      const a = start === begin ? from : part ? sampleSpatialPart(part, start) : from.clone().lerp(to, start);
      const b = end === edgeEnd ? to : part ? sampleSpatialPart(part, end) : from.clone().lerp(to, end);
      if (a.distanceToSquared(b) < 1e-12) return;
      parts.push({ from: a, to: b, color, completed, segmentIndex: index, length: part ? part.length * (end - start) : a.distanceTo(b) });
    };
    add(0, completedEnd, POLYLINE_EXECUTED_COLOR, true);
    add(completedEnd, executableEnd, pendingColor);
    add(executableEnd, 1, 0xff796b);
  });
  // Completed strokes stay visible at crossings and over retraced segments.
  return parts.sort((a, b) => Number(a.completed) - Number(b.completed));
}

// Reuse the allocated GPU attributes while playing; toggling the preview or
// replanning can rebuild the layer without losing the current progress.
export function writePolylinePreview(geometry, parts) {
  const { instanceStart, instanceEnd, instanceColorStart, instanceColorEnd } = geometry.attributes;
  parts.forEach((part, index) => {
    instanceStart.setXYZ(index, part.from.x, part.from.y, part.from.z);
    instanceEnd.setXYZ(index, part.to.x, part.to.y, part.to.z);
    const color = colors.get(part.color);
    instanceColorStart.setXYZ(index, color.r, color.g, color.b);
    instanceColorEnd.setXYZ(index, color.r, color.g, color.b);
  });
  instanceStart.data.needsUpdate = true;
  instanceColorStart.data.needsUpdate = true;
  geometry.instanceCount = parts.length;
}
