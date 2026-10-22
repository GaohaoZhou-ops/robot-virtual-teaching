import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const family = process.argv[2] || 'ipad';
assert.ok(['ipad', 'iphone'].includes(family), 'Usage: node tests/ipad_simulator_launcher_smoke.mjs [ipad|iphone]');
const deviceVariable = `${family.toUpperCase()}_SIMULATOR_ID`;
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), `atlas-${family}-launcher-test-`)));
const repo = path.join(temporary, 'project with spaces');
const bin = path.join(temporary, 'bin');
const calls = path.join(temporary, 'calls.jsonl');
const devicesFile = path.join(temporary, 'devices.json');
const source = fileURLToPath(new URL('../scripts/', import.meta.url));
const entries = [`start_${family}_simulator.command`, `run-${family}-simulator.sh`];
const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  ATLAS_IPAD_TEST_CALLS: calls, ATLAS_IPAD_TEST_DEVICES: devicesFile,
  IPAD_SIMULATOR_ID: 'UNRELATED-IPAD', IPHONE_SIMULATOR_ID: 'UNRELATED-PHONE',
  [deviceVariable]: '', [`${family.toUpperCase()}_ARTIFACTS`]: 'artifacts with spaces', DEVELOPER_DIR: '',
  VISION_SIMULATOR_ID: 'VISION', VISION_ARTIFACTS: 'unused vision artifacts' };
const device = (udid, type, state = 'Shutdown') => ({ udid, name: `Renamed ${udid}`, state,
  isAvailable: true, deviceTypeIdentifier: `com.apple.CoreSimulator.SimDeviceType.${type}` });
const old = device('OLD-PRO', family === 'iphone' ? 'iPhone-15-Pro-Max' : 'iPad-Pro-11-inch-M4-8GB');
const latest = device('NEW-PRO', family === 'iphone' ? 'iPhone-17-Pro-Max' : 'iPad-Pro-13-inch-M5-12GB');
const inventory = { devices: {
  'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [old],
  'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [latest,
    device('OTHER-FAMILY', family === 'iphone' ? 'iPad-Pro-11-inch-M4-8GB' : 'iPhone-17-Pro', 'Booted'),
    device('AIR', 'iPad-Air-13-inch-M4', 'Booted'),
    device('MINI', 'iPad-mini-A17-Pro', 'Booted'),
    { ...latest, udid: 'UNAVAILABLE', state: 'Booted', isAvailable: false }],
  'com.apple.CoreSimulator.SimRuntime.xrOS-26-5': [device('VISION', 'Apple-Vision-Pro', 'Booted')],
} };
const writeDevices = () => writeFile(devicesFile, JSON.stringify(inventory));
const readCalls = async () => (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const resetCalls = () => writeFile(calls, '');
const has = (records, command, action) => records.some(item => item.command === command && (!action || item.args.includes(action)));
const invoke = (args = [], extra = {}, entry = entries[0]) => spawnSync('bash', [path.join(repo, 'scripts', entry), ...args],
  { cwd: temporary, env: { ...env, ...extra }, encoding: 'utf8' });
let concurrent;
let firstExit;
try {
  await mkdir(bin, { recursive: true });
  // Do not inherit the repository's ESM setting when TMPDIR is inside it.
  await writeFile(path.join(bin, 'package.json'), '{"type":"commonjs"}\n');
  for (const file of [...entries, `lib/${family}_simulator.py`, 'lib/apple_simulator.py']) {
    const destination = path.join(repo, 'scripts', file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(source, file), destination); await chmod(destination, 0o755);
  }
  // Mock the Apple commands; exercise the actual shell, Python and process lock.
  const fakeTool = `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path');
const command=path.basename(process.argv[1]), args=process.argv.slice(2), env=process.env;
fs.appendFileSync(env.ATLAS_IPAD_TEST_CALLS, JSON.stringify({command,args,cwd:process.cwd()})+'\\n');
if(command==='xcode-select') console.log('/Applications/Xcode Test.app/Contents/Developer');
if(command==='xcrun') {
  if(args[1]==='list') console.log(fs.readFileSync(env.ATLAS_IPAD_TEST_DEVICES,'utf8'));
  if(args[1]==='get_app_container') process.exit(env.ATLAS_IPAD_TEST_INSTALLED?0:1);
  if(args[1]==='launch') console.log('com.atlasroute.teaching: 1234');
}
if(command==='xcodebuild') {
  if(env.ATLAS_IPAD_TEST_GATE) {
    while(!fs.existsSync(env.ATLAS_IPAD_TEST_GATE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
  }
  const app=path.join(args[args.indexOf('-derivedDataPath')+1],'Build/Products/Debug-iphonesimulator/AtlasTeaching.app');
  fs.mkdirSync(app,{recursive:true});
  fs.writeFileSync(path.join(app,'Info.plist'),'fixture');
  fs.writeFileSync(path.join(app,'AtlasTeaching'),'fixture');
}
`;
  for (const tool of ['xcrun', 'xcodebuild', 'xcode-select', 'open']) {
    await writeFile(path.join(bin, tool), fakeTool); await chmod(path.join(bin, tool), 0o755);
  }
  await writeDevices(); await resetCalls();
  for (const entry of entries) {
    const help = invoke(['--help'], {}, entry);
    assert.equal(help.status, 0, help.stderr); assert.ok(help.stdout.includes(deviceVariable));
    assert.equal(invoke(['--unknown'], {}, entry).status, 2);
  }
  assert.equal((await readCalls()).length, 0);

  let result = invoke(); assert.equal(result.status, 0, result.stderr);
  let records = await readCalls();
  assert.ok(records.every(item => item.cwd === repo));
  assert.ok(records.some(item => item.args.join(' ') === 'simctl bootstatus NEW-PRO -b'));
  const buildArgs = records.find(item => item.command === 'xcodebuild').args;
  assert.ok(buildArgs.includes(path.join(repo, 'ipad/AtlasTeaching.xcodeproj')));
  assert.ok(buildArgs.includes('AtlasTeaching') && buildArgs.includes('platform=iOS Simulator,id=NEW-PRO'));
  assert.ok(buildArgs.includes('ONLY_ACTIVE_ARCH=YES'));
  assert.ok(buildArgs.includes(path.join(repo, 'artifacts with spaces/DerivedData')));
  assert.ok(records.some(item => item.args.join(' ') === 'simctl launch --terminate-running-process NEW-PRO com.atlasroute.teaching'));
  assert.ok(has(records, 'xcrun', 'install'));
  assert.ok(!records.find(item => item.command === 'open').args.includes('-n'));

  const installed = { ATLAS_IPAD_TEST_INSTALLED: '1' };
  // A running older Pro wins over a newer runtime, regardless of renamed devices.
  old.state = 'Booted'; await writeDevices();
  for (const entry of entries) {
    await resetCalls(); result = invoke([], installed, entry); assert.equal(result.status, 0, result.stderr);
    records = await readCalls();
    assert.ok(!has(records, 'xcodebuild') && !has(records, 'xcrun', 'install') && !has(records, 'xcrun', 'bootstatus'));
    assert.ok(records.some(item => item.args.join(' ') === 'simctl launch OLD-PRO com.atlasroute.teaching'));
  }
  for (const id of ['NEW-PRO', 'OTHER-FAMILY', 'AIR', 'MINI', 'VISION', 'UNAVAILABLE']) {
    await resetCalls(); result = invoke([], { ...installed, [deviceVariable]: id });
    assert.equal(result.status, 1, result.stdout); assert.equal((await readCalls()).length, 1);
  }
  latest.state = 'Booted'; await writeDevices(); await resetCalls();
  assert.equal(invoke().status, 1); assert.equal((await readCalls()).length, 1);
  latest.state = 'Shutdown'; old.state = 'Booting'; await writeDevices(); await resetCalls();
  assert.equal(invoke([], installed).status, 0);
  assert.ok((await readCalls()).some(item => item.args.join(' ') === 'simctl bootstatus OLD-PRO -b'));
  old.state = 'Shutdown'; await writeDevices(); await resetCalls();
  assert.equal(invoke([], { ...installed, [deviceVariable]: 'OLD-PRO' }).status, 0);
  assert.ok((await readCalls()).some(item => item.args.join(' ') === 'simctl launch OLD-PRO com.atlasroute.teaching'));
  old.isAvailable = false; latest.isAvailable = false; await writeDevices(); await resetCalls();
  assert.equal(invoke().status, 1); assert.equal((await readCalls()).length, 1);
  old.isAvailable = true; latest.isAvailable = true; await writeDevices();

  await resetCalls();
  const gate = path.join(temporary, 'release-build');
  concurrent = spawn('bash', [path.join(repo, 'scripts', entries[0]), '--rebuild'], {
    cwd: temporary, env: { ...env, ...installed, ATLAS_IPAD_TEST_GATE: gate }, stdio: 'ignore',
  });
  firstExit = new Promise(resolve => concurrent.once('exit', resolve));
  const deadline = Date.now() + 10000;
  while (!has(await readCalls(), 'xcodebuild')) {
    assert.ok(Date.now() < deadline, 'first launcher must reach the build');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const countBefore = (await readCalls()).length;
  result = invoke([], installed, entries[1]);
  assert.equal(result.status, 0); assert.match(result.stdout, /不会重复启动/);
  assert.equal((await readCalls()).length, countBefore, 'concurrent launch must not call Apple tools');
  await writeFile(gate, 'release'); assert.equal(await firstExit, 0); concurrent = null;
  assert.equal(invoke([], installed).status, 0, 'completed launch releases the lock');
  console.log(`${family} launcher passed: device-family selection, singleton concurrency, reuse, first install, explicit rebuild and paths with spaces.`);
} finally {
  if (concurrent) { concurrent.kill('SIGTERM'); await firstExit; }
  await rm(temporary, { recursive: true, force: true });
}
