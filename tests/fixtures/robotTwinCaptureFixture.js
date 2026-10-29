import React from 'react';
import { createRoot } from 'react-dom/client';
import TaskMonitorConsole from "../../src/features/robot-twin/ui/TaskMonitorConsole.jsx";
import { RobotTwinCaptureCache } from "../../src/features/robot-twin/model/robotTwinCaptureCache.js";

const root = createRoot(document.getElementById('root'));
const captures = [], results = [], transfers = new Map();
let mounted = true, collapsed = false, runId = 'a'.repeat(32), latest = null;
const id = (n) => n.toString(16).padStart(32, '0');
const task = () => ({ id: runId, phase: 'running', tasks: [], taskName: '连续拍摄测试', totalPoints: 10,
  completedPoints: captures.length, completedCaptures: captures.length, skippedPoints: 0, elapsedMs: 1000 });
const monitor = () => ({ task: task(), captures: latest ? [latest] : [], results: results.filter((item) => item.captureId === latest?.id).reverse(),
  latestCapture: latest, resultsFresh: true, resultTotal: results.length });
const noop = () => {};
const fixture = window.captureFixture = { calls: [], aborted: [], urls: new Set(), decodes: [], holdDecode: false };
const createUrl = URL.createObjectURL, revokeUrl = URL.revokeObjectURL;
URL.createObjectURL = (blob) => { const url = createUrl(blob); fixture.urls.add(url); return url; };
URL.revokeObjectURL = (url) => { fixture.urls.delete(url); revokeUrl(url); };
const nativeDecode = HTMLImageElement.prototype.decode;
HTMLImageElement.prototype.decode = async function () {
  await nativeDecode.call(this);
  if (fixture.holdDecode) await new Promise((resolve) => fixture.decodes.push(resolve));
};
const cache = new RobotTwinCaptureCache({ onChange: render, request: async (path, { signal }) => {
  if (path.startsWith('/capture-history/')) {
    const [, , wantedRun, offsetText] = path.split('/'), offset = Number(offsetText);
    const all = captures.filter((item) => item.runId === wantedRun), page = all.slice(offset, offset + 8);
    return { runId: wantedRun, nextOffset: offset + page.length, total: all.length, captures: page,
      results: results.filter((item) => page.some((capture) => capture.id === item.captureId)), pending: page.some((item) => !item.sides.left.image) };
  }
  fixture.calls.push(path);
  return new Promise((resolve, reject) => {
    transfers.set(path, resolve);
    signal.addEventListener('abort', () => { fixture.aborted.push(path); reject(signal.reason); }, { once: true });
  });
} });
const readCapture = (...args) => cache.read(...args);
function render() {
  if (!mounted) { root.render(null); return; }
  root.render(React.createElement(TaskMonitorConsole, { collapsed, onCollapsedChange: (value) => { collapsed = value; render(); },
    twin: { selectedId: 'fixture', selectedRobot: { name: '测试机器人', color: '#62c7a0' },
      robots: [{ id: 'fixture', name: '测试机器人', active: true }], selectRobot: noop,
      phase: 'live', monitor: monitor(), monitorPhase: 'live', captureCache: cache, readCapture,
      camera: { phase: 'idle', cameras: [], wanted: false }, loadCameras: noop, stopCamera: noop } }));
}
fixture.add = (n, pending = false, newRun = false) => {
  if (newRun) runId = 'b'.repeat(32);
  latest = { id: id(n), runId, taskName: '连续拍摄测试', parkingName: '同一停车点', pointName: `照片 ${n}`,
    sides: Object.fromEntries(['left', 'right'].map((side) => [side, { image: !pending, cloud: false, pending,
      imageWidth: 320, imageHeight: 180, boxes: [{ label: `标注 ${n}`, x: 20, y: 30, width: 50, height: 40 }],
      state: n === 2 ? 'processing' : 'complete', detectionCount: 1, abnormal: n !== 2, severity: 'defect' }])) };
  captures.push(latest);
  for (const side of ['left', 'right']) results.push({ key: `${latest.id}:${side}`, captureId: latest.id,
    sequence: n * 2 + (side === 'right' ? 1 : 0), camera: side, received: true, state: latest.sides[side].state,
    pointName: latest.pointName, detectionCount: 1, labels: [`标注 ${n}`] });
  cache.observe(monitor()); render();
};
fixture.finish = async (n, side, corrupt = false) => {
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = ['#254f68', '#743c25', '#3a6242'][n % 3]; ctx.fillRect(0, 0, 320, 180);
  ctx.fillStyle = 'white'; ctx.font = '24px sans-serif'; ctx.fillText(`Zivid ${side} / ${n}`, 80, 100);
  const blob = corrupt ? new Blob(['corrupt png'], { type: 'image/png' }) : await new Promise((done) => canvas.toBlob(done));
  const path = `/captures/${id(n)}/${side}/png`;
  if (!transfers.has(path)) throw new Error(`Transfer has not started: ${path}`);
  transfers.get(path)({ blob }); transfers.delete(path);
};
fixture.unmount = () => { mounted = false; render(); };
fixture.mount = () => { mounted = true; render(); };
fixture.disconnect = () => { mounted = false; cache.reset(); render(); };
fixture.ready = (n, side) => cache.peek(id(n), side, 'png')?.phase === 'ready';
fixture.decodeAll = () => { fixture.holdDecode = false; fixture.decodes.splice(0).forEach((resolve) => resolve()); };
fixture.startFrames = () => {
  fixture.frames = []; fixture.sampling = true;
  const sample = () => {
    const images = [...document.querySelectorAll('.robot-twin-capture__image img')];
    fixture.frames.push(images.some((image) => image.complete && image.naturalWidth > 0));
    if (fixture.sampling) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
};
render();
