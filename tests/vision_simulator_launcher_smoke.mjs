import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'atlas-vision-launcher-test-')));
const repo = path.join(temporary, 'project with spaces');
const bin = path.join(temporary, 'bin');
const calls = path.join(temporary, 'calls.jsonl');
const source = fileURLToPath(new URL('../scripts/', import.meta.url));
const environment = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  ATLAS_VISION_TEST_CALLS: calls, VISION_SIMULATOR_ID: '', VISION_ARTIFACTS: 'artifacts with spaces', DEVELOPER_DIR: '' };
const entries = ['start_vision_simulator.command', 'run-vision-simulator.sh'];
function invoke(args = [], extra = {}, entry = entries[0]) {
  return spawnSync('bash', [path.join(repo, 'scripts', entry), ...args], {
    cwd: temporary, env: { ...environment, ...extra }, encoding: 'utf8',
  });
}
const readCalls = async () => (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const resetCalls = () => writeFile(calls, '');
const hasCommand = (records, command, action) => records.some(item => item.command === command && (!action || item.args.includes(action)));
let concurrent;
try {
  await mkdir(bin, { recursive: true });
  // Do not inherit the repository's ESM setting when TMPDIR is inside it.
  await writeFile(path.join(bin, 'package.json'), '{"type":"commonjs"}\n');
  for (const file of [...entries, 'lib/vision_simulator.py', 'lib/apple_simulator.py']) {
    const destination = path.join(repo, 'scripts', file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(source, file), destination);
    await chmod(destination, 0o755);
  }
  // Mock Apple tooling, but exercise real process locking and shell entry points.
  const fakeTool = `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path');
const command=path.basename(process.argv[1]), args=process.argv.slice(2), env=process.env;
fs.appendFileSync(env.ATLAS_VISION_TEST_CALLS, JSON.stringify({command,args,cwd:process.cwd()})+'\\n');
if(command==='xcode-select') console.log('/Applications/Xcode Test.app/Contents/Developer');
if(command==='xcrun') {
  if(args[1]==='list') {
    const mode=env.ATLAS_VISION_TEST_MODE;
    console.log(JSON.stringify({devices:mode==='none'?{}:{
      'com.apple.CoreSimulator.SimRuntime.xrOS-2-5':[{udid:'OLD-VISION',isAvailable:true,state:['older','multiple'].includes(mode)?'Booted':'Shutdown'}],
      'com.apple.CoreSimulator.SimRuntime.xrOS-26-5':[{udid:'NEW-VISION',isAvailable:true,state:mode==='multiple'?'Booted':'Shutdown'}],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5':[{udid:'IPAD',isAvailable:true,state:'Booted'}]
    }}));
  }
  if(args[1]==='get_app_container') process.exit(env.ATLAS_VISION_TEST_INSTALLED?0:1);
  if(args[1]==='launch') console.log('com.atlasroute.teaching.vision: 1234');
}
if(command==='xcodebuild') {
  if(env.ATLAS_VISION_TEST_GATE) {
    while(!fs.existsSync(env.ATLAS_VISION_TEST_GATE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
  }
  if(env.ATLAS_VISION_TEST_FAIL) process.exit(65);
  if(env.ATLAS_VISION_TEST_ASSET_ERROR) {
    console.log('Command CompileAssetCatalog emitted errors but did not return a nonzero exit code'); process.exit(0);
  }
  if(!env.ATLAS_VISION_TEST_NO_PRODUCT) {
    const app=path.join(args[args.indexOf('-derivedDataPath')+1],'Build/Products/Debug-xrsimulator/AtlasVisionTeaching.app');
    fs.mkdirSync(app,{recursive:true});
    fs.writeFileSync(path.join(app,'Info.plist'),'fixture');
    fs.writeFileSync(path.join(app,'AtlasVisionTeaching'),'fixture');
  }
}
`;
  for (const tool of ['xcrun', 'xcodebuild', 'xcode-select', 'open']) {
    await writeFile(path.join(bin, tool), fakeTool); await chmod(path.join(bin, tool), 0o755);
  }
  await resetCalls();
  for (const entry of entries) {
    assert.equal(invoke(['--help'], {}, entry).status, 0);
    assert.equal(invoke(['--unknown'], {}, entry).status, 2);
  }
  assert.equal((await readCalls()).length, 0);

  let result = invoke(); assert.equal(result.status, 0, result.stderr);
  let records = await readCalls();
  assert.ok(records.some(item => item.args.join(' ') === 'simctl bootstatus NEW-VISION -b'));
  assert.ok(hasCommand(records, 'xcodebuild'));
  assert.ok(hasCommand(records, 'xcrun', 'install'));
  assert.ok(records.every(item => item.cwd === repo));
  assert.ok(records.find(item => item.command === 'xcodebuild').args.includes('ONLY_ACTIVE_ARCH=YES'));
  assert.ok(records.find(item => item.command === 'open').args.includes('/Applications/Xcode Test.app/Contents/Developer/Applications/Simulator.app'));
  assert.ok(!records.find(item => item.command === 'open').args.includes('-n'));

  const running = { ATLAS_VISION_TEST_MODE: 'older', ATLAS_VISION_TEST_INSTALLED: '1' };
  for (const entry of entries) {
    await resetCalls();
    result = invoke([], running, entry); assert.equal(result.status, 0, result.stderr);
    records = await readCalls();
    assert.ok(!hasCommand(records, 'xcodebuild') && !hasCommand(records, 'xcrun', 'install'));
    assert.ok(!hasCommand(records, 'xcrun', 'bootstatus'));
    assert.deepEqual(records.find(item => item.command === 'xcrun' && item.args[1] === 'launch').args,
      ['simctl', 'launch', 'OLD-VISION', 'com.atlasroute.teaching.vision']);
  }
  for (const extra of [
    { ...running, VISION_SIMULATOR_ID: 'NEW-VISION' },
    { VISION_SIMULATOR_ID: 'IPAD' }, { ATLAS_VISION_TEST_MODE: 'multiple' }, { ATLAS_VISION_TEST_MODE: 'none' },
  ]) {
    await resetCalls(); result = invoke([], extra); assert.equal(result.status, 1, result.stdout);
    assert.equal((await readCalls()).length, 1, 'invalid selection must not boot, compile or open anything');
  }

  await resetCalls(); result = invoke(['--rebuild'], running); assert.equal(result.status, 0, result.stderr);
  records = await readCalls();
  assert.ok(hasCommand(records, 'xcodebuild') && hasCommand(records, 'xcrun', 'install'));
  assert.ok(records.find(item => item.command === 'xcrun' && item.args[1] === 'launch').args.includes('--terminate-running-process'));
  for (const [extra, status] of [
    [{ ATLAS_VISION_TEST_FAIL: '1' }, 65], [{ ATLAS_VISION_TEST_ASSET_ERROR: '1' }, 1],
    [{ ATLAS_VISION_TEST_NO_PRODUCT: '1', VISION_ARTIFACTS: 'missing products' }, 1],
  ]) {
    await resetCalls(); result = invoke(['--rebuild'], extra); assert.equal(result.status, status, result.stderr);
    assert.ok(!hasCommand(await readCalls(), 'xcrun', 'install'), 'never install an unsuccessful build');
  }
  assert.equal(invoke([], running).status, 0, 'failed builds release the singleton lock');

  await resetCalls();
  const gate = path.join(temporary, 'release-build');
  concurrent = spawn('bash', [path.join(repo, 'scripts', entries[0]), '--rebuild'], {
    cwd: temporary, env: { ...environment, ATLAS_VISION_TEST_GATE: gate }, stdio: 'ignore',
  });
  const firstExit = new Promise(resolve => concurrent.once('exit', resolve));
  const deadline = Date.now() + 10000;
  while (!hasCommand(await readCalls(), 'xcodebuild')) {
    assert.ok(Date.now() < deadline, 'first launcher must reach the build');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const countBefore = (await readCalls()).length;
  result = invoke([], {}, entries[1]);
  assert.equal(result.status, 0); assert.match(result.stdout, /不会重复启动/);
  assert.equal((await readCalls()).length, countBefore, 'the competing launcher must not invoke Apple tools');
  await writeFile(gate, 'release');
  assert.equal(await firstExit, 0); concurrent = null;
  assert.equal(invoke([], running).status, 0, 'the completed launch releases the lock');
  console.log('Vision launcher passed: singleton concurrency, older-device reuse, first install, explicit rebuild, failure recovery, validation and paths with spaces.');
} finally {
  if (concurrent) concurrent.kill('SIGTERM');
  await rm(temporary, { recursive: true, force: true });
}
