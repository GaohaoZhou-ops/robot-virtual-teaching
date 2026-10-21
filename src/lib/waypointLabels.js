import { TEACHING_WAYPOINT_SOURCE, TEMPORARY_MAP_ROUTE_SOURCE, waypointRobotPose } from './teachingNavigation.js';

// Display-only allowance for small base/registration shifts. Navigation and
// robot export continue to use their own strict station matching rules.
const LABEL_STATION_DISTANCE = 0.05;
const isParking = (point) => point.source === TEACHING_WAYPOINT_SOURCE
  || (point.source === TEMPORARY_MAP_ROUTE_SOURCE && point.sourceWaypointSource === TEACHING_WAYPOINT_SOURCE);

function stationName(point) {
  const name = String(point.name || '').trim();
  const match = /^N(0|[1-9]\d*)(?:\s*·\s*|$)/.exec(name);
  return { node: Number.isInteger(point.abx?.nodeId) ? String(point.abx.nodeId) : match?.[1],
    label: match ? name.slice(match[0].length).trim() : name };
}

function sameStation(anchor, point) {
  const a = stationName(anchor), b = stationName(point);
  if (a.node !== undefined && b.node !== undefined) {
    if (a.node !== b.node) return false;
  } else if (!a.label || a.label !== b.label) return false;
  const target = waypointRobotPose(anchor, point.pose.z);
  return Boolean(target && Math.hypot(target.position.x - point.pose.x,
    target.position.y - point.pose.y) <= LABEL_STATION_DISTANCE);
}

// Keep all navigation points, hit targets and teaching records intact. Only
// their 3D name overlays share a representative and selection membership.
export function buildWaypointLabels(waypoints) {
  const labels = waypoints.filter((point) => !isParking(point))
    .map((point) => ({ point, waypointIds: [point.id] }));
  const byId = new Map(labels.map((label) => [label.point.id, label]));
  const merged = new Set();
  for (const label of labels) {
    const point = label.point;
    if (point.source !== TEMPORARY_MAP_ROUTE_SOURCE) continue;
    // Extracted local graphs may already contain this exact source waypoint.
    const original = byId.get(point.sourceWaypointId);
    if (original && original !== label && !merged.has(original) && sameStation(point, original.point)) {
      original.waypointIds.push(...label.waypointIds);
      merged.add(label);
    }
  }
  const anchors = labels.filter((label) => !merged.has(label));
  const unmatched = [];
  for (const point of waypoints.filter(isParking)) {
    const candidates = anchors.filter((label) => sameStation(label.point, point));
    // Repeated names/numbers in separate routes are not enough to prove a link.
    if (candidates.length === 1) candidates[0].waypointIds.push(point.id);
    else unmatched.push({ point, waypointIds: [point.id] });
  }
  return [...anchors, ...unmatched];
}
