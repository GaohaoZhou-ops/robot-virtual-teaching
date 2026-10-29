import assert from 'node:assert/strict';
import { explainPolylineSearch } from "../src/features/teaching/polyline/model/polylineTeachingExplanation.js";

const path = { side: 'right', tcpOffset: [.01, 0, -.2], base: { allowPartial: true },
  points: [{ position: [.9, 0, .7] }, { position: [1, 0, .7] }] };
const collision = { environmentLinks: ['probe_link'], environmentIntersectingLinks: [],
  environmentClearanceLinks: ['probe_link'], environmentMargin: .008, selfPairs: [], groundLinks: [] };
const originalIssue = { phase: 'approach', segmentIndex: -1, progress: .8, distanceFromStart: .4786,
  message: '机器人碰撞体的 8 mm 预留区与模型相交：probe_link', collision };
const search = { lastStage: 'deep', quickAttempts: 35, deepAttempts: 42, guideAttempts: 2,
  elapsedMs: 19000, deepBudgetMs: 15000, stopReason: 'time-budget', originalIssue };
const failed = { complete: false, executable: false, issue: originalIssue, approachSearch: search };
const before = structuredClone({ path, failed });
const timed = explainPolylineSearch(failed, path, { waistAvailable: true });
assert.match(timed.location, /478.6 mm/);
assert.match(timed.details.join(' '), /8.0 mm/);
assert.match(timed.details.join(' '), /碰撞体本身未检出与工件重叠/);
assert.match(timed.details.join(' '), /初次直线/);
assert.match(timed.stop, /15.0 s.*未完成检查/);
assert.match(timed.countNote, /被时限中断/);
assert.match(timed.partialNote, /需先到达 P0/);
assert.ok(timed.suggestions.some(({ title }) => title.includes('腰部')));
assert.ok(!explainPolylineSearch(failed, path).suggestions.some(({ title }) => title.includes('腰部')), 'do not suggest an unavailable waist');
assert.deepEqual({ path, failed }, before, 'opening an explanation cannot change inputs or the planning result');

const overlap = explainPolylineSearch({ ...failed, issue: { ...originalIssue,
  collision: { ...collision, environmentIntersectingLinks: ['probe_link'], environmentClearanceLinks: [],
    selfPairs: [['arm_link', 'waist_link']], groundLinks: ['elbow_link'] } },
approachSearch: { ...search, stopReason: 'candidate-limit' } }, { ...path, base: { waistAssist: true } }, { waistAvailable: true });
assert.ok(overlap.details.some((text) => text.includes('发生重叠')));
assert.ok(overlap.details.some((text) => text.includes('arm_link ↔ waist_link')));
assert.ok(overlap.details.some((text) => text.includes('低于当前支撑平面')));
assert.ok(!overlap.details.some((text) => text.includes('本身未检出')), 'physical overlap cannot be described as clearance only');
assert.ok(!overlap.suggestions.some(({ title }) => title.includes('开启“腰部')));
assert.match(overlap.stop, /数量上限/);

const drawing = explainPolylineSearch({ ...failed, issue: { phase: 'drawing', segmentIndex: 0, progress: .4,
  code: 'continuous-ik', message: '连续逆解失败', positionError: .002, rotationError: 1.2 },
approachSearch: { ...search, stopReason: 'exhausted', reachedStart: true } }, { ...path, base: { allowPartial: false } });
assert.match(drawing.location, /P0 → P1.*40.0%/);
assert.match(drawing.summary, /已有接近路线验证到达 P0/);
assert.match(drawing.original, /478.6 mm/);
assert.match(drawing.details.join(' '), /2.0 mm.*1.20°/);
assert.equal(drawing.partialNote, null);
assert.ok(drawing.suggestions.some(({ title }) => title.includes('最大保障')));
assert.match(drawing.stop, /候选方案已检查完/);
assert.doesNotMatch(drawing.details.join(' '), /probe_link/, 'the old straight collision is not the current drawing failure');
console.log('Polyline search explanation: clearance versus overlap, timeout/count limits, original versus drawing failures, conditional advice, unit conversion and unchanged inputs passed.');
