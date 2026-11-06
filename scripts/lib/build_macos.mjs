#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseReleaseMinute, formatReleaseMinute, validateRelease } from '../../desktop/release-policy.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ELECTRON_VERSION = '45.2.3';
const HELP = `用法：./scripts/build_mac.sh [选项]

默认交互输入统一失效时间，格式 YYYY-MM-DD HH:mm，固定按北京时间计算。
生成可双击的 AtlasTeaching.app、DMG 和 ZIP，包含内置机器人模型。
输出：build/macos/releases/<版本-构建号-架构-签名类型>/

选项：
  --expires "2026-12-01 14:30"  非交互指定失效时间（仍按北京时间）
  --version 1.1.0                发布版本号，默认 package.json 中的版本
  --arch arm64|x64               默认当前 Mac 的架构
  --signing internal|developer-id 默认 internal（内部测试签名）
  --sample-map /path/map.ply     可选：随包提供 xian_map.ply 示例地图
  --validate-only                只检查参数和时间，不构建
  --help                         显示说明

正式分发环境变量：
  ATLAS_SIGN_IDENTITY  Developer ID Application 证书名称
  ATLAS_NOTARY_PROFILE 已配置的 notarytool 钥匙串配置名称
  ATLAS_ELECTRON_ZIP_DIR 可选：已有官方 Electron ZIP 所在目录

内部测试包不含原始业务源码或 source map，但 ASAR/压缩 JS 不能保证不可逆向。
内部签名未经 Apple 公证；其他 Mac 首次打开可能需要在系统设置中允许。
正式模式缺少证书或公证配置时会失败，不会悄悄降级成内部签名。
`;

function parseArgs(args) {
  const options = { arch: process.arch, signing: 'internal' };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') { options.help = true; continue; }
    if (flag === '--validate-only') { options.validateOnly = true; continue; }
    if (!['--expires', '--version', '--arch', '--signing', '--sample-map'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error(`无效参数：${flag}；使用 --help 查看说明。`);
    }
    options[flag.slice(2)] = args[++i];
  }
  return options;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} 失败（${signal || code}）。`)));
  });
}
const exists = async (file) => access(file).then(() => true, () => false);
const hashFile = (file) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('error', reject).on('data', (data) => hash.update(data)).on('end', () => resolve(hash.digest('hex')));
});

export async function prepareDesktopPayload(stage, release) {
  const [{ build }, { default: react }, esbuild] = await Promise.all([import('vite'), import('@vitejs/plugin-react'), import('esbuild')]);
  await mkdir(stage, { recursive: true });
  console.log('构建三维工作台…');
  const webBuild = await build({ root, configFile: false, publicDir: false, plugins: [react(), {
    name: 'desktop-no-source-exports', enforce: 'pre',
    load(id) { if (id.includes('/src/cluster/') && id.endsWith('?raw')) return 'export default "";'; },
  }], define: { __ATLAS_DESKTOP__: 'true' },
  build: { outDir: path.join(stage, 'web'), emptyOutDir: true, sourcemap: false, minify: true, reportCompressedSize: false } });
  console.log('编译桌面服务和启动程序…');
  const mainBuild = await buildDesktopMain(stage, release);
  await esbuild.build({ absWorkingDir: root, entryPoints: ['desktop/preload.cjs'], outfile: path.join(stage, 'preload.cjs'),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], minify: true, sourcemap: false });
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'atlas-teaching-desktop',
    productName: 'Atlas 虚拟示教', version: release.version, main: 'main.cjs', private: true }));
  await writeFile(path.join(stage, 'release.json'), JSON.stringify(release, null, 2));
  const robotRoot = path.join(root, 'robots');
  if (!await exists(robotRoot)) throw new Error('缺少 robots/；请先准备要随软件分发的机器人模型。');
  await cp(robotRoot, path.join(stage, 'robots'), { recursive: true, dereference: true, filter: async (file) => {
    if (path.basename(file).startsWith('.')) return false;
    if ((await stat(file)).isDirectory()) return true;
    return /\.(?:urdf|stl|glb|gltf|bin|png|jpe?g|webp|mtl|obj|dae|xml|json|yaml|yml|sha256)$/i.test(file);
  } });
  // Keep third-party license notices even when omitting development sources.
  const notices = ['Atlas 虚拟示教 — 第三方许可声明\n'];
  const modules = [...Object.keys(mainBuild.metafile.inputs),
    ...[webBuild].flat().flatMap(result => result.output.flatMap(chunk => Object.keys(chunk.modules || {})))];
  const packages = new Set();
  for (const id of modules) {
    const parts = id.replace(/^\0/, '').split('/'), index = parts.lastIndexOf('node_modules');
    if (index >= 0) packages.add(path.resolve(root, parts.slice(0, index + (parts[index + 1].startsWith('@') ? 3 : 2)).join('/')));
  }
  for (const folder of [...packages].sort()) {
    const metadata = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8'));
    for (const file of await readdir(folder)) if (/^licen[cs]e(?:\.|$)/i.test(file) && (await stat(path.join(folder, file))).isFile()) {
      notices.push(`\n--- ${metadata.name} ${metadata.version} ---\n${await readFile(path.join(folder, file), 'utf8')}`);
    }
  }
  notices.push(await readFile(path.join(root, 'src/features/robot-twin/assets/pedestrian/LICENSE.txt'), 'utf8'));
  await writeFile(path.join(stage, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'));
  await auditPayload(stage);
}

export async function buildDesktopMain(stage, release) {
  const esbuild = await import('esbuild');
  return esbuild.build({ absWorkingDir: root, entryPoints: ['desktop/main.mjs'], outfile: path.join(stage, 'main.cjs'), metafile: true,
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'],
    minify: true, sourcemap: false, legalComments: 'external', define: { __ATLAS_RELEASE__: JSON.stringify(validateRelease(release)) },
    plugins: [{ name: 'no-helper-source-download', setup(build) {
      build.onLoad({ filter: /ipadUSBBridgePackage\.js$/ }, () => ({ contents:
        'export async function ipadUSBBridgePackage() { throw Object.assign(new Error("桌面版不提供源码助手下载，请使用设备的网络连接。"), { status: 403 }); }', loader: 'js' }));
    } }] });
}

export async function auditPayload(stage) {
  const walk = async (directory) => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name), relative = path.relative(stage, file);
      if (item.isSymbolicLink()) throw new Error(`分发内容含符号链接：${relative}`);
      if (['src', 'scripts', 'tests', 'node_modules', '.git'].includes(item.name)
        || /\.(?:map|jsx|tsx|ts|mjs|py|sh|swift)$/.test(item.name)) throw new Error(`分发内容中出现开发文件：${relative}`);
      if (item.isDirectory()) await walk(file);
      else if (/\.(?:js|cjs|html)$/.test(item.name)) {
        const value = await readFile(file, 'utf8');
        if (/sourceMappingURL|#!\/usr\/bin\/env python|class Parking|def compute_parking/.test(value)) throw new Error(`分发文件包含源码映射或计算源码：${relative}`);
      }
    }
  };
  await walk(stage);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  if (!['arm64', 'x64'].includes(options.arch)) throw new Error('架构必须为 arm64 或 x64。');
  if (!['internal', 'developer-id'].includes(options.signing)) throw new Error('签名方式必须为 internal 或 developer-id。');
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  let expiresAt;
  if (options.expires) expiresAt = parseReleaseMinute(options.expires);
  else {
    if (!process.stdin.isTTY) throw new Error('需要交互终端输入到期时间；自动化调用请传入 --expires "YYYY-MM-DD HH:mm"。');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('\nAtlas Mac 发版 · 所有收件人使用同一个截止时间');
      while (!expiresAt) {
        const input = await prompt.question('请输入失效时间（北京时间，YYYY-MM-DD HH:mm）：');
        try { expiresAt = parseReleaseMinute(input); } catch (error) { console.log(error.message); }
      }
    } finally { prompt.close(); }
  }
  const builtAt = new Date().toISOString();
  const release = validateRelease({ version: options.version || packageJson.version,
    buildId: builtAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'), builtAt, expiresAt, timeZone: 'Asia/Shanghai', warnBeforeDays: 7 });
  console.log(`\n版本 ${release.version} · ${options.arch}\n统一失效时间：${formatReleaseMinute(expiresAt)}（北京时间）\n签名方式：${options.signing}\n`);
  if (options.validateOnly) return;
  if (process.platform !== 'darwin') throw new Error('Mac 安装包请在 macOS 上构建。');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('打包需要 Node.js 22.12 或更新版本。');
  if (options.signing === 'developer-id' && (!process.env.ATLAS_SIGN_IDENTITY?.startsWith('Developer ID Application:') || !process.env.ATLAS_NOTARY_PROFILE)) {
    throw new Error('正式分发需设置 ATLAS_SIGN_IDENTITY 和 ATLAS_NOTARY_PROFILE；详见 docs/macos-distribution.md。');
  }
  if (!await exists(path.join(root, 'node_modules/@electron/packager/package.json'))) {
    console.log('安装锁文件中的打包依赖…');
    await run('npm', ['ci', '--cache', path.join(root, 'build/macos/npm-cache'), '--no-audit', '--no-fund']);
  }
  const workRoot = path.join(root, 'build/macos');
  await mkdir(workRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(workRoot, '.work-'));
  const stage = path.join(temporary, 'payload');
  const label = `AtlasTeaching-${release.version}-${release.buildId}-${options.arch}-${options.signing}`;
  const output = path.join(workRoot, 'releases', label);
  // Never overwrite an earlier release, even if two invocations share a second.
  if (await exists(output)) throw new Error(`输出目录已存在：${output}`);
  await mkdir(output, { recursive: true });
  try {
    await prepareDesktopPayload(stage, release);
    if (options['sample-map']) await cp(path.resolve(options['sample-map']), path.join(stage, 'web/xian_map.ply'));
    const [{ packager }, { flipFuses, FuseVersion, FuseV1Options }] = await Promise.all([import('@electron/packager'), import('@electron/fuses')]);
    console.log('封装 Mac 应用（首次会下载 Electron 运行时）…');
    const packaged = await packager({ dir: stage, name: 'AtlasTeaching', platform: 'darwin', arch: options.arch,
      electronVersion: ELECTRON_VERSION, appVersion: release.version, appBundleId: 'com.atlasroute.desktop',
      appCategoryType: 'public.app-category.developer-tools', asar: true, prune: false,
      out: path.join(temporary, 'packaged'), overwrite: false,
      ...(process.env.ATLAS_ELECTRON_ZIP_DIR ? { electronZipDir: path.resolve(process.env.ATLAS_ELECTRON_ZIP_DIR) } : {}),
      ...(await exists(path.join(root, 'desktop/assets/Atlas.icns')) ? { icon: path.join(root, 'desktop/assets/Atlas.icns') } : {}),
      extendInfo: { CFBundleDisplayName: 'Atlas 虚拟示教', NSLocalNetworkUsageDescription: '连接局域网内的机器人和已配对的示教设备。',
        NSBonjourServices: ['_atlas-teach._tcp'], NSHighResolutionCapable: true },
    });
    const application = path.join(output, 'AtlasTeaching.app');
    await cp(path.join(packaged[0], 'AtlasTeaching.app'), application, { recursive: true, verbatimSymlinks: true });
    await flipFuses(application, { version: FuseVersion.V1, [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true, [FuseV1Options.OnlyLoadAppFromAsar]: true });
    if (options.signing === 'developer-id') {
      const { sign } = await import('@electron/osx-sign');
      console.log('签名并提交 Apple 公证…');
      await sign({ app: application, identity: process.env.ATLAS_SIGN_IDENTITY, platform: 'darwin',
        optionsForFile: () => ({ hardenedRuntime: true, entitlements: path.join(root, 'desktop/entitlements.plist') }) });
      const { notarize } = await import('@electron/notarize');
      await notarize({ appPath: application, keychainProfile: process.env.ATLAS_NOTARY_PROFILE });
    } else {
      await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', application]);
    }
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
    const { listPackage } = await import('@electron/asar');
    const members = listPackage(path.join(application, 'Contents/Resources/app.asar'));
    if (members.some((file) => /\/(?:src|scripts|node_modules|tests)\/|\.(?:map|py|jsx|tsx|swift)$/.test(file))) throw new Error('应用归档包含不应分发的开发文件。');
    console.log('生成 ZIP 和 DMG…');
    const zip = path.join(output, `${label}.zip`), dmg = path.join(output, `${label}.dmg`);
    await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', application, zip]);
    const diskRoot = path.join(temporary, 'disk');
    await mkdir(diskRoot);
    await cp(application, path.join(diskRoot, 'AtlasTeaching.app'), { recursive: true, verbatimSymlinks: true });
    await symlink('/Applications', path.join(diskRoot, 'Applications'));
    await run('/usr/bin/hdiutil', ['create', '-quiet', '-volname', 'Atlas 虚拟示教', '-srcfolder', diskRoot, '-format', 'UDZO', dmg]);
    if (options.signing === 'developer-id') {
      await run('/usr/bin/codesign', ['--sign', process.env.ATLAS_SIGN_IDENTITY, '--timestamp', dmg]);
    }
    const artifacts = [];
    for (const file of [zip, dmg]) artifacts.push({ file: path.basename(file), bytes: (await stat(file)).size, sha256: await hashFile(file) });
    await writeFile(path.join(output, 'release.json'), JSON.stringify({ ...release, arch: options.arch, electron: ELECTRON_VERSION, signing: options.signing, artifacts }, null, 2));
    await writeFile(path.join(output, 'SHA256SUMS.txt'), artifacts.map((a) => `${a.sha256}  ${a.file}\n`).join(''));
    await writeFile(path.join(output, '使用说明.txt'), `Atlas 虚拟示教 ${release.version}\n有效期至 ${formatReleaseMinute(expiresAt)}（北京时间）。\n\n打开 DMG，将 AtlasTeaching.app 拖入 Applications，再双击打开；也可以解压 ZIP 后打开应用。\n无需安装 Node.js、npm、Python 或构建工程。\n${options.signing === 'internal' ? '\n本包为内部测试签名，未经 Apple 公证。若系统拦截，请在系统设置 → 隐私与安全性中允许打开，或向发布者索取正式签名包。\n' : ''}\n到期后可导出当前工程或已完成编辑的模型备份。替换新版应用会保留本机缓存。\nUSB 画面协作已内置；USB 文件传输仍需 Xcode 的 devicectl，可改用网络传输。\n桌面版不提供包含 Python 源码的集群计算包和 Windows USB 助手下载。\n`);
    if (Date.now() >= Date.parse(expiresAt)) throw new Error('构建完成时已超过失效时间，请设置更晚的时间重新打包。');
    console.log(`\n打包完成：${output}\n有效期：${formatReleaseMinute(expiresAt)}（北京时间）`);
    for (const a of artifacts) console.log(`${a.file}  ${(a.bytes / 1e6).toFixed(1)} MB`);
    console.log(options.signing === 'internal' ? '这是内部测试包；其他 Mac 首次打开可能需要系统允许。' : 'Developer ID 签名和 Apple 公证已完成。');
  } catch (error) {
    await writeFile(path.join(output, 'BUILD_FAILED.txt'), `此目录不是可分发版本。\n${error.message}\n`);
    throw error;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`\n打包失败：${error.message}`); process.exitCode = 1; });
}
