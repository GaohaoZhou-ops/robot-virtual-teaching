import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { BODY_CAMERAS } from '../../src/lib/robotTwinCamera.js';

export const FAKE_ROBOT_SERVICE = 'atlas-fake-robot';
const JOINT_NAMES = ['ankle_pitch_J', 'knee_pitch_J', 'waist_pitch_J', 'waist_yaw_J', 'head_yaw_J', 'head_pitch_J',
  ...['left', 'right'].flatMap((side) => Array.from({ length: 7 }, (_, i) => `${side}_J${i + 1}`))];
const WIDTH = 480, HEIGHT = 270, FPS = 6;
const FONT = Object.fromEntries(Object.entries({
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '101111111111101', O: '010101101101010',
  P: '110101110100100', Q: '010101101111011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010', Z: '111001010100111',
  0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110', 4: '101101111001001',
  5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111', 9: '111101111001110',
  '-': '000000111000000', '.': '000000000000010', ':': '000010000010000', ' ': '000000000000000',
}).map(([key, value]) => [key, [...value].map(Number)]));

// Synthetic test cards are encoded on demand; there is no camera/hardware access.
function cameraPixels(camera, sequence, captureSide = null) {
  const data = Buffer.alloc(WIDTH * HEIGHT * 4);
  function rect(x, y, w, h, color) {
    for (let row = Math.max(0, Math.floor(y)); row < Math.min(HEIGHT, Math.floor(y + h)); row++) {
      for (let col = Math.max(0, Math.floor(x)); col < Math.min(WIDTH, Math.floor(x + w)); col++) {
        const offset = (row * WIDTH + col) * 4;
        data[offset] = color[0]; data[offset + 1] = color[1]; data[offset + 2] = color[2]; data[offset + 3] = 255;
      }
    }
  }
  function text(value, x, y, scale = 3, color = [221, 243, 235]) {
    [...value].forEach((letter, i) => (FONT[letter] || FONT[' ']).forEach((bit, index) => {
      if (bit) rect(x + (i * 4 + index % 3) * scale, y + Math.floor(index / 3) * scale, scale, scale, color);
    }));
  }
  const index = Object.keys(BODY_CAMERAS).indexOf(camera);
  const palette = [[21, 62, 53], [22, 49, 71], [60, 46, 34], [34, 43, 65], [48, 35, 63], [26, 55, 63]][index];
  rect(0, 0, WIDTH, HEIGHT, palette);
  for (let x = 0; x < WIDTH; x += 32) rect(x, 60, 1, HEIGHT - 60, [66, 91, 91]);
  for (let y = 60; y < HEIGHT; y += 30) rect(0, y, WIDTH, 1, [66, 91, 91]);
  const x = captureSide ? 110 : 60 + (Math.sin(sequence / 15 + index) + 1) * 135;
  const y = captureSide ? 90 : 110 + Math.cos(sequence / 19 + index) * 25;
  rect(x, y, 80, 58, [141, 219, 179]); rect(x + 3, y + 3, 74, 52, palette);
  rect(0, 0, WIDTH, 54, [12, 25, 29]); rect(0, 231, WIDTH, 39, [12, 25, 29]);
  text(captureSide ? 'SIMULATED ZIVID' : 'SIMULATED CAMERA', 16, 11, 3);
  text(captureSide ? `${captureSide.toUpperCase()} CAPTURE` : camera.toUpperCase(), 16, 35, 2);
  text(`${captureSide ? 'SHOT' : 'FRAME'} ${sequence}`, 16, 244, 2);
  if (!captureSide) text('6 FPS', 395, 244, 2);
  rect(12, 219, (sequence % 60) / 60 * 456, 4, [141, 219, 179]);
  return { data, width: WIDTH, height: HEIGHT };
}
const cameraFrame = (camera, sequence) => jpeg.encode(cameraPixels(camera, sequence), 65).data;

function inspectionBoxes(point, side) {
  if (side === 'left' || point === 0) return [];
  const box = { label: '模拟表面划痕', confidence: point === 2 ? 0.6 : 0.93,
    confidence_threshold: 0.7, x: 110, y: 90, width: 90, height: 30 };
  return point === 3 ? [box, { ...box, label: '模拟表面凹痕', confidence: 0.62, x: 170, y: 100, width: 80, height: 40 }] : [box];
}

function captureCloud(side, point) {
  const width = WIDTH / 2, height = HEIGHT / 2, bytes = Buffer.alloc(16 + width * height * 12);
  bytes.write('ABXXYZ1\0', 0, 'ascii'); bytes.writeUInt32LE(width, 8); bytes.writeUInt32LE(height, 12);
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    const offset = 16 + (row * width + col) * 12;
    const defect = side === 'right' && point % 2 && col >= 55 && col < 100 && row >= 45 && row < 60;
    bytes.writeFloatLE((col - width / 2) * 1.8, offset);
    bytes.writeFloatLE((row - height / 2) * 1.8, offset + 4);
    bytes.writeFloatLE(650 + 45 * Math.sin(col / 35) + 20 * Math.cos(row / 20) + (side === 'right' ? 15 : 0) - (defect ? 25 : 0), offset + 8);
  }
  return bytes;
}

const failure = (status, message) => { throw Object.assign(new Error(message), { status }); };
const id = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const send = (res, status, value, headers = {}) => {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length,
    'Cache-Control': 'no-store', ...headers }); res.end(data);
};
async function form(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) failure(413, '模拟接口参数过大');
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

export function createFakeRobotServer({ password = 'admin', speed = 1, instance = randomBytes(16).toString('hex'),
  clock = () => performance.now() } = {}) {
  const started = clock(), epoch = Date.now(), sessions = new Map(), leases = new Map();
  const frames = new Map(), savedMedia = new Map(), requests = {};
  const seconds = () => Math.max(0, (clock() - started) / 1000 * speed);
  const runId = (cycle) => id(`${instance}:run:${cycle}`);
  const captureId = (cycle, point) => id(`${instance}:capture:${cycle}:${point}`);
  const phase = (t) => t < 40 ? 'running' : t < 50 ? 'succeeded' : 'idle';
  function captures(cycle, elapsed) {
    return Array.from({ length: 4 }, (_, point) => point)
      .filter((point) => elapsed >= cycle * 60 + point * 10 + 7)
      .flatMap((point) => ['left', 'right'].map((side, index) => ({ id: captureId(cycle, point), side, sequence: point * 2 + index + 1,
        task_name: `模拟巡检任务 · 第 ${cycle + 1} 轮`, parking_name: `模拟工位 ${point + 1}`, point_name: `模拟检测点 ${point + 1}` })));
  }
  function current(elapsed) {
    const cycle = Math.floor(elapsed / 60), t = elapsed % 60, point = Math.min(3, Math.floor(t / 10));
    const stage = t >= 40 ? 'complete' : t % 10 < 6 ? 'navigation' : t % 10 < 8 ? 'capture' : 'inspection';
    return { cycle, t, run: { id: runId(cycle), phase: phase(t), task_name: `模拟巡检任务 · 第 ${cycle + 1} 轮`,
      parking_name: `模拟工位 ${point + 1}`, point_name: `模拟检测点 ${point + 1}`, stage, task_index: 0,
      message: { navigation: '模拟移动到检测点', capture: '模拟图像采集', inspection: '模拟算法处理', complete: '模拟巡检已完成' }[stage],
      completed_points: Math.min(4, Math.floor(t / 10)), completed_captures: captures(cycle, elapsed).length,
      elapsed_ms: Math.min(t, 40) * 1000, started_ms: epoch + cycle * 60000 / speed,
      algorithm_mode: 'execute', algorithm_state: stage === 'inspection' ? 'processing' : 'complete',
      summary: { point_count: 4, tasks: [{ name: '模拟巡检任务', point_count: 4 }] }, simulated: true } };
  }
  function prune() {
    const time = clock();
    for (const [key, session] of sessions) if (time - session.touched > 3600_000) sessions.delete(key);
    for (const [key, lease] of leases) {
      if (time - lease.touched > 5000) lease.camera = null;
      if (time - lease.touched > 60_000) leases.delete(key);
    }
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1'), path = url.pathname;
      requests[`${req.method} ${path}`] = (requests[`${req.method} ${path}`] || 0) + 1;
      prune();
      if (req.method === 'GET' && ['/', '/__fake_robot/status'].includes(path)) {
        send(res, 200, { service: FAKE_ROBOT_SERVICE, simulated: true, instance, pid: process.pid,
          uptimeSeconds: Math.floor((clock() - started) / 1000), speed,
          activeCamera: [...leases.values()].find((item) => item.camera)?.camera || null, requests }); return;
      }
      if (path === '/api/v1/access/login' && req.method === 'POST') {
        const fields = await form(req);
        if (fields.role !== 'admin' || fields.password !== password) failure(401, '模拟机器人管理员密码错误');
        if (sessions.size >= 64) failure(429, '模拟机器人登录会话过多，请稍后重试或重启脚本');
        const cookie = randomBytes(32).toString('hex');
        sessions.set(cookie, { token: randomBytes(32).toString('hex'), touched: clock() });
        send(res, 200, { ok: true, simulated: true }, { 'Set-Cookie': `fake_abx_access=${cookie}; HttpOnly; SameSite=Strict; Path=/` }); return;
      }
      const getPaths = ['/api/v1/control-session', '/api/v1/model', '/api/v1/slam', '/api/v1/state',
        '/api/v1/body-cameras', '/api/v1/execution/activity', '/api/v1/execution', '/api/v1/execution/captures'];
      const resultPath = /^\/api\/v1\/cameras\/jobs\/([a-f0-9]{32})(?:\/(left|right)\/(png|xyzbin))?$/.exec(path);
      const preview = ['/api/v1/body-cameras/preview', '/api/v1/body-cameras/frame'].includes(path);
      if (!(req.method === 'GET' && (getPaths.includes(path) || resultPath)) && !(req.method === 'POST' && preview)) {
        failure(405, '模拟机器人仅提供状态、鉴权与合成画面，不提供运动控制接口');
      }
      const cookie = /(?:^|;\s*)fake_abx_access=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const session = sessions.get(cookie);
      if (!session) failure(401, '请登录模拟机器人');
      session.touched = clock();
      if (path === '/api/v1/control-session') { send(res, 200, { token: session.token }); return; }
      if (req.headers['x-abx-control-token'] !== session.token) failure(403, '模拟机器人会话凭据无效');
      const elapsed = seconds(), { cycle, t, run } = current(elapsed);
      if (path === '/api/v1/model') {
        send(res, 200, { name: 'botx_abx_zivid_m70 (模拟机器人)', joint_names_sdk_order: JOINT_NAMES, simulated: true });
      } else if (path === '/api/v1/slam') {
        const angle = elapsed * Math.PI * 2 / 90;
        // The production reader requires this native source name. The extra
        // simulated flag, model/task names and frames identify this test service.
        send(res, 200, { fresh: true, age_ms: 0, simulated: true, sample: { ok: true, source: 'slam_websocket',
          scene: { mode: 'kLocalization', operation_running: false },
          pose: { x_m: 1.5 * Math.sin(angle), y_m: 1.5 * (1 - Math.cos(angle)), yaw_rad: Math.atan2(Math.sin(angle), Math.cos(angle)) } } });
      } else if (path === '/api/v1/state') {
        let offset = 0;
        const samples = Object.fromEntries([['torso', 4], ['head', 2], ['left_arm', 7], ['right_arm', 7]].map(([group, count]) =>
          [group, Array.from({ length: count }, () => {
            const index = offset++;
            return { valid: true, fresh: true, position_rad: (index < 3 ? 0.025 : 0.2) * Math.sin(elapsed * 0.5 + index * 0.4) };
          })]));
        send(res, 200, { simulated: true, robot: { valid: true, state_fresh: true, health_fresh: true, state_age_ms: 0, joint_samples: samples } });
      } else if (path === '/api/v1/execution/activity') {
        send(res, 200, { ok: true, task_phase: phase(t), navigation_phase: run.stage === 'navigation' ? 'running' : 'idle' });
      } else if (path === '/api/v1/execution') {
        send(res, 200, { ok: true, run: phase(t) === 'idle' ? null : run });
      } else if (path === '/api/v1/execution/captures') {
        const requested = url.searchParams.get('run_id'), offset = Number(url.searchParams.get('offset'));
        const target = [cycle, cycle - 1, cycle - 2].find((value) => value >= 0 && runId(value) === requested);
        if (target === undefined || !Number.isSafeInteger(offset) || offset < 0) failure(404, '模拟采集记录不存在');
        const records = captures(target, elapsed);
        send(res, 200, { ok: true, run_id: requested, total: records.length, next_offset: records.length, captures: records.slice(offset) });
      } else if (resultPath) {
        let target;
        for (const value of [cycle, cycle - 1, cycle - 2].filter((value) => value >= 0)) {
          const record = captures(value, elapsed).find((item) => item.id === resultPath[1]);
          if (record) target = { cycle: value, point: Math.floor((record.sequence - 1) / 2) };
        }
        if (!target) failure(404, '模拟算法结果不存在');
        const processing = elapsed < target.cycle * 60 + target.point * 10 + 9;
        const state = processing ? 'processing' : 'complete';
        if (resultPath[2]) {
          const [, capture, side, kind] = resultPath, key = `${capture}/${side}/${kind}`;
          for (const [savedKey, media] of savedMedia) if (media.cycle < cycle - 2) savedMedia.delete(savedKey);
          if (!savedMedia.has(key)) savedMedia.set(key, { cycle: target.cycle,
            bytes: kind === 'xyzbin' ? captureCloud(side, target.point) : PNG.sync.write(cameraPixels(side === 'left' ? 'head-left' : 'head-right', target.cycle * 4 + target.point + 1, side)) });
          send(res, 200, savedMedia.get(key).bytes, { 'Content-Type': kind === 'png' ? 'image/png' : 'application/octet-stream' });
        } else send(res, 200, { job: { id: resultPath[1], state: 'complete',
          created_utc: new Date(epoch + (target.cycle * 60 + target.point * 10 + 7) * 1000 / speed).toISOString(),
          cameras: Object.fromEntries(['left', 'right'].map((side) => [side, {
            files: ['png', 'xyzbin'].map((kind) => ({ kind, url: `/api/v1/cameras/jobs/${resultPath[1]}/${side}/${kind}`, name: `${side}.${kind}` })),
            pixel_mapping: { available: true, kind: 'organized-pixels', source: 'mock-stride-2',
              image_width: WIDTH, image_height: HEIGHT, cloud_width: WIDTH / 2, cloud_height: HEIGHT / 2,
              step_x: 2, step_y: 2, offset_x: 0, offset_y: 0 },
            inspection: { state, simulated: true, image_width: WIDTH, image_height: HEIGHT,
              boxes: processing ? [] : inspectionBoxes(target.point, side) },
          }])) } });
      } else if (path === '/api/v1/body-cameras') {
        send(res, 200, { ok: true, preview_fps: FPS, cameras: Object.entries(BODY_CAMERAS).map(([key, label]) => ({ id: key, label, available: true })) });
      } else if (preview) {
        const fields = await form(req), generation = Number(fields.generation);
        if (!/^[a-f0-9]{32}$/.test(fields.client || '') || !Number.isSafeInteger(generation) || generation < 1) failure(400, '模拟预览订阅参数无效');
        const key = `${cookie}:${fields.client}`, previous = leases.get(key);
        if (generation < (previous?.generation || 0)) failure(409, '模拟预览订阅已过期');
        if (path.endsWith('/preview')) {
          if (!['0', '1'].includes(fields.enabled) || (fields.enabled === '1' && !Object.hasOwn(BODY_CAMERAS, fields.camera))) failure(400, '请选择本体相机');
          const camera = fields.enabled === '1' ? fields.camera : null;
          if (camera && [...leases.entries()].some(([otherKey, item]) => otherKey !== key && item.camera && item.camera !== camera)) failure(409, '另一订阅正在使用其他本体相机');
          leases.set(key, { generation, camera, touched: clock() }); send(res, 200, { ok: true });
        } else {
          if (!previous?.camera || generation !== previous.generation) failure(409, '请先开启模拟画面');
          previous.touched = clock();
          const sequence = Math.floor((clock() - started) / 1000 * FPS), camera = previous.camera;
          if (frames.get(camera)?.sequence !== sequence) frames.set(camera, { sequence, bytes: cameraFrame(camera, sequence) });
          send(res, 200, frames.get(camera).bytes, { 'Content-Type': 'image/jpeg', 'X-ABX-Sequence': String(sequence),
            'X-ABX-Preview-Width': String(WIDTH), 'X-ABX-Preview-Height': String(HEIGHT) });
        }
      }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(res, error.status || 500, { error: error.status ? error.message : '模拟机器人内部错误' });
      if (!error.status) console.error(error);
    }
  });
  server.requestTimeout = 5000;
  return server;
}
