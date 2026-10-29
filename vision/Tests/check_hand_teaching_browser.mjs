import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve('vision/build/hand-teaching');
await mkdir(dir, { recursive: true });
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
if (!process.argv.includes('--skip-build')) await run('node', ['vision/scripts/build_workbench.mjs']);
await run('node', ['vision/Tests/hand_teaching_fixture.mjs', path.join(dir, 'project.zip')]);
await run('xcrun', ['swiftc', '-parse-as-library', 'ipad/AtlasTeaching/TeachingModels.swift', 'ipad/AtlasTeaching/LANClient.swift',
  'ipad/AtlasTeaching/ProjectStore.swift', 'ipad/AtlasTeaching/ModelGeometry.swift', 'vision/AtlasVisionTeaching/VisionPoseMath.swift',
  'vision/AtlasVisionTeaching/VisionSceneModels.swift', 'vision/AtlasVisionTeaching/VisionSceneStore.swift',
  'vision/AtlasVisionTeaching/VisionWorkbenchServer.swift', 'vision/Tests/VisionWorkbenchServerHarness.swift', '-o', path.join(dir, 'server')]);
const native = spawn(path.join(dir, 'server'), [path.resolve('vision/AtlasVisionTeaching/WebWorkbench'), dir, path.join(dir, 'project.zip')],
  { stdio: ['ignore', 'pipe', 'inherit'] });
try {
  const connection = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Native server startup timed out (is 21991 in use?)')), 15000);
    native.once('error', error => { clearTimeout(timeout); reject(error); });
    native.once('exit', code => { clearTimeout(timeout); reject(new Error(`Native server exited ${code}`)); });
    native.stdout.on('data', data => {
      output += data;
      if (output.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(output.split('\n')[0])); }
    });
  });
  const file = path.join(dir, 'connection.json'); await writeFile(file, JSON.stringify(connection));
  await run('uv', ['run', '--with', 'playwright', 'python', 'vision/Tests/hand_teaching_browser.py'],
    { env: { ...process.env, VISION_WORKBENCH_CONNECTION: file } });
} finally {
  if (native.exitCode === null) {
    const done = new Promise(resolve => native.once('exit', resolve)); native.kill('SIGTERM'); await done;
  }
}
