import assert from 'node:assert/strict';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'atlas-clean-build-scripts-')));
const repo = path.join(temporary, 'project with spaces');
const bin = path.join(temporary, 'bin');
const calls = path.join(temporary, 'calls.jsonl');
const source = fileURLToPath(new URL('../scripts/', import.meta.url));
const exists = (file) => access(file).then(() => true, () => false);
async function put(file, value) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); }
const environment = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ATLAS_BUILD_TEST_CALLS: calls };
function run(script, args = [], extra = {}) {
  return spawnSync('bash', [path.join(repo, 'scripts', script), ...args], {
    cwd: temporary, env: { ...environment, ...extra }, encoding: 'utf8',
  });
}
async function readCalls() {
  return (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
}
try {
  for (const name of ['build_local.sh', 'build_vision.sh', 'build_ipad.sh', 'lib/build_apple.sh']) {
    const target = path.join(repo, 'scripts', name);
    await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(source, name), target);
  }
  // Fake only external build tools; exercise real shell parsing, failure
  // propagation, path quoting, dependency installation and artifact checks.
  const fakeTool = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const command = path.basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(process.env.ATLAS_BUILD_TEST_CALLS, JSON.stringify({command,args,cwd:process.cwd()})+'\\n');
const put=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);};
if (command === 'xcrun') process.exit(process.env.ATLAS_BUILD_TEST_NO_SDK ? 1 : 0);
if (command === 'xcodebuild') {
  if (args[0] === '-version') { console.log('Xcode test fixture'); process.exit(0); }
  if (process.env.ATLAS_BUILD_TEST_FAIL) process.exit(65);
  if (process.env.ATLAS_BUILD_TEST_ASSET_ERROR) {
    console.log('Command CompileAssetCatalog emitted errors but did not return a nonzero exit code'); process.exit(0);
  }
  const arg=(key)=>args[args.indexOf(key)+1], scheme=arg('-scheme');
  if (!process.env.ATLAS_BUILD_TEST_NO_PRODUCT) {
    const app=path.join(arg('-derivedDataPath'),'Build/Products',arg('-configuration')+'-'+arg('-sdk'),scheme+'.app');
    put(path.join(app,'Info.plist'),'fixture'); put(path.join(app,scheme),'fixture');
  }
} else if (command === 'npm') {
  if (process.env.ATLAS_BUILD_TEST_FAIL) { console.log('dependency/build failure'); process.exit(7); }
  if (args[0] === 'ci') { put('node_modules/.bin/vite','fixture'); fs.chmodSync('node_modules/.bin/vite',0o755); }
  if (args[0] === 'run' && args[1] === 'build' && !process.env.ATLAS_BUILD_TEST_NO_PRODUCT) put('dist/index.html','compiled');
}
console.log(command+' fixture succeeded');
`;
  for (const command of ['npm', 'xcodebuild', 'xcrun']) {
    await put(path.join(bin, command), fakeTool); await chmod(path.join(bin, command), 0o755);
  }
  for (const script of ['build_local.sh', 'build_vision.sh', 'build_ipad.sh']) {
    assert.equal(run(script, ['--help']).status, 0);
    assert.equal(run(script, ['--unknown']).status, 2);
  }
  assert.equal(await exists(calls), false, 'help/invalid arguments must not invoke build tools');
  for (const target of ['vision', 'ipad']) {
    const script = `build_${target}.sh`;
    assert.equal(run(script, ['--configuration']).status, 2);
    assert.equal(run(script, ['--configuration', 'Fast']).status, 2);
    let result = run(script); assert.equal(result.status, 0, result.stderr);
    let build = (await readCalls()).filter(c => c.command === 'xcodebuild' && c.args[0] !== '-version').at(-1);
    const scheme = target === 'vision' ? 'AtlasVisionTeaching' : 'AtlasTeaching';
    const sdk = target === 'vision' ? 'xros' : 'iphoneos';
    assert.ok(build.args.includes(path.join(repo, target, `${scheme}.xcodeproj`)));
    assert.ok(build.args.includes('generic/platform=' + (target === 'vision' ? 'visionOS' : 'iOS')));
    assert.ok(build.args.includes('CODE_SIGNING_ALLOWED=NO'));
    assert.ok(await exists(path.join(repo, target, `build/device/Build/Products/Release-${sdk}/${scheme}.app/Info.plist`)));
    result = run(script, ['--simulator', '--configuration', 'Debug']);
    assert.equal(result.status, 0, result.stderr);
    build = (await readCalls()).filter(c => c.command === 'xcodebuild' && c.args[0] !== '-version').at(-1);
    assert.ok(build.args.includes(target === 'vision' ? 'xrsimulator' : 'iphonesimulator'));
    assert.ok(build.args.includes('generic/platform=' + (target === 'vision' ? 'visionOS Simulator' : 'iOS Simulator')));
    assert.equal(run(script, [], { ATLAS_BUILD_TEST_FAIL: '1' }).status, 65, 'propagate xcodebuild failure');
    assert.equal(run(script, [], { ATLAS_BUILD_TEST_ASSET_ERROR: '1' }).status, 1, 'reject false-success asset build');
    assert.equal(run(script, [], { ATLAS_BUILD_TEST_NO_SDK: '1' }).status, 1);
    await rm(path.join(repo, target, 'build'), { recursive: true, force: true });
    assert.equal(run(script, [], { ATLAS_BUILD_TEST_NO_PRODUCT: '1' }).status, 1);
  }
  await writeFile(calls, '');
  let result = run('build_local.sh'); assert.equal(result.status, 0, result.stderr);
  let npmCalls = (await readCalls()).filter(c => c.command === 'npm');
  assert.deepEqual(npmCalls.map(c => c.args), [['ci'], ['run', 'build']]);
  assert.ok(npmCalls.every(c => c.cwd === repo), 'resolve repository independently of invocation directory');
  assert.ok(await exists(path.join(repo, 'dist/index.html')));
  await writeFile(calls, '');
  assert.equal(run('build_local.sh').status, 0);
  assert.deepEqual((await readCalls()).filter(c => c.command === 'npm').map(c => c.args), [['run', 'build']]);
  await writeFile(calls, '');
  assert.equal(run('build_local.sh', ['--install']).status, 0);
  assert.deepEqual((await readCalls()).filter(c => c.command === 'npm').map(c => c.args), [['ci'], ['run', 'build']]);
  assert.equal(run('build_local.sh', [], { ATLAS_BUILD_TEST_FAIL: '1' }).status, 7, 'pipefail must preserve npm errors');
  await writeFile(calls, '');
  assert.equal(run('build_local.sh', ['--install'], { ATLAS_BUILD_TEST_FAIL: '1' }).status, 7);
  assert.deepEqual((await readCalls()).filter(c => c.command === 'npm').map(c => c.args), [['ci']], 'stop after failed installation');
  await rm(path.join(repo, 'dist'), { recursive: true, force: true });
  assert.equal(run('build_local.sh', [], { ATLAS_BUILD_TEST_NO_PRODUCT: '1' }).status, 1);
  console.log('Build scripts: external working directory, paths with spaces, device/simulator artifacts, dependency installation and build failures passed.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
