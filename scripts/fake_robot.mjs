#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isIP } from 'node:net';
import { createFakeRobotServer, FAKE_ROBOT_SERVICE } from './lib/fake_robot_server.mjs';

const script = fileURLToPath(import.meta.url), root = resolve(dirname(script), '..');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const help = `本地模拟机器人（不访问或控制任何真实硬件）
用法：
  ./scripts/fake_robot.mjs start [--port 9090] [--host 127.0.0.1] [--speed 1]
  ./scripts/fake_robot.mjs stop [--port 9090]
  ./scripts/fake_robot.mjs status [--port 9090]

默认管理员密码：admin；可通过 FAKE_ROBOT_PASSWORD 环境变量设置后再 start。
start 在后台运行，重复启动不会创建第二个进程；stop 只停止该端口的模拟服务。
--speed 调整定位、关节和任务演示速度（0.1～20）；相机保持约 6 帧/秒。
默认只监听本机。局域网其他工作台需要直连时可使用 --host 0.0.0.0。
卡片地址填 127.0.0.1:9090（工作台代理所在电脑），并加载 botx_abx_zivid_m70 模型。`;

function parse() {
  const [action = 'help', ...args] = process.argv.slice(2);
  const config = { action, port: 9090, host: '127.0.0.1', speed: 1 };
  if (['help', '--help', '-h'].includes(action)) return { ...config, action: 'help' };
  if (!['start', 'stop', 'status', 'serve'].includes(action)) throw new Error('请选择 start、stop 或 status；使用 --help 查看用法。');
  while (args.length) {
    const option = args.shift(), value = args.shift();
    if (!['--port', '--host', '--speed', ...(action === 'serve' ? ['--instance'] : [])].includes(option) || value === undefined) throw new Error(`未知或不完整参数：${option}`);
    config[option.slice(2)] = ['--port', '--speed'].includes(option) ? Number(value) : value;
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('端口应为 1～65535 的整数');
  if (isIP(config.host) !== 4) throw new Error('监听地址应为 IPv4，例如 127.0.0.1 或 0.0.0.0');
  if (!Number.isFinite(config.speed) || config.speed < 0.1 || config.speed > 20) throw new Error('演示速度应为 0.1～20');
  if (action === 'serve' && !/^[a-f0-9]{32}$/.test(config.instance || '')) throw new Error('请使用 start 启动模拟机器人');
  return config;
}

function read(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function remove(path) { try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
function running(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function belongsToUs(state) {
  if (!Number.isSafeInteger(state?.pid) || state.pid <= 1 || !/^[a-f0-9]{32}$/.test(state.instance || '')) return false;
  try {
    const command = execFileSync('ps', ['-p', String(state.pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return command.includes(script) && command.includes(' serve ') && command.includes(`--instance ${state.instance}`);
  } catch { return false; }
}
const address = (state) => `${state.host === '0.0.0.0' ? '127.0.0.1' : state.host}:${state.port}`;
async function probe(state) {
  if (!state) return null;
  try {
    const response = await fetch(`http://${address(state)}/__fake_robot/status`, { signal: AbortSignal.timeout(1000) });
    const value = await response.json();
    return response.ok && value.service === FAKE_ROBOT_SERVICE && value.instance === state.instance && value.pid === state.pid ? value : null;
  } catch { return null; }
}

async function main() {
  const config = parse();
  if (config.action === 'help') { console.log(help); return; }
  if (['start', 'serve'].includes(config.action) && process.env.FAKE_ROBOT_PASSWORD === '') throw new Error('FAKE_ROBOT_PASSWORD 不能为空');
  const runtime = resolve(root, '.atlas-cache/fake-robot'); mkdirSync(runtime, { recursive: true });
  const pidFile = resolve(runtime, `${config.port}.pid`), logFile = resolve(runtime, `${config.port}.log`), lockFile = `${pidFile}.lock`;
  if (config.action === 'serve') {
    const server = createFakeRobotServer({ password: process.env.FAKE_ROBOT_PASSWORD ?? 'admin', speed: config.speed, instance: config.instance });
    const cleanup = () => { if (read(pidFile)?.instance === config.instance) remove(pidFile); };
    process.once('exit', cleanup);
    const stop = () => { server.close(() => process.exit(0)); server.closeAllConnections(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    server.once('error', (error) => {
      const message = error.code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用，请使用 --port 指定其他端口` : error.message;
      console.error(message); process.send?.({ error: message }); process.exitCode = 1;
    });
    server.listen(config.port, config.host, () => {
      const state = { pid: process.pid, port: config.port, host: config.host, instance: config.instance };
      writeFileSync(pidFile, JSON.stringify(state), { mode: 0o600 });
      console.log(`${new Date().toISOString()} 模拟机器人启动 ${config.host}:${config.port}`);
      process.send?.({ ready: true });
    });
    return;
  }
  if (config.action === 'status') {
    const state = read(pidFile), status = await probe(state);
    console.log(status ? `模拟机器人运行中：${address(state)} (PID ${state.pid})，已运行 ${status.uptimeSeconds} 秒，当前相机：${status.activeCamera || '关闭'}`
      : belongsToUs(state) ? '模拟进程存在，但接口暂未响应' : `模拟机器人未运行（端口 ${config.port}）`);
    return;
  }
  // Serialize start/stop, recovering a lock left by an interrupted CLI process.
  if (existsSync(lockFile)) {
    const lock = read(lockFile);
    if (Number.isSafeInteger(lock?.pid) && lock.pid > 1 && !running(lock.pid)) remove(lockFile);
  }
  let lock;
  try { lock = openSync(lockFile, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('另一个启动或停止命令正在执行，请稍后重试'); throw error; }
  writeFileSync(lock, JSON.stringify({ pid: process.pid })); closeSync(lock);
  try {
    const existing = read(pidFile);
    if (config.action === 'stop') {
      if (!belongsToUs(existing)) { remove(pidFile); console.log(`模拟机器人未运行（端口 ${config.port}）`); return; }
      process.kill(existing.pid, 'SIGTERM');
      for (let i = 0; i < 50; i++) {
        if (!existsSync(pidFile) || !belongsToUs(existing)) { remove(pidFile); console.log(`模拟机器人已停止（端口 ${config.port}）`); return; }
        await delay(100);
      }
      throw new Error('模拟进程未能及时停止，请检查日志后重试');
    }
    if (belongsToUs(existing)) {
      if (!await probe(existing)) throw new Error('已有模拟进程尚未响应，请先执行 stop 后重试');
      console.log(`模拟机器人已经运行：${address(existing)} (PID ${existing.pid})`); return;
    }
    remove(pidFile);
    const instance = randomBytes(16).toString('hex'), log = openSync(logFile, 'a', 0o600);
    const child = spawn(process.execPath, [script, 'serve', '--host', config.host, '--port', String(config.port), '--speed', String(config.speed), '--instance', instance],
      { cwd: root, detached: true, stdio: ['ignore', log, log, 'ipc'], env: process.env });
    closeSync(log);
    try {
      await new Promise((done, reject) => {
        const timeout = setTimeout(() => reject(new Error(`启动超时，请查看 ${logFile}`)), 7000);
        const settle = (error) => { clearTimeout(timeout); error ? reject(error) : done(); };
        child.once('error', settle);
        child.once('exit', (code) => settle(new Error(`模拟服务启动失败（${code}），请查看 ${logFile}`)));
        child.once('message', (message) => settle(message.ready ? null : new Error(message.error || '模拟服务启动失败')));
      });
      child.disconnect(); child.unref();
      console.log(`模拟机器人已启动：${address(config)} (PID ${child.pid})\n管理员密码：${process.env.FAKE_ROBOT_PASSWORD === undefined ? 'admin' : '使用 FAKE_ROBOT_PASSWORD 设置的值'}\n日志：${logFile}`);
    } catch (error) { child.kill('SIGTERM'); if (child.connected) child.disconnect(); child.unref(); throw error; }
  } finally { remove(lockFile); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
