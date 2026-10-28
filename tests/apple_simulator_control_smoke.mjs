import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'atlas-simulator-control-test-')));
const repo = path.join(temporary, 'project with spaces');
const bin = path.join(temporary, 'bin');
const calls = path.join(temporary, 'calls.jsonl');
const stateFile = path.join(temporary, 'state.json');
const source = fileURLToPath(new URL('../scripts/', import.meta.url));
const families = [
  { key: 'iphone', runtime: 'iOS', type: 'iPhone-17-Pro', bundle: 'com.atlasroute.teaching' },
  { key: 'ipad', runtime: 'iOS', type: 'iPad-Pro-13-inch-M5-12GB', bundle: 'com.atlasroute.teaching' },
  { key: 'vision', runtime: 'xrOS', type: 'Apple-Vision-Pro', bundle: 'com.atlasroute.teaching.vision' },
];
const environment = {
  ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, DEVELOPER_DIR: '',
  IPHONE_SIMULATOR_ID: '', IPAD_SIMULATOR_ID: '', VISION_SIMULATOR_ID: '',
  ATLAS_CONTROL_TEST_CALLS: calls, ATLAS_CONTROL_TEST_STATE: stateFile,
};
const invoke = (key, args, extra = {}) =>
  spawnSync('bash', [path.join(repo, 'scripts', `run-${key}-simulator.sh`), ...args], {
    cwd: temporary, env: { ...environment, ...extra }, encoding: 'utf8', timeout: 15000,
  });
const readState = async () => JSON.parse(await readFile(stateFile, 'utf8'));
const writeState = state => writeFile(stateFile, JSON.stringify(state));
const readCalls = async () => (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const resetCalls = () => writeFile(calls, '');
const device = (family, udid, state = 'Shutdown') => ({
  udid, name: `Renamed ${udid}`, state, isAvailable: true,
  deviceTypeIdentifier: `com.apple.CoreSimulator.SimDeviceType.${family.type}`,
});
const devices = state => Object.values(state.devices).flat();
const readOnly = records => assert.ok(records.every(record => record.command === 'xcrun' && (
  record.args.join(' ') === 'simctl list devices available -j' ||
  (record.args[1] === 'spawn' && record.args.slice(3).join(' ') === 'launchctl list')
)), 'status must only query device and process state');
let concurrent;
let firstExit;
try {
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'package.json'), '{"type":"commonjs"}\n');
  for (const file of ['lib/apple_simulator.py', ...families.flatMap(({ key }) => [
    `lib/${key}_simulator.py`, `run-${key}-simulator.sh`,
  ])]) {
    const destination = path.join(repo, 'scripts', file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(source, file), destination);
    await chmod(destination, 0o755);
  }
  // Model the device lifecycle; no real simulator or application is touched.
  const fakeTool = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const command = path.basename(process.argv[1]), args = process.argv.slice(2), env = process.env;
fs.appendFileSync(env.ATLAS_CONTROL_TEST_CALLS, JSON.stringify({ command, args, cwd: process.cwd() }) + '\\n');
if (command === 'xcode-select') { console.log('/Applications/Xcode Test.app/Contents/Developer'); process.exit(0); }
if (command === 'open') process.exit(0);
if (command !== 'xcrun') { console.error('Unexpected tool: ' + command); process.exit(99); }
const action = args[1], state = JSON.parse(fs.readFileSync(env.ATLAS_CONTROL_TEST_STATE, 'utf8'));
if (action === env.ATLAS_CONTROL_TEST_FAIL) { console.error('fixture failure'); process.exit(7); }
if (action === 'list') { console.log(JSON.stringify({ devices: state.devices })); process.exit(0); }
const device = Object.values(state.devices).flat().find(item => item.udid === args[2]);
if (!device) { console.error('Unexpected device: ' + args[2]); process.exit(98); }
if (action === 'get_app_container') process.exit(0);
if (action === 'spawn') {
  if (device.state !== 'Booted' || args.slice(3).join(' ') !== 'launchctl list') process.exit(97);
  const bundle = state.bundle;
  console.log('PID\\tStatus\\tLabel');
  console.log('17\\t0\\tUIKitApplication:' + bundle + '.widget[fixture]');
  console.log('18\\t0\\tUIKitApplication:' + bundle + '.vision[fixture]');
  console.log('19\\t0\\tUIKitApplication:' + bundle.replaceAll('.', 'x') + '[fixture]');
  console.log((device.appRunning ? '4321' : '-') + '\\t0\\tUIKitApplication:' + bundle + '[fixture][rb-legacy]');
  process.exit(0);
}
if (action === 'bootstatus') device.state = 'Booted';
else if (action === 'launch') {
  if (device.state !== 'Booted' || args[3] !== state.bundle) process.exit(96);
  device.appRunning = true;
} else if (action === 'shutdown') {
  if (env.ATLAS_CONTROL_TEST_GATE) {
    while (!fs.existsSync(env.ATLAS_CONTROL_TEST_GATE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  device.state = 'Shutdown'; device.appRunning = false;
} else { console.error('Unexpected action: ' + action); process.exit(95); }
fs.writeFileSync(env.ATLAS_CONTROL_TEST_STATE, JSON.stringify(state));
`;
  for (const tool of ['xcrun', 'xcode-select', 'xcodebuild', 'open']) {
    await writeFile(path.join(bin, tool), fakeTool);
    await chmod(path.join(bin, tool), 0o755);
  }

  for (const family of families) {
    const { key, runtime, bundle } = family;
    const variable = `${key.toUpperCase()}_SIMULATOR_ID`;
    const oldRuntime = `com.apple.CoreSimulator.SimRuntime.${runtime}-18-5`;
    const newRuntime = `com.apple.CoreSimulator.SimRuntime.${runtime}-26-5`;
    const initial = { bundle, devices: {
      [oldRuntime]: [device(family, 'OLDER')],
      [newRuntime]: [device(family, 'LATEST')],
    } };
    for (const other of families.filter(item => item.key !== key)) {
      const runtimeKey = `com.apple.CoreSimulator.SimRuntime.${other.runtime}-26-5`;
      (initial.devices[runtimeKey] ||= []).push({ ...device(other, other.key, 'Booted'), appRunning: true });
    }
    await writeState(initial);
    for (const startArgs of [[], ['start']]) {
      await resetCalls();
      const help = invoke(key, ['--help']);
      assert.equal(help.status, 0, help.stderr);
      for (const action of ['start', 'stop', 'status']) assert.ok(help.stdout.includes(action));
      for (const args of [['restart'], ['stop', '--rebuild'], ['status', '--rebuild'], ['start', 'stop']]) {
        assert.equal(invoke(key, args).status, 2, args.join(' '));
      }
      assert.equal((await readCalls()).length, 0, 'invalid arguments must not call Apple tools');
      let result = invoke(key, ['status']);
      assert.equal(result.status, 3, result.stderr);
      assert.match(result.stdout, /Shutdown/); readOnly(await readCalls());
      const before = await readState();
      await resetCalls(); result = invoke(key, ['stop']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal((await readCalls()).length, 1, 'already stopped must not call shutdown');
      assert.deepEqual(await readState(), before);

      result = invoke(key, startArgs);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(devices(await readState()).find(item => item.udid === 'LATEST').appRunning, true);
      await resetCalls(); result = invoke(key, ['status']);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /LATEST/); assert.match(result.stdout, /PID 4321/);
      readOnly(await readCalls());
      await resetCalls(); result = invoke(key, ['stop']);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual((await readCalls()).map(item => item.args), [
        ['simctl', 'list', 'devices', 'available', '-j'], ['simctl', 'shutdown', 'LATEST'],
      ]);
      assert.deepEqual(await readState(), { ...initial, devices: {
        ...initial.devices, [newRuntime]: initial.devices[newRuntime].map(item =>
          item.udid === 'LATEST' ? { ...item, appRunning: false } : item),
      } }, 'stop must preserve all other devices');
    }

    let state = await readState();
    const older = devices(state).find(item => item.udid === 'OLDER');
    const latest = devices(state).find(item => item.udid === 'LATEST');
    older.state = 'Booted'; older.appRunning = false;
    await writeState(state); await resetCalls();
    let result = invoke(key, ['status']);
    assert.equal(result.status, 3, result.stderr); assert.match(result.stdout, /OLDER/);
    assert.match(result.stdout, /应用：.*未运行/); readOnly(await readCalls());
    assert.deepEqual(await readState(), state, 'status must not launch an installed but stopped app');
    older.state = 'Booting'; await writeState(state); await resetCalls();
    assert.equal(invoke(key, ['status']).status, 3);
    assert.equal((await readCalls()).length, 1, 'status must not wait for boot or inspect processes before boot');
    assert.equal(invoke(key, ['stop']).status, 0, 'stop must work during boot');
    assert.equal(devices(await readState()).find(item => item.udid === 'OLDER').state, 'Shutdown');
    older.state = 'Shutting Down'; await writeState(state); await resetCalls();
    assert.equal(invoke(key, ['status']).status, 3);
    assert.equal(invoke(key, ['stop']).status, 0);
    assert.equal(invoke(key, ['start']).status, 1, 'start must not boot a device that is shutting down');
    assert.ok((await readCalls()).every(item => item.args[1] === 'list'));

    older.state = 'Booted'; older.appRunning = true;
    latest.state = 'Booted'; latest.appRunning = true;
    await writeState(state);
    for (const action of ['status', 'stop']) {
      await resetCalls(); result = invoke(key, [action]);
      assert.equal(result.status, 1, result.stdout);
      assert.ok(result.stderr.includes(variable));
      assert.equal((await readCalls()).length, 1, 'ambiguous devices must not be changed');
      await resetCalls(); result = invoke(key, [action], { [variable]: 'OLDER' });
      assert.equal(result.status, 0, result.stderr);
    }
    assert.equal(devices(await readState()).find(item => item.udid === 'LATEST').state, 'Booted');
    assert.equal(invoke(key, ['status'], { [variable]: 'OLDER' }).status, 3);
    // Explicit status of the remaining running device works without choosing another.
    assert.equal(invoke(key, ['status'], { [variable]: 'LATEST' }).status, 0);
    for (const action of ['stop', 'status']) {
      for (const id of ['MISSING', families.find(item => item.key !== key).key]) {
        await resetCalls(); assert.equal(invoke(key, [action], { [variable]: id }).status, 1);
        assert.equal((await readCalls()).length, 1, 'invalid UDIDs must not fall back to another device');
      }
      await resetCalls();
      result = invoke(key, [action], { ATLAS_CONTROL_TEST_FAIL: action === 'stop' ? 'shutdown' : 'spawn' });
      assert.equal(result.status, 1, 'tool failures must not be reported as stopped or running');
      assert.match(result.stderr, /fixture failure/);
    }

    // Hold a real control lock through shutdown. Status stays usable; competing
    // stop reports busy, and start cannot boot a device midway through shutdown.
    await resetCalls();
    const gate = path.join(temporary, `release-${key}`);
    concurrent = spawn('bash', [path.join(repo, 'scripts', `run-${key}-simulator.sh`), 'stop'], {
      cwd: temporary, env: { ...environment, ATLAS_CONTROL_TEST_GATE: gate }, stdio: 'ignore',
    });
    firstExit = new Promise(resolve => concurrent.once('exit', resolve));
    const deadline = Date.now() + 10000;
    while (!(await readCalls()).some(item => item.args[1] === 'shutdown')) {
      assert.ok(Date.now() < deadline, 'first stop must reach shutdown');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const count = (await readCalls()).length;
    assert.equal(invoke(key, ['stop']).status, 4);
    assert.equal(invoke(key, ['start']).status, 0);
    assert.equal((await readCalls()).length, count, 'competing control must not call Apple tools');
    assert.equal(invoke(key, ['status']).status, 0, 'status remains available while a control task runs');
    await writeFile(gate, 'release');
    assert.equal(await firstExit, 0); concurrent = null;
    assert.equal(invoke(key, ['stop']).status, 0, 'completed shutdown releases the control lock');

    await writeState({ bundle, devices: {} }); await resetCalls();
    assert.equal(invoke(key, ['status']).status, 3);
    assert.equal(invoke(key, ['stop']).status, 0);
    assert.equal(invoke(key, ['start']).status, 1);
    assert.equal(invoke(key, ['stop'], { [variable]: 'MISSING' }).status, 1);
    assert.ok((await readCalls()).every(item => item.args[1] === 'list'));
    assert.ok((await readCalls()).every(item => item.cwd === repo));
    console.log(`${key} controls passed: lifecycle, read-only status, targeted/idempotent stop, selection, failures and concurrency.`);
  }
} finally {
  if (concurrent) { concurrent.kill('SIGTERM'); await firstExit; }
  await rm(temporary, { recursive: true, force: true });
}
