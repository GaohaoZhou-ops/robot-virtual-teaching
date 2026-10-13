import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, access, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const temporary = await mkdtemp(path.join(tmpdir(), 'atlas-clean-build-'));
const sourceScript = fileURLToPath(new URL('../scripts/clean_build.sh', import.meta.url));
async function put(root, name, data = 'fixture') {
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}
async function fixture(name) {
  const root = path.join(temporary, name);
  await put(root, 'package.json', JSON.stringify({ name: 'atlas-route-studio' }));
  await put(root, 'vite.config.js', 'export default { publicDir: "maps" };');
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await copyFile(sourceScript, path.join(root, 'scripts/clean_build.sh'));
  return root;
}
function run(root, ...args) {
  return execFileSync('bash', [path.join(root, 'scripts/clean_build.sh'), ...args], {
    cwd: temporary, encoding: 'utf8', stdio: 'pipe', maxBuffer: 2 * 1024 * 1024,
  });
}
const exists = async (file) => access(file).then(() => true, () => false);
try {
  const root = await fixture('project with spaces');
  const disposable = [
    'dist/assets/app.js', 'dist/xian_map.ply', 'build/compiler.o', 'ipad/build/Build/Products/App.app/Info.plist',
    'vision/build/device/Build/Products/App.app/Info.plist', 'vision/DerivedData/ModuleCache.noindex/cache.pcm',
    'vision/.build/cache.bin', 'vision/screenshots/preview.png', 'tests/test-videos/capture.mp4',
    'tests/test-artifacts/result.log', 'vision/test-artifacts/preview/screenshot.png',
    'vision/atlas-vision-ui-attachments-2/clip.mov', 'atlas-vision-ui-shots/manifest.json',
    'vision/atlas-vision-core-tests', 'tests/atlas-vision-check.log', 'vision/atlas-vision-test.xcresult/Info.plist',
    'vision/Tests/__pycache__/check.pyc',
    '.npm-cache/_cacache/cache-data', '.cache/derived.bin', 'node_modules/.vite/deps/react.js',
    '.atlas-cache/surfaces/hash.atsurface.gz', '.atlas-cache/surfaces/hash.json',
    'tests/__pycache__/smoke.cpython-313.pyc', 'src/cluster/__pycache__/merge.pyc', 'scripts/old.pyc',
    'test-results/test.png', 'ipad/screenshots/test.png', 'atlas-ipad-coverage-shots/manifest.json',
    'ipad/atlas-ipad-coverage-attachments-2/screen.png', 'atlas-ipad-coverage-test',
    'atlas-ipad-coverage.log', 'atlas-ipad-test.xcresult/Info.plist', 'vite.config.js.timestamp-123.mjs',
    '.atlas-route.log',
  ];
  const keep = [
    'maps/xian_map.ply', 'custom-model.ply', 'robots/robot.urdf', '.env.local', 'package-lock.json',
    'node_modules/react/package.json', 'ipad/AtlasTeaching/Info.plist',
    'vision/AtlasVisionTeaching/Info.plist', 'vision/AtlasVisionTeaching.xcodeproj/project.pbxproj',
    'vision/Tests/Fixtures/model.atls', 'vision/AtlasVisionTeaching/Assets.xcassets/icon.png',
    'ipad/AtlasTeaching.xcodeproj/project.pbxproj', 'ipad/AtlasTeaching.xcodeproj/xcuserdata/settings.xcuserstate',
    'ipad/AtlasTeaching/Assets.xcassets/AppIcon.appiconset/icon.png',
    'project.atlas-project/atlas.project.json', 'project.atlas-project/config/project.json',
    'project.atlas-project/teaching-data/task/pose.json', 'project.atlas-project/teaching-data/task/rgb/frame.png',
    'project.atlas-project/environment/positions.f32le', 'original-project.zip', 'config.json',
    'recovered-projects/backup.zip', 'tests/fixtures/fixture.ply', 'ipad/Tests/Fixtures/model.atls',
    '.atlas-cache/ipad-teaching/session/session.json', '.atlas-cache/ipad-teaching/session/model.atls',
    '.atlas-cache/ipad-teaching/session/result.json', '.atlas-cache/unknown-new-state/data.bin',
    '.playwright/.auth/session.json',
  ];
  for (const name of disposable) await put(root, name, name.endsWith('.json') ? '{}' : 'artifact');
  for (const name of keep) await put(root, name, `original:${name}`);
  await copyFile(path.join(root, 'maps/xian_map.ply'), path.join(root, 'dist/xian_map.ply'));
  const originals = await Promise.all(keep.map((name) => readFile(path.join(root, name))));
  const preview = run(root, '--dry-run');
  assert.match(preview, /\[将清理\] "dist"/);
  for (const name of disposable) assert.equal(await exists(path.join(root, name)), true, `dry run changed ${name}`);
  run(root);
  for (const name of disposable) assert.equal(await exists(path.join(root, name)), false, `not cleaned: ${name}`);
  for (const [index, name] of keep.entries()) assert.deepEqual(await readFile(path.join(root, name)), originals[index], `modified ${name}`);
  assert.match(run(root), /已清理 0 项/);
  assert.throws(() => run(root, '--unknown'), (error) => error.status === 2);

  const guarded = await fixture('guarded-project');
  await put(guarded, 'dist/saved/atlas.project.json', '{}');
  await put(guarded, 'dist/saved/environment/original.ply', 'source');
  await put(guarded, '.cache/renamed-config.JSON', '{"schemaVersion":"1.3","map":{},"nodes":[]}');
  await put(guarded, 'ipad/build/saved-pose/pose.json', '{"cameraPose":{}}');
  await put(guarded, 'build/tracked-settings.txt', 'tracked configuration');
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '-q', guarded]);
  execFileSync('git', ['-C', guarded, 'add', '--', 'build/tracked-settings.txt']);
  const protection = run(guarded);
  assert.match(protection, /含 Git 跟踪文件/);
  for (const name of ['dist/saved/atlas.project.json', 'dist/saved/environment/original.ply',
    '.cache/renamed-config.JSON', 'ipad/build/saved-pose/pose.json', 'build/tracked-settings.txt']) {
    assert.equal(await exists(path.join(guarded, name)), true, `lost protected data ${name}`);
  }

  // One native snapshot must not retain all sibling reports/builds/recordings.
  // Complete projects still need their relative image and model resources.
  const mixed = await fixture('mixed-test-artifacts');
  const preserved = {
    'ipad/test-artifacts/run/fixture-after-adjustment.json': JSON.stringify({ result: {
      protocol: 'atlas-ipad-teaching/1', samples: [{ cameraPose: { position: [1, 2, 3] } }],
    } }).replaceAll('/', '\\/'),
    'ipad/test-artifacts/run/empty-native-project.json': '{"protocol":"atlas-ipad-teaching\\/1","samples":[]}',
    'ipad/test-artifacts/run/model.atls': 'original model',
    'vision/test-artifacts/session/real-project.atlas-project/atlas.project.json': '{}',
    'vision/test-artifacts/session/real-project.atlas-project/rgb/frame.png': 'project image',
    'vision/test-artifacts/session/renamed-project/settings.JSON': '{"schemaVersion":"1.3","map":{}}',
    'vision/test-artifacts/session/renamed-project/capture.mp4': 'referenced project resource',
    'vision/test-artifacts/session/pose-session/pose.json': '{"cameraPose":{}}',
    'vision/test-artifacts/session/pose-session/rgb/frame.png': 'pose image',
    'vision/test-artifacts/export.xcappdata/Documents/model.atls': 'device data',
    'vision/test-artifacts/export.xcappdata/Info.plist': 'device metadata',
    'vision/test-artifacts/tracked-note.txt': 'tracked test instructions',
  };
  const outputs = [
    'ipad/test-artifacts/run/device.xcresult/Data/blob', 'ipad/test-artifacts/run/attachments/movie.mp4',
    'ipad/test-artifacts/run/screenshots/frame.png', 'ipad/test-artifacts/run/trace.log',
    'vision/test-artifacts/session/DerivedData/Build/Products/App.app/App',
    'vision/test-artifacts/session/screenshots/preview.png', 'vision/test-artifacts/other-run/recording.mp4',
  ];
  for (const [name, value] of Object.entries(preserved)) await put(mixed, name, value);
  for (const name of outputs) await put(mixed, name);
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '-q', mixed]);
  execFileSync('git', ['-C', mixed, 'add', '--', 'vision/test-artifacts/tracked-note.txt']);
  assert.match(run(mixed, '--dry-run'), /逐项检查/);
  for (const name of outputs) assert.equal(await exists(path.join(mixed, name)), true, `dry run changed ${name}`);
  run(mixed);
  for (const name of outputs) assert.equal(await exists(path.join(mixed, name)), false, `mixed output survived: ${name}`);
  for (const [name, value] of Object.entries(preserved)) assert.equal(await readFile(path.join(mixed, name), 'utf8'), value);
  assert.match(run(mixed), /已清理 0 项/);

  const changedCopy = await fixture('modified-build-map');
  await put(changedCopy, 'maps/cloud.ply', 'source-A');
  await put(changedCopy, 'dist/cloud.ply', 'source-B');
  run(changedCopy);
  assert.equal(await readFile(path.join(changedCopy, 'dist/cloud.ply'), 'utf8'), 'source-B',
    'same name and byte length are insufficient to delete a model');

  const linked = await fixture('symlink-project'), outside = path.join(temporary, 'external');
  await put(outside, 'surfaces/original.txt', 'outside data');
  await symlink(outside, path.join(linked, 'dist'));
  await symlink(outside, path.join(linked, '.atlas-cache'));
  await put(linked, 'build/temporary.o', 'artifact');
  await symlink(outside, path.join(linked, 'build/external-link'));
  run(linked);
  assert.equal(await readFile(path.join(outside, 'surfaces/original.txt'), 'utf8'), 'outside data');
  assert.equal(await exists(path.join(linked, 'dist')), true);
  assert.equal(await exists(path.join(linked, 'build')), false);

  const active = await fixture('active-service');
  await put(active, '.atlas-route.pid', `${process.pid} 21990 0.0.0.0\n`);
  await put(active, '.atlas-route.log', 'live log');
  run(active);
  assert.equal(await readFile(path.join(active, '.atlas-route.log'), 'utf8'), 'live log');
  assert.equal(await readFile(path.join(active, '.atlas-route.pid'), 'utf8'), `${process.pid} 21990 0.0.0.0\n`);

  const wrong = await fixture('other-app');
  await put(wrong, 'package.json', '{"name":"different-project"}');
  await put(wrong, 'dist/keep.txt', 'unrelated');
  assert.throws(() => run(wrong), (error) => error.status === 1);
  assert.equal(await exists(path.join(wrong, 'dist/keep.txt')), true);
  console.log('Clean build: dry-run, scoped cleanup, config/Pose preservation, source fingerprints, tracked files, symlinks, active service and repeat runs passed.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
